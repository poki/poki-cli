import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'

import { listCapabilities } from '../src/list-capabilities'
import { apiHarness, authEnvironment, jsonApi, listen, runCli, temporaryDirectory } from './helpers'

void test('server collection capabilities stay pinned', () => {
  assert.deepEqual(listCapabilities, {
    games: { filter: false, sort: true, pagination: true },
    versions: { filter: true, sort: true, pagination: true },
    versionActivations: { filter: false, sort: false, pagination: true },
    versionFiles: { filter: false, sort: false, pagination: false },
    playtests: { filter: true, sort: false, pagination: false },
    playerFitTests: { filter: true, sort: false, pagination: false },
    reviews: { filter: true, sort: true, pagination: true },
    gameChangeRequests: { filter: true, sort: true, pagination: true },
    gameEvents: { filter: false, sort: true, pagination: true },
    gameEventFunnels: { filter: false, sort: true, pagination: true },
    playerFeedbackQuestions: { filter: false, sort: true, pagination: true },
    netlibLobbies: { filter: true, sort: true, pagination: true }
  })
})

// --all keeps only the last page's normalized meta, so the degradation report
// for a resource on any earlier page used to vanish entirely and an agent read
// a field normalization had refused to represent as absent backend state.
void test('--all accumulates the unreadable-field report across every page it merges', async t => {
  const { env } = await apiHarness(t, (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const page = Number(url.searchParams.get('page[number]') ?? 1)
    // `tracks` is a documented structured field; a non-array value is one the
    // developer surface cannot represent, so normalization drops just that
    // field and reports it. Page 1 and page 2 each carry one such game.
    const games = [
      { type: 'games', id: 'game-1', attributes: { title: 'One', tracks: 'not-an-array' } },
      { type: 'games', id: 'game-2', attributes: { title: 'Two', tracks: 'also-not-an-array' } },
      { type: 'games', id: 'game-3', attributes: { title: 'Three' } }
    ]
    const size = Number(url.searchParams.get('page[size]') ?? 30)
    const data = games.slice((page - 1) * size, page * size)
    jsonApi(res, { data, meta: { total: data.length } })
  }, 'all-unreadable')

  const single = await runCli(['games', 'list', '--page-size', '1', '--format', 'json'], { env })
  assert.equal(single.code, 0, single.stderr)
  assert.deepEqual(JSON.parse(single.stdout).meta.unreadable_fields, [
    { type: 'games', id: 'game-1', fields: ['tracks'] }
  ])

  const all = await runCli(['games', 'list', '--all', '--page-size', '1', '--format', 'json'], { env })
  assert.equal(all.code, 0, all.stderr)
  const output = JSON.parse(all.stdout)
  assert.deepEqual(output.data.map((game: { id: string }) => game.id), ['game-1', 'game-2', 'game-3'])
  // Both degraded resources survive the aggregation, not just the last page's.
  assert.deepEqual(output.meta.unreadable_fields, [
    { type: 'games', id: 'game-1', fields: ['tracks'] },
    { type: 'games', id: 'game-2', fields: ['tracks'] }
  ])

  // A resource an explicit bound cut from the result is not reported: it is not
  // in `data` for anyone to misread as complete.
  const bounded = await runCli(['games', 'list', '--all', '--page-size', '1', '--max-items', '1', '--format', 'json'], { env })
  assert.equal(bounded.code, 0, bounded.stderr)
  assert.deepEqual(JSON.parse(bounded.stdout).meta.unreadable_fields, [
    { type: 'games', id: 'game-1', fields: ['tracks'] }
  ])
})

void test('--all encodes supported version filters and sorting, follows pages, and merges normalized resources', async t => {
  const requestedPages: string[] = []
  const { env } = await apiHarness(t, (req, res) => {
    assert.equal(req.method, 'GET')
    const url = new URL(req.url ?? '/', 'http://localhost')
    assert.equal(url.pathname, '/games/game-1/versions')
    requestedPages.push(url.searchParams.get('page[number]') ?? '')
    assert.equal(url.searchParams.get('page[size]'), '2')
    assert.equal(url.searchParams.get('filter[label]'), 'Example')
    assert.equal(url.searchParams.get('sort'), '-created_at,label')
    const page = Number(url.searchParams.get('page[number]'))
    const data = page === 1
      ? [
          { type: 'game_versions', id: 'version-1', attributes: { label: 'One' } },
          { type: 'game_versions', id: 'version-2', attributes: { label: 'Two' } }
        ]
      : [{ type: 'game_versions', id: 'version-3', attributes: { label: 'Three' } }]
    const links = page === 1
      ? { next: { href: '?page%5Bnumber%5D=7&page%5Bsize%5D=2&filter%5Blabel%5D=Example&sort=-created_at%2Clabel' } }
      : { next: null }
    jsonApi(res, { data, links, meta: { total: 3 } })
  }, 'pages')

  const result = await runCli([
    'versions', 'list', '--game', 'game-1', '--archived', 'all', '--filter', 'label=Example', '--sort', '-created_at', '--sort', 'label',
    '--page-size', '2', '--all', '--format', 'json'
  ], { env })
  assert.equal(result.code, 0, result.stderr)
  assert.deepEqual(requestedPages, ['1', '7'])
  const output = JSON.parse(result.stdout)
  assert.deepEqual(output.data.map((version: { id: string }) => version.id), ['version-1', 'version-2', 'version-3'])
  assert.deepEqual(output.meta, {
    fetched: 3,
    page: 1,
    page_size: 3,
    pages_fetched: 2,
    truncated: false,
    has_next: false,
    view: 'summary'
  })

  const raw = await runCli(['versions', 'list', '--game', 'game-1', '--archived', 'all', '--filter', 'label=Example', '--sort', '-created_at', '--sort', 'label', '--page-size', '2', '--raw', '--format', 'json'], { env })
  assert.equal(raw.code, 0, raw.stderr)
  assert.deepEqual(JSON.parse(raw.stdout).data[0].attributes, { label: 'One' })
})

void test('--all does not trust per-page totals and non-paginated endpoints reject pagination options', async t => {
  const gamePages: string[] = []
  const recordingPages: string[] = []
  const { env } = await apiHarness(t, (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const page = url.searchParams.get('page[number]') ?? ''
    if (url.pathname === '/games') {
      gamePages.push(page)
      const data = page === '1'
        ? [
            { type: 'games', id: 'game-1', attributes: {} },
            { type: 'games', id: 'game-2', attributes: {} }
          ]
        : [{ type: 'games', id: 'game-3', attributes: {} }]
      // /games currently reports the current page length instead of a full count.
      jsonApi(res, { data, meta: { total: data.length } })
      return
    }
    if (url.pathname === '/games/game-1/playtest-recordings') {
      recordingPages.push(page)
      assert.equal(url.searchParams.get('filter[device_category]'), 'mobile')
      assert.equal(url.searchParams.has('page[size]'), false)
      jsonApi(res, {
        data: [
          { type: 'playtest_recordings', id: 'recording-1', attributes: {} },
          { type: 'playtest_recordings', id: 'recording-2', attributes: {} }
        ],
        meta: { total: 2 }
      })
      return
    }
    res.writeHead(404)
    res.end()
  }, 'page-fallback')

  // Combining an explicit page with --all is now an input error instead of a
  // silently ignored flag.
  const conflicting = await runCli(['games', 'list', '--page', '9', '--page-size', '2', '--all', '--format', 'json'], { env })
  assert.equal(conflicting.code, 2)
  assert.equal(JSON.parse(conflicting.stderr).error.code, 'INVALID_INPUT')
  assert.deepEqual(gamePages, [])

  const games = await runCli(['games', 'list', '--page-size', '2', '--all', '--format', 'json'], { env })
  assert.equal(games.code, 0, games.stderr)
  assert.deepEqual(gamePages, ['1', '2'])
  assert.deepEqual(JSON.parse(games.stdout).meta, {
    fetched: 3,
    page: 1,
    page_size: 3,
    pages_fetched: 2,
    truncated: false,
    has_next: false,
    view: 'summary'
  })

  const unsupported = await runCli(['playtest-recordings', 'list', '--game', 'game-1', '--page-size', '2', '--all', '--format', 'json'], { env })
  assert.equal(unsupported.code, 2)
  assert.equal(JSON.parse(unsupported.stderr).error.code, 'INVALID_INPUT')
  assert.deepEqual(recordingPages, [])

  const recordings = await runCli(['playtest-recordings', 'list', '--game', 'game-1', '--archived', 'all', '--filter', 'device_category=mobile', '--format', 'json'], { env })
  assert.equal(recordings.code, 0, recordings.stderr)
  assert.deepEqual(recordingPages, [''])
  assert.equal(JSON.parse(recordings.stdout).data.length, 2)
})

void test('--all follows authoritative next links across empty intermediate pages, including with a page bound', async t => {
  const directory = temporaryDirectory(t, 'empty-linked-pages')
  let base = ''
  let requestedPages: string[] = []
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const page = url.searchParams.get('page[number]') ?? '1'
    requestedPages.push(page)
    if (page === '1') {
      jsonApi(res, { data: [], links: { next: `${base}/games?page%5Bnumber%5D=2&page%5Bsize%5D=1` } })
      return
    }
    if (page === '2') {
      jsonApi(res, { data: [], links: { next: `${base}/games?page%5Bnumber%5D=3&page%5Bsize%5D=1` } })
      return
    }
    jsonApi(res, {
      data: [{ type: 'games', id: 'game-after-gap', attributes: {} }],
      links: { next: null }
    })
  })
  base = await listen(t, server)
  const env = authEnvironment(directory, base)

  const complete = await runCli(['games', 'list', '--all', '--page-size', '1', '--format', 'json'], { env })
  assert.equal(complete.code, 0, complete.stderr)
  assert.deepEqual(requestedPages, ['1', '2', '3'])
  assert.deepEqual(JSON.parse(complete.stdout).data.map((game: { id: string }) => game.id), ['game-after-gap'])
  assert.equal(JSON.parse(complete.stdout).meta.pages_fetched, 3)
  assert.equal(JSON.parse(complete.stdout).meta.truncated, false)

  requestedPages = []
  const bounded = await runCli(['games', 'list', '--all', '--page-size', '1', '--max-pages', '2', '--format', 'json'], { env })
  assert.equal(bounded.code, 0, bounded.stderr)
  assert.deepEqual(requestedPages, ['1', '2'])
  const boundedOutput = JSON.parse(bounded.stdout)
  assert.deepEqual(boundedOutput.data, [])
  assert.equal(boundedOutput.meta.pages_fetched, 2)
  assert.equal(boundedOutput.meta.truncated, true)
  assert.equal(boundedOutput.meta.next, `${base}/games?page%5Bnumber%5D=3&page%5Bsize%5D=1`)
})

void test('--all enforces safety bounds and rejects malformed or cyclic next links', async t => {
  const directory = temporaryDirectory(t, 'page-defense')
  let next: unknown
  let requests = 0
  const server = createServer((req, res) => {
    requests++
    jsonApi(res, {
      data: [
        { type: 'games', id: 'game-1', attributes: {} },
        { type: 'games', id: 'game-2', attributes: {} }
      ],
      links: { next: next === 'echo' ? req.url : next },
      meta: { total: 4 }
    })
  })
  const base = await listen(t, server)
  const env = authEnvironment(directory, base)

  // A next link that resolves to the URL just fetched must not loop forever.
  next = 'echo'
  const cyclic = await runCli(['games', 'list', '--all', '--page-size', '2', '--format', 'json'], { env })
  assert.equal(cyclic.code, 5, cyclic.stdout)
  assert.equal(cyclic.stdout, '')
  const cyclicError = JSON.parse(cyclic.stderr).error
  assert.equal(cyclicError.code, 'INVALID_API_RESPONSE')
  assert.match(cyclicError.message, /cyclic/)
  assert.deepEqual(cyclicError.details, { cycle: 'self', pages_fetched: 1 })
  assert.equal(requests, 1)

  next = 'https://cross-origin.example.invalid/private-pagination-token'
  requests = 0
  const crossOrigin = await runCli(['games', 'list', '--all', '--page-size', '2', '--max-pages', '1', '--format', 'json'], { env })
  assert.equal(crossOrigin.code, 5, crossOrigin.stdout)
  assert.equal(crossOrigin.stdout, '')
  const crossOriginError = JSON.parse(crossOrigin.stderr).error
  assert.equal(crossOriginError.code, 'INVALID_API_RESPONSE')
  assert.deepEqual(crossOriginError.details, {
    expected: { next_url: 'same_origin_http_or_https_url' },
    received: { next_url_kind: 'different_origin' }
  })
  assert.doesNotMatch(crossOrigin.stderr, /cross-origin|private-pagination-token/)
  assert.equal(requests, 1)

  next = 'http://[invalid-pagination-secret'
  requests = 0
  const invalidUrl = await runCli(['games', 'list', '--page-size', '2', '--format', 'json'], { env })
  assert.equal(invalidUrl.code, 5, invalidUrl.stdout)
  assert.equal(invalidUrl.stdout, '')
  const invalidUrlError = JSON.parse(invalidUrl.stderr).error
  assert.equal(invalidUrlError.code, 'INVALID_API_RESPONSE')
  assert.deepEqual(invalidUrlError.details, {
    expected: { next_url: 'same_origin_http_or_https_url' },
    received: { next_url_kind: 'invalid_url' }
  })
  assert.doesNotMatch(invalidUrl.stderr, /invalid-pagination-secret/)
  assert.equal(requests, 1)

  next = 42
  requests = 0
  const invalid = await runCli(['games', 'list', '--all', '--page-size', '2', '--format', 'json'], { env })
  assert.equal(invalid.code, 5, invalid.stdout)
  assert.equal(invalid.stdout, '')
  const invalidError = JSON.parse(invalid.stderr).error
  assert.equal(invalidError.code, 'INVALID_API_RESPONSE')
  assert.match(invalidError.message, /next-page link/)
  assert.deepEqual(invalidError.details, {
    expected: { next_kinds: ['string', 'object_with_string_href', 'null'] },
    received: { next_kind: 'number' }
  })
  assert.equal(requests, 1)

  next = { href: { token: 'next-link-secret' }, internal: { secret: 'must-not-escape' } }
  requests = 0
  const sensitiveInvalid = await runCli(['games', 'list', '--all', '--page-size', '2', '--format', 'json'], { env })
  assert.equal(sensitiveInvalid.code, 5, sensitiveInvalid.stdout)
  const sensitiveError = JSON.parse(sensitiveInvalid.stderr).error
  assert.equal(sensitiveError.code, 'INVALID_API_RESPONSE')
  assert.deepEqual(sensitiveError.details.received, {
    next_kind: 'object',
    href_member: 'present',
    href_kind: 'object'
  })
  assert.doesNotMatch(sensitiveInvalid.stderr, /next-link-secret|must-not-escape/)
  assert.equal(requests, 1)

  next = `${base}/games?page%5Bnumber%5D=2&page%5Bsize%5D=2`
  requests = 0
  const bounded = await runCli(['games', 'list', '--all', '--page-size', '2', '--max-pages', '1', '--format', 'json'], { env })
  assert.equal(bounded.code, 0, bounded.stderr)
  const output = JSON.parse(bounded.stdout)
  assert.equal(output.data.length, 2)
  assert.equal(output.meta.truncated, true)
  assert.equal(output.meta.pages_fetched, 1)
  assert.deepEqual(output.meta.bounds, { max_pages: 1 })
  assert.equal(output.meta.next, next)
  assert.equal(requests, 1)

  const boundWithoutAll = await runCli(['games', 'list', '--max-pages', '1', '--format', 'json'], { env })
  assert.equal(boundWithoutAll.code, 2)
  assert.equal(boundWithoutAll.stdout, '')
  assert.match(boundWithoutAll.stderr, /--max-pages and --max-items require --all/)
  assert.equal(requests, 1)

  const csv = await runCli(['games', 'list', '--all', '--page-size', '2', '--max-pages', '1', '--format', 'csv'], { env })
  assert.equal(csv.code, 2)
  assert.equal(csv.stdout, '')
  assert.match(csv.stderr, /INVALID_INPUT/)
  assert.match(csv.stderr, /cannot represent pagination truncation metadata/)
  assert.equal(requests, 2)

  // --max-items reports truncation only when additional resources may exist.
  next = null
  const complete = await runCli(['games', 'list', '--all', '--max-items', '2', '--format', 'json'], { env })
  assert.equal(complete.code, 0, complete.stderr)
  assert.equal(JSON.parse(complete.stdout).meta.truncated, false)
  assert.equal(JSON.parse(complete.stdout).data.length, 2)

  const itemBounded = await runCli(['games', 'list', '--all', '--max-items', '1', '--format', 'json'], { env })
  assert.equal(itemBounded.code, 0, itemBounded.stderr)
  assert.equal(JSON.parse(itemBounded.stdout).meta.truncated, true)
  assert.deepEqual(JSON.parse(itemBounded.stdout).meta.bounds, { max_items: 1 })
  assert.equal(JSON.parse(itemBounded.stdout).data.length, 1)
})

void test('--max-items reports the first unfollowed next link from the page where it truncates', async t => {
  const directory = temporaryDirectory(t, 'page-item-next')
  const requestedPages: string[] = []
  let base = ''
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const page = Number(url.searchParams.get('page[number]'))
    requestedPages.push(String(page))
    jsonApi(res, {
      data: [{ type: 'games', id: `game-${String(page)}`, attributes: {} }],
      links: { next: `${base}/games?page%5Bnumber%5D=${String(page + 1)}&page%5Bsize%5D=1` }
    })
  })
  base = await listen(t, server)
  const env = authEnvironment(directory, base)

  const result = await runCli(['games', 'list', '--all', '--page-size', '1', '--max-items', '2', '--format', 'json'], { env })
  assert.equal(result.code, 0, result.stderr)
  assert.deepEqual(requestedPages, ['1', '2'])
  const output = JSON.parse(result.stdout)
  assert.deepEqual(output.data.map((game: { id: string }) => game.id), ['game-1', 'game-2'])
  assert.equal(output.meta.truncated, true)
  assert.deepEqual(output.meta.bounds, { max_items: 2 })
  assert.equal(output.meta.next, `${base}/games?page%5Bnumber%5D=3&page%5Bsize%5D=1`)
})

void test('--max-items omits an unsafe continuation link when truncation stops inside a page', async t => {
  const directory = temporaryDirectory(t, 'page-item-partial')
  let base = ''
  const server = createServer((_req, res) => {
    jsonApi(res, {
      data: [
        { type: 'games', id: 'game-1', attributes: {} },
        { type: 'games', id: 'game-2', attributes: {} }
      ],
      links: { next: `${base}/games?page%5Bnumber%5D=2&page%5Bsize%5D=2` }
    })
  })
  base = await listen(t, server)
  const env = authEnvironment(directory, base)

  const result = await runCli(['games', 'list', '--all', '--page-size', '2', '--max-items', '1', '--format', 'json'], { env })
  assert.equal(result.code, 0, result.stderr)
  const output = JSON.parse(result.stdout)
  assert.deepEqual(output.data.map((game: { id: string }) => game.id), ['game-1'])
  assert.equal(output.meta.truncated, true)
  assert.equal(output.meta.has_next, true)
  assert.equal(output.meta.next, undefined)
})

void test('plain --all fails closed at internal page and item safety ceilings', async t => {
  const directory = temporaryDirectory(t, 'page-internal-ceilings')
  let base = ''
  let pageRequests = 0
  let itemRequests = 0
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.searchParams.get('page[size]') === '10001') {
      itemRequests++
      jsonApi(res, {
        data: Array.from({ length: 10001 }, (_, index) => ({ type: 'games', id: `item-${String(index)}`, attributes: {} })),
        links: { next: null }
      })
      return
    }
    pageRequests++
    const page = Number(url.searchParams.get('page[number]'))
    jsonApi(res, {
      data: [{ type: 'games', id: `page-${String(page)}`, attributes: {} }],
      links: { next: `${base}/games?page%5Bnumber%5D=${String(page + 1)}&page%5Bsize%5D=1` }
    })
  })
  base = await listen(t, server)
  const env = authEnvironment(directory, base)

  const pages = await runCli(['games', 'list', '--all', '--page-size', '1', '--format', 'json'], { env })
  assert.equal(pages.code, 5)
  assert.equal(pages.stdout, '')
  const pageError = JSON.parse(pages.stderr).error
  assert.equal(pageError.code, 'INVALID_API_RESPONSE')
  assert.match(pageError.message, /internal 100-page safety ceiling/)
  assert.deepEqual(pageError.details.safety_ceiling, { max_pages: 100 })
  assert.equal(pageError.details.pages_fetched, 100)
  assert.equal('next' in pageError.details, false)
  assert.doesNotMatch(pages.stderr, /page%5Bnumber%5D=101/)
  assert.equal(pageRequests, 100)

  const items = await runCli(['games', 'list', '--all', '--page-size', '10001', '--format', 'json'], { env })
  assert.equal(items.code, 5)
  assert.equal(items.stdout, '')
  const itemError = JSON.parse(items.stderr).error
  assert.equal(itemError.code, 'INVALID_API_RESPONSE')
  assert.match(itemError.message, /internal 10000-resource safety ceiling/)
  assert.deepEqual(itemError.details.safety_ceiling, { max_items: 10000 })
  assert.equal(itemError.details.fetched, 10000)
  assert.equal(itemRequests, 1)
})

void test('collection get fails closed instead of returning a false 404 after an incomplete fallback scan', async t => {
  const directory = temporaryDirectory(t, 'page-find-incomplete')
  let base = ''
  let requests = 0
  const server = createServer((req, res) => {
    requests++
    const url = new URL(req.url ?? '/', 'http://localhost')
    assert.equal(url.pathname, '/games/g/change_requests')
    if (url.searchParams.has('filter[id]')) {
      jsonApi(res, { data: [{ type: 'game_change_requests', id: 'wrong-filter-result', attributes: {} }] })
      return
    }
    const page = Number(url.searchParams.get('page[number]'))
    jsonApi(res, {
      data: [{ type: 'game_change_requests', id: `request-${String(page)}`, attributes: {} }],
      links: { next: `${base}/games/g/change_requests?page%5Bnumber%5D=${String(page + 1)}&page%5Bsize%5D=30` }
    })
  })
  base = await listen(t, server)
  const env = authEnvironment(directory, base)

  const result = await runCli(['game-change-requests', 'get', 'target', '--game', 'g', '--format', 'json'], { env })
  assert.equal(result.code, 5)
  assert.equal(result.stdout, '')
  const error = JSON.parse(result.stderr).error
  assert.equal(error.code, 'INVALID_API_RESPONSE')
  assert.match(error.message, /completeness cannot be established/)
  assert.equal(requests, 101)
})

void test('collection get stops its fallback scan as soon as the requested resource is found', async t => {
  const directory = temporaryDirectory(t, 'page-find-early-stop')
  let base = ''
  const requests: string[] = []
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    requests.push(url.pathname + url.search)
    assert.equal(url.pathname, '/games/g/change_requests')
    if (url.searchParams.has('filter[id]')) {
      jsonApi(res, { data: [{ type: 'game_change_requests', id: 'wrong-filter-result', attributes: {} }] })
      return
    }
    if (url.searchParams.get('page[number]') === '1') {
      jsonApi(res, {
        data: [{ type: 'game_change_requests', id: 'target', attributes: { status: 'pending' } }],
        links: { next: `${base}/games/g/change_requests?page%5Bnumber%5D=2&page%5Bsize%5D=30` }
      })
      return
    }
    jsonApi(res, { errors: [{ status: '500', code: 'later-page-failed', detail: 'must not be requested' }] }, 500)
  })
  base = await listen(t, server)
  const env = authEnvironment(directory, base)

  const result = await runCli(['game-change-requests', 'get', 'target', '--game', 'g', '--format', 'json'], { env })
  assert.equal(result.code, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).data.id, 'target')
  assert.equal(requests.length, 2)
  assert.match(requests[0], /filter%5Bid%5D=target/)
  assert.match(requests[1], /page%5Bnumber%5D=1/)
})

void test('collection get follows an authoritative next link after an empty filtered page', async t => {
  const directory = temporaryDirectory(t, 'filtered-empty-linked-page')
  let base = ''
  const requests: string[] = []
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    requests.push(url.pathname + url.search)
    assert.equal(url.pathname, '/games/g/change_requests')
    if (url.searchParams.get('page[number]') === '2') {
      jsonApi(res, {
        data: [{ type: 'game_change_requests', id: 'target', attributes: { title: 'Found after empty page' } }],
        links: { next: null }
      })
      return
    }
    assert.equal(url.searchParams.get('filter[id]'), 'target')
    jsonApi(res, {
      data: [],
      links: { next: `${base}/games/g/change_requests?page%5Bnumber%5D=2&filter%5Bid%5D=target` }
    })
  })
  base = await listen(t, server)
  const env = authEnvironment(directory, base)

  const result = await runCli(['game-change-requests', 'get', 'target', '--game', 'g', '--format', 'json'], { env })
  assert.equal(result.code, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).data.id, 'target')
  assert.equal(requests.length, 2)
})

void test('collection get --raw resolves the requested resource through the same next-link chain', async t => {
  const directory = temporaryDirectory(t, 'raw-collection-get')
  let base = ''
  let requests: string[] = []
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    requests.push(url.pathname + url.search)
    assert.equal(url.pathname, '/games/g/change_requests')
    if (url.searchParams.get('page[number]') === '2') {
      jsonApi(res, {
        data: [{ type: 'game_change_requests', id: 'wanted', attributes: { status: 'pending', backend_only: 'preserved in raw output' } }],
        links: { next: null },
        meta: { total: 1, backend_only: 'preserved in raw output' }
      })
      return
    }
    const filtered = url.searchParams.get('filter[id]') ?? ''
    jsonApi(res, {
      data: [],
      links: { next: `${base}/games/g/change_requests?page%5Bnumber%5D=2&filter%5Bid%5D=${filtered}` }
    })
  })
  base = await listen(t, server)
  const env = authEnvironment(directory, base)

  const raw = await runCli(['game-change-requests', 'get', 'wanted', '--game', 'g', '--raw', '--format', 'json'], { env })
  assert.equal(raw.code, 0, raw.stderr)
  assert.equal(requests.length, 2)
  const document = JSON.parse(raw.stdout)
  assert.equal(document.data[0].id, 'wanted')
  // The page that carried the resource is returned untouched.
  assert.equal(document.data[0].attributes.backend_only, 'preserved in raw output')
  assert.equal(document.meta.backend_only, 'preserved in raw output')

  // An empty successful collection must never stand in for a missing resource.
  requests = []
  const missing = await runCli(['game-change-requests', 'get', 'absent', '--game', 'g', '--raw', '--format', 'json'], { env })
  assert.equal(missing.code, 4)
  assert.equal(missing.stdout, '')
  assert.equal(JSON.parse(missing.stderr).error.code, 'NOT_FOUND')
  assert.equal(requests.length, 2)
})

void test('collection get returns a resource found beside an unusable next link', async t => {
  let requests = 0
  const { env } = await apiHarness(t, (_req, res) => {
    requests++
    jsonApi(res, {
      data: [{ type: 'game_change_requests', id: 'target', attributes: { status: 'pending' } }],
      links: { next: 'https://cross-origin.example.invalid/private-pagination-token' }
    })
  }, 'found-with-bad-next')

  const result = await runCli(['game-change-requests', 'get', 'target', '--game', 'g', '--format', 'json'], { env })
  assert.equal(result.code, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).data.id, 'target')
  assert.equal(requests, 1)

  const raw = await runCli(['game-change-requests', 'get', 'target', '--game', 'g', '--raw', '--format', 'json'], { env })
  assert.equal(raw.code, 0, raw.stderr)
  assert.equal(JSON.parse(raw.stdout).data[0].id, 'target')
  assert.equal(requests, 2)
})

void test('collection get reports NOT_FOUND when a large next-link chain ends without the resource', async t => {
  const directory = temporaryDirectory(t, 'find-large-chain')
  let base = ''
  let exhausted = true
  let requests = 0
  const server = createServer((req, res) => {
    requests++
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.searchParams.get('page[number]') === '2') {
      jsonApi(res, {
        data: Array.from({ length: 10001 }, (_, index) => ({ type: 'game_change_requests', id: `other-${String(index)}`, attributes: {} })),
        links: { next: exhausted ? null : `${base}/games/g/change_requests?page%5Bnumber%5D=3&filter%5Bid%5D=target` }
      })
      return
    }
    jsonApi(res, {
      data: [],
      links: { next: `${base}/games/g/change_requests?page%5Bnumber%5D=2&filter%5Bid%5D=target` }
    })
  })
  base = await listen(t, server)
  const env = authEnvironment(directory, base)

  const complete = await runCli(['game-change-requests', 'get', 'target', '--game', 'g', '--format', 'json'], { env })
  assert.equal(complete.code, 4, complete.stderr)
  assert.equal(complete.stdout, '')
  assert.equal(JSON.parse(complete.stderr).error.code, 'NOT_FOUND')
  assert.equal(requests, 2)

  // A chain that still has a continuation at the ceiling remains inconclusive.
  exhausted = false
  requests = 0
  const incomplete = await runCli(['game-change-requests', 'get', 'target', '--game', 'g', '--format', 'json'], { env })
  assert.equal(incomplete.code, 5, incomplete.stdout)
  const error = JSON.parse(incomplete.stderr).error
  assert.equal(error.code, 'INVALID_API_RESPONSE')
  assert.deepEqual(error.details.safety_ceiling, { max_items: 10000 })
  assert.equal(error.details.items_scanned, 10001)
  assert.equal(error.retryable, false)
  assert.equal(requests, 2)
})

void test('--all --max-items above the internal page ceiling reports the ceiling that stopped it', async t => {
  const directory = temporaryDirectory(t, 'page-ceiling-with-items')
  let base = ''
  let requests = 0
  const server = createServer((req, res) => {
    requests++
    const url = new URL(req.url ?? '/', 'http://localhost')
    const page = Number(url.searchParams.get('page[number]'))
    jsonApi(res, {
      data: [{ type: 'games', id: `page-${String(page)}`, attributes: {} }],
      links: { next: `${base}/games?page%5Bnumber%5D=${String(page + 1)}&page%5Bsize%5D=1` }
    })
  })
  base = await listen(t, server)
  const env = authEnvironment(directory, base)

  const result = await runCli(['games', 'list', '--all', '--page-size', '1', '--max-items', '500', '--format', 'json'], { env })
  assert.equal(result.code, 5, result.stdout)
  assert.equal(result.stdout, '')
  const error = JSON.parse(result.stderr).error
  assert.equal(error.code, 'INVALID_API_RESPONSE')
  assert.equal(error.retryable, false)
  assert.match(error.message, /internal 100-page safety ceiling/)
  assert.deepEqual(error.details.safety_ceiling, { max_pages: 100 })
  assert.deepEqual(error.details.bounds, { max_items: 500 })
  assert.equal(error.details.fetched, 100)
  assert.equal(error.details.pages_fetched, 100)
  // The hint must not repeat the bound the caller already supplied, and must
  // separate this ceiling from a cyclic link.
  assert.match(error.hint, /Lower --max-items or add an explicit --max-pages/)
  assert.match(error.hint, /no link cycle was detected/)
  assert.doesNotMatch(result.stderr, /page%5Bnumber%5D=101|127\.0\.0\.1/)
  assert.equal(requests, 100)
})

void test('--all fails closed when numeric pagination repeats a page', async t => {
  let requests = 0
  const { env } = await apiHarness(t, (_req, res) => {
    requests++
    jsonApi(res, {
      data: [
        { type: 'games', id: 'game-1', attributes: { title: 'One' } },
        { type: 'games', id: 'game-2', attributes: { title: 'Two' } }
      ],
      meta: { total: 2 }
    })
  }, 'page-repeat')

  const result = await runCli(['games', 'list', '--all', '--page-size', '2', '--format', 'json'], { env })
  assert.equal(result.code, 5)
  assert.equal(result.stdout, '')
  const error = JSON.parse(result.stderr).error
  assert.equal(error.code, 'INVALID_API_RESPONSE')
  assert.match(error.message, /repeated a result page/)
  assert.deepEqual(error.details, { page: 2, page_size: 2, pages_fetched: 2, first_seen_page: 1, pagination: 'numeric' })
  assert.equal(error.retryable, false)
  assert.equal(requests, 2)
})
