import { ApiClient } from '../api'
import { CliError, inputError, notFound } from '../errors'
import { jsonValueKind, normalizeJsonApiCollection, ResourceResult, UnreadableResourceFields } from '../jsonapi'
import { isRecord } from '../json'
import type { ListCapabilities } from '../list-capabilities'
import { listSearchParams } from '../query'
import { requestTimeout } from './command-options'
import type { ExpectedJsonApiResource } from './resource-responses'

// These ceilings protect an accidentally unbounded --all invocation. They are
// not user-visible pagination bounds: reaching one before exhaustion fails
// closed unless the caller explicitly opted into truncation with --max-*.
const allSafetyMaxPages = 100
const allSafetyMaxItems = 10000

// The --all aggregation and the collection-backed singular lookup must both
// fail closed on a link cycle and on a repeated page. Their diagnostics differ
// - an incomplete list and an inconclusive lookup are different failures - but
// the bookkeeping behind those decisions is one policy and lives here so a fix
// to one scan cannot miss the other.
class PageScan {
  private readonly visitedLinks = new Set<string>()
  private readonly seenPageSignatures = new Map<string, number>()

  visit (url: string): void {
    this.visitedLinks.add(url)
  }

  visited (url: string): boolean {
    return this.visitedLinks.has(url)
  }

  // Returns the label of the page a repeated result set was first seen on, and
  // records the page otherwise. Empty intermediate pages never form a
  // signature: they do not prove exhaustion and legitimately recur.
  repeatedPage (rows: unknown[], label: number): number | undefined {
    if (rows.length === 0) return undefined
    const signature = JSON.stringify(rows)
    const firstSeen = this.seenPageSignatures.get(signature)
    if (firstSeen === undefined) this.seenPageSignatures.set(signature, label)
    return firstSeen
  }
}
// --all keeps only the final page's normalized metadata, so the per-page
// degradation report has to be accumulated separately: dropping it would let a
// field normalization refused to represent on an earlier page read as absent
// backend state, which is exactly what the report exists to prevent. Entries
// are merged by resource identity, and a resource an explicit --max-items bound
// cut from the result is not reported: it is not in `data` to be misread.
function mergeUnreadableFields (
  accumulated: Map<string, UnreadableResourceFields>,
  reported: unknown,
  retained: unknown[]
): void {
  if (!Array.isArray(reported) || reported.length === 0) return
  const retainedKeys = new Set(retained.flatMap(resource => isRecord(resource) &&
    typeof resource.type === 'string' &&
    typeof resource.id === 'string'
    ? [JSON.stringify([resource.type, resource.id])]
    : []))
  for (const candidate of reported) {
    if (!isRecord(candidate) || typeof candidate.type !== 'string' || typeof candidate.id !== 'string') continue
    if (!Array.isArray(candidate.fields)) continue
    const key = JSON.stringify([candidate.type, candidate.id])
    if (!retainedKeys.has(key)) continue
    const entry = accumulated.get(key) ?? { type: candidate.type, id: candidate.id, fields: [] }
    for (const field of candidate.fields) {
      if (typeof field === 'string' && !entry.fields.includes(field)) entry.fields.push(field)
    }
    accumulated.set(key, entry)
  }
}

export function asStrings (value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) return [String(value)]
  return value.map(String)
}

function assertListCapabilities (args: Record<string, unknown>, capabilities: ListCapabilities): void {
  if (!capabilities.filter && args.filter !== undefined) throw inputError('This endpoint does not support --filter.')
  if (!capabilities.sort && args.sort !== undefined) throw inputError('This endpoint does not support --sort.')
  if (!capabilities.pagination) {
    const supplied = ['page', 'pageSize', 'all', 'maxPages', 'maxItems'].filter(name => args[name] !== undefined)
    if (supplied.length > 0) {
      throw inputError('This endpoint does not support pagination options.', {
        unsupported_options: supplied.map(name => `--${name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`)
      })
    }
  }
}

interface NextPageLink {
  present: boolean
  href?: string
}

function nextPageLink (body: unknown): NextPageLink {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return { present: false }
  if (!Object.prototype.hasOwnProperty.call(body, 'links')) return { present: false }
  const links = (body as { links?: unknown }).links
  if (links === null || typeof links !== 'object' || Array.isArray(links)) {
    throw new CliError('INVALID_API_RESPONSE', 'The Poki API returned an invalid JSON:API links member.', 5, {
      details: {
        expected: { links_kind: 'object' },
        received: { links_kind: jsonValueKind(links) }
      }
    })
  }
  if (!Object.prototype.hasOwnProperty.call(links, 'next')) return { present: false }

  const next = (links as { next?: unknown }).next
  if (next === null) return { present: true }
  if (typeof next === 'string') return { present: true, href: next }
  if (isRecord(next) && Object.prototype.hasOwnProperty.call(next, 'href') && typeof next.href === 'string') {
    return { present: true, href: (next as { href: string }).href }
  }
  throw new CliError('INVALID_API_RESPONSE', 'The Poki API returned an invalid JSON:API next-page link.', 5, {
    details: {
      expected: { next_kinds: ['string', 'object_with_string_href', 'null'] },
      received: {
        next_kind: jsonValueKind(next),
        ...(isRecord(next)
          ? {
              href_member: Object.prototype.hasOwnProperty.call(next, 'href') ? 'present' : 'missing',
              ...(Object.prototype.hasOwnProperty.call(next, 'href')
                ? { href_kind: jsonValueKind((next as { href?: unknown }).href) }
                : {})
            }
          : {})
      }
    }
  })
}

function resolvedNextPageLink (api: ApiClient, body: unknown, currentUrl: URL): NextPageLink {
  const next = nextPageLink(body)
  if (next.href === undefined) return next

  let url: URL
  try {
    url = new URL(next.href, currentUrl)
  } catch {
    throw new CliError('INVALID_API_RESPONSE', 'The Poki API returned an invalid JSON:API next-page URL.', 5, {
      details: {
        expected: { next_url: 'same_origin_http_or_https_url' },
        received: { next_url_kind: 'invalid_url' }
      }
    })
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new CliError('INVALID_API_RESPONSE', 'The Poki API returned an unsupported JSON:API next-page URL.', 5, {
      details: {
        expected: { next_url: 'same_origin_http_or_https_url' },
        received: { next_url_kind: 'unsupported_protocol' }
      }
    })
  }
  if (!api.isApiOrigin(url)) {
    throw new CliError('INVALID_API_RESPONSE', 'The Poki API returned a JSON:API next-page URL for another origin.', 5, {
      details: {
        expected: { next_url: 'same_origin_http_or_https_url' },
        received: { next_url_kind: 'different_origin' }
      }
    })
  }
  return { present: true, href: url.toString() }
}
export async function listResources (
  api: ApiClient,
  path: string,
  args: Record<string, unknown>,
  capabilities: ListCapabilities,
  extraFilters: Array<[string, string]> = [],
  directParams: Array<[string, string]> = [],
  // The collection-backed singular lookup needs the untouched page a resource
  // was found on to answer --raw; aggregated normalized data cannot supply it.
  // Returning true means that lookup is complete, so stop before validating or
  // following a continuation the caller no longer needs.
  onPage?: (body: unknown, resources: unknown[]) => boolean
): Promise<unknown> {
  assertListCapabilities(args, capabilities)
  if (!capabilities.pagination) {
    const query = listSearchParams({
      filter: capabilities.filter ? asStrings(args.filter) : undefined,
      sort: capabilities.sort ? asStrings(args.sort) : undefined
    }, extraFilters)
    for (const [name, value] of directParams) query.append(name, value)
    const response = await api.request({ path, query, timeoutMs: requestTimeout(args) })
    return args.raw === true ? response.body : normalizeJsonApiCollection(response.body)
  }

  const pageSize = args.pageSize === undefined ? 30 : Number(args.pageSize)
  let page = args.all === true ? 1 : args.page === undefined ? 1 : Number(args.page)
  const resources: unknown[] = []
  let lastMeta: Record<string, unknown> = {}
  let linkedRequest: string | undefined
  const scan = new PageScan()
  const explicitMaxPages = args.maxPages !== undefined
  const explicitMaxItems = args.maxItems !== undefined
  const maxPages = explicitMaxPages ? Number(args.maxPages) : allSafetyMaxPages
  const maxItems = explicitMaxItems ? Number(args.maxItems) : allSafetyMaxItems
  let pagesFetched = 0
  let truncated = false
  let nextLink: string | undefined
  let lastNext: NextPageLink = { present: false }
  let lastPageLength = 0
  const unreadable = new Map<string, UnreadableResourceFields>()

  do {
    const requestWasLinked = linkedRequest !== undefined
    let query: URLSearchParams | undefined
    if (!requestWasLinked) {
      query = listSearchParams({
        filter: capabilities.filter ? asStrings(args.filter) : undefined,
        sort: capabilities.sort ? asStrings(args.sort) : undefined,
        page,
        pageSize
      }, extraFilters)
      for (const [name, value] of directParams) query.append(name, value)
    }
    const response = await api.request({ path: linkedRequest ?? path, query, timeoutMs: requestTimeout(args) })
    pagesFetched++
    if (args.raw === true) return response.body

    const normalized = normalizeJsonApiCollection(response.body, page, pageSize)
    const pageData = normalized.data === null ? [] : normalized.data as unknown[]
    if (onPage?.(response.body, pageData) === true) return normalized
    const currentUrl = api.resolveApiUrl(linkedRequest ?? path, query)
    // Validate and resolve an authoritative continuation before it can be
    // followed or reflected in normalized pagination metadata.
    const next = resolvedNextPageLink(api, response.body, currentUrl)
    lastNext = next
    if (args.all === true && next.present && next.href !== undefined) {
      scan.visit(currentUrl.toString())
      if (next.href === currentUrl.toString() || scan.visited(next.href)) {
        throw new CliError('INVALID_API_RESPONSE', 'The Poki API returned a cyclic JSON:API next-page link.', 5, {
          details: {
            cycle: next.href === currentUrl.toString() ? 'self' : 'previously_visited',
            pages_fetched: pagesFetched
          }
        })
      }
      scan.visit(next.href)
    }
    nextLink = next.href
    const firstSeenPage = args.all === true ? scan.repeatedPage(pageData, page) : undefined
    if (firstSeenPage !== undefined) {
      throw new CliError('INVALID_API_RESPONSE', 'The Poki API repeated a result page while fetching --all; completeness cannot be established.', 5, {
        details: { page, page_size: pageSize, pages_fetched: pagesFetched, first_seen_page: firstSeenPage, pagination: requestWasLinked ? 'link' : 'numeric' },
        retryable: false,
        hint: 'Retry a bounded single page or report that this endpoint may be repeating pagination results.'
      })
    }
    const remaining = maxItems - resources.length
    const retained = args.all === true ? pageData.slice(0, remaining) : pageData
    resources.push(...retained)
    mergeUnreadableFields(unreadable, normalized.meta.unreadable_fields, retained)
    lastMeta = normalized.meta
    lastPageLength = pageData.length

    if (args.all === true && resources.length >= maxItems) {
      const stoppedInsidePage = pageData.length > remaining
      const hasMore = stoppedInsidePage || (next.present ? next.href !== undefined : pageData.length >= pageSize)
      // A server next link resumes after the complete current page. It is not
      // a safe continuation cursor when --max-items stopped inside that page.
      if (stoppedInsidePage) nextLink = undefined
      if (hasMore && !explicitMaxItems) {
        throw new CliError('INVALID_API_RESPONSE', `Fetching --all reached the internal ${String(allSafetyMaxItems)}-resource safety ceiling before exhaustion; completeness cannot be established.`, 5, {
          details: {
            safety_ceiling: { max_items: allSafetyMaxItems },
            fetched: resources.length,
            pages_fetched: pagesFetched
          },
          retryable: false,
          hint: 'Supply an explicit --max-items or --max-pages only when a bounded, possibly incomplete result is acceptable.'
        })
      }
      truncated = hasMore
      break
    }

    if (args.all !== true) break

    if (next.present) {
      if (next.href === undefined) break
      linkedRequest = next.href
    } else if (requestWasLinked || pageData.length < pageSize) {
      break
    }

    if (pagesFetched >= maxPages) {
      if (!explicitMaxPages) {
        throw new CliError('INVALID_API_RESPONSE', `Fetching --all reached the internal ${String(allSafetyMaxPages)}-page safety ceiling before exhaustion; completeness cannot be established.`, 5, {
          details: {
            safety_ceiling: { max_pages: allSafetyMaxPages },
            fetched: resources.length,
            pages_fetched: pagesFetched,
            ...(explicitMaxItems ? { bounds: { max_items: maxItems } } : {})
          },
          retryable: false,
          // An explicit --max-items is an accepted bound but cannot lift the
          // internal page ceiling, so telling that caller to supply --max-items
          // would repeat what they already did.
          hint: explicitMaxItems
            ? `The internal ${String(allSafetyMaxPages)}-page ceiling stopped this scan before --max-items was reached; no link cycle was detected. Lower --max-items or add an explicit --max-pages when a bounded, possibly incomplete result is acceptable.`
            : 'Supply an explicit --max-pages or --max-items only when a bounded, possibly incomplete result is acceptable.'
        })
      }
      truncated = true
      break
    }
    page++
  } while (true)

  // Endpoints report per-page totals inconsistently, so an aggregated --all
  // response drops the server total; fetched is the count actually collected.
  const aggregatedMeta = { ...lastMeta }
  delete aggregatedMeta.total
  // The last page's own report is replaced by the one accumulated across every
  // page, so a degradation on an earlier page survives the aggregation.
  delete aggregatedMeta.unreadable_fields
  return {
    data: resources,
    meta: args.all === true
      ? {
          ...aggregatedMeta,
          ...(unreadable.size === 0 ? {} : { unreadable_fields: [...unreadable.values()] }),
          fetched: resources.length,
          page: 1,
          page_size: resources.length,
          pages_fetched: pagesFetched,
          truncated,
          has_next: truncated,
          ...(explicitMaxPages || explicitMaxItems
            ? {
                bounds: {
                  ...(explicitMaxPages ? { max_pages: maxPages } : {}),
                  ...(explicitMaxItems ? { max_items: maxItems } : {})
                }
              }
            : {}),
          ...(truncated && nextLink !== undefined ? { next: nextLink } : {})
        }
      : {
          ...lastMeta,
          // The Poki API does not emit a JSON:API links member, so an
          // authoritative continuation is normally absent. has_next must stay
          // present anyway: an absent signal is indistinguishable from proven
          // completeness, and --format csv carries rows alone, so a missing
          // has_next silently exports a truncated first page with exit 0.
          // A page that filled the requested size is the same "more may exist"
          // fact --all already terminates its numeric scan on.
          has_next: lastNext.present ? lastNext.href !== undefined : lastPageLength >= pageSize
        }
  } satisfies ResourceResult
}

export interface CollectionMatch {
  resource: Record<string, unknown>
  // The untouched backend page the resource was found on. --raw returns this
  // document, so both views resolve the same resource from the same scan.
  document: unknown
}

// Emulates a singular GET for collections without one. When the filtered
// request returns rows that don't match the requested identity, the server ignored
// the filter, so a bounded full scan runs before concluding the resource is
// absent — otherwise a resource beyond page one would produce a false 404.
export async function findInCollection (
  api: ApiClient,
  path: string,
  args: Record<string, unknown>,
  capabilities: ListCapabilities,
  filterKey: string,
  expected: Required<ExpectedJsonApiResource>
): Promise<CollectionMatch | undefined> {
  const query = listSearchParams({}, [[filterKey, expected.id]])
  const response = await api.request({ path, query, timeoutMs: requestTimeout(args) })
  const matches = (item: unknown): item is Record<string, unknown> => isRecord(item) &&
    item.type === expected.type &&
    item.id === expected.id
  const normalized = normalizeJsonApiCollection(response.body)
  const rows = normalized.data === null ? [] : normalized.data as unknown[]
  const found = rows.find(matches)
  // A page that already answers the lookup is never rejected for an unusable
  // continuation: links.next is validated only when another page is needed.
  if (found !== undefined) return { resource: found, document: response.body }
  if (!capabilities.pagination) return undefined
  const firstUrl = api.resolveApiUrl(path, query)
  let next = resolvedNextPageLink(api, response.body, firstUrl)

  // A filtered collection can legitimately start with an empty page and an
  // authoritative continuation. Follow that chain before concluding that the
  // requested resource is absent.
  if (next.href !== undefined) {
    const scan = new PageScan()
    scan.visit(firstUrl.toString())
    scan.repeatedPage(rows, 1)
    let pagesFetched = 1
    let itemsScanned = rows.length

    while (next.href !== undefined) {
      if (scan.visited(next.href)) {
        throw new CliError('INVALID_API_RESPONSE', 'The Poki API returned a cyclic JSON:API next-page link while locating a resource.', 5, {
          details: { cycle: next.href === firstUrl.toString() ? 'self' : 'previously_visited', pages_fetched: pagesFetched }
        })
      }
      if (pagesFetched >= allSafetyMaxPages) {
        throw new CliError('INVALID_API_RESPONSE', `Locating the resource reached the internal ${String(allSafetyMaxPages)}-page safety ceiling before exhaustion; completeness cannot be established.`, 5, {
          details: { safety_ceiling: { max_pages: allSafetyMaxPages }, pages_fetched: pagesFetched, items_scanned: itemsScanned },
          retryable: false,
          hint: 'Use the collection list command with an explicit bound and report that the singular lookup could not establish completeness.'
        })
      }

      const linkedUrl = next.href
      scan.visit(linkedUrl)
      const linkedResponse = await api.request({ path: linkedUrl, timeoutMs: requestTimeout(args) })
      pagesFetched++
      const linkedNormalized = normalizeJsonApiCollection(linkedResponse.body)
      const linkedRows = linkedNormalized.data === null ? [] : linkedNormalized.data as unknown[]
      const linkedFound = linkedRows.find(matches)
      if (linkedFound !== undefined) return { resource: linkedFound, document: linkedResponse.body }

      const firstSeenPage = scan.repeatedPage(linkedRows, pagesFetched)
      if (firstSeenPage !== undefined) {
        throw new CliError('INVALID_API_RESPONSE', 'The Poki API repeated a result page while locating a resource; completeness cannot be established.', 5, {
          details: { pages_fetched: pagesFetched, first_seen_page: firstSeenPage, pagination: 'link' },
          retryable: false
        })
      }

      itemsScanned += linkedRows.length
      next = resolvedNextPageLink(api, linkedResponse.body, new URL(linkedUrl))
      // The ceiling only ends an unfinished scan. A chain that terminated
      // without the resource was exhausted, however many rows it carried, and
      // that answer is NOT_FOUND rather than an inconclusive lookup.
      if (next.href !== undefined && itemsScanned >= allSafetyMaxItems) {
        throw new CliError('INVALID_API_RESPONSE', `Locating the resource reached the internal ${String(allSafetyMaxItems)}-resource safety ceiling before exhaustion; completeness cannot be established.`, 5, {
          details: { safety_ceiling: { max_items: allSafetyMaxItems }, pages_fetched: pagesFetched, items_scanned: itemsScanned },
          retryable: false,
          hint: 'Use the collection list command with an explicit bound and report that the singular lookup could not establish completeness.'
        })
      }
    }
    return undefined
  }

  if (rows.length === 0 || next.present) return undefined
  let match: CollectionMatch | undefined
  await listResources(api, path, { all: true, timeoutMs: args.timeoutMs }, capabilities, [], [], (body, pageRows) => {
    const resource = pageRows.find(matches)
    if (resource === undefined) return false
    match = { resource, document: body }
    return true
  })
  return match
}

// Resources without a singular GET route are read through their collection.
// Both views resolve the resource through that one scan, so --raw cannot
// report a successful empty page for a resource the normalized read finds.
export async function getFromCollection (
  api: ApiClient,
  path: string,
  args: Record<string, unknown>,
  capabilities: ListCapabilities,
  filterKey: string,
  expected: Required<ExpectedJsonApiResource>,
  missing: { label: string, hint: string }
): Promise<unknown> {
  const match = await findInCollection(api, path, args, capabilities, filterKey, expected)
  if (match === undefined) throw notFound(missing.label, expected.id, missing.hint)
  // --raw bypasses developer-surface filtering, not resource resolution, so it
  // returns the untouched backend page that carried the requested resource.
  if (args.raw === true) return match.document
  return { data: match.resource, meta: {} }
}
