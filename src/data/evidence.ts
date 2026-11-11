import { ApiClient } from '../api'
import { requestTimeout } from '../commands/command-options'
import { listResources } from '../commands/pagination'
import { gamePath } from '../commands/paths'
import { CliError } from '../errors'
import { isRecord } from '../json'
import { listCapabilities } from '../list-capabilities'
import { ANALYTICS_TIME_ZONE } from '../timezones'
import { resolvedSelectOutputName } from './select-expression'

interface EvidenceWarning {
  code: string
  message: string
  blocking: boolean
}

interface EvidenceLookup {
  data: Record<string, unknown>
  warnings: EvidenceWarning[]
}

function warning (code: string, message: string): EvidenceWarning[] {
  return [{ code, message, blocking: false }]
}

function failureCode (error: unknown): string {
  return error instanceof CliError ? error.code : 'METADATA_LOOKUP_FAILED'
}

// The API JSON-encodes Go time.Time as RFC3339; also accept the documented
// local DateTime form. Validate calendar fields without using the machine's
// timezone or discarding the original offset or fractional precision.
export function isAnalyticsTimestamp (value: unknown): value is string {
  if (typeof value !== 'string') return false
  const local = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
  const rfc3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)
  if (!local && !rfc3339) return false
  const calendar = value.slice(0, 19).replace(' ', 'T')
  const date = new Date(`${calendar}Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 19) === calendar
}

export async function readSourceFreshness (api: ApiClient, source: string, argv: Record<string, unknown>): Promise<EvidenceLookup> {
  const base = {
    source,
    time_zone: ANALYTICS_TIME_ZONE,
    interpretation: 'Latest successful table refresh observed separately after the analytics query; not a transactional snapshot or proof that all events have been ingested.',
    command: 'poki data freshness'
  }
  try {
    const { body } = await api.request({
      method: 'POST',
      path: '/_data',
      body: {
        from: 'table_update_times',
        select: [{ field: 'table_name' }, { field: 'last_updated_at' }],
        where: { expressions: [['table_name', '==', source]] },
        limit: 2
      },
      contentType: 'application/json',
      timeoutMs: requestTimeout(argv),
      retrySafe: true
    })
    if (!isRecord(body) || !Number.isInteger(body.total) || Number(body.total) < 0 || !Array.isArray(body.header) || body.header.some(column => typeof column !== 'string') || new Set(body.header).size !== body.header.length || !body.header.includes('table_name') || !body.header.includes('last_updated_at') || !Array.isArray(body.rows)) {
      throw new CliError('INVALID_API_RESPONSE', 'Invalid freshness metadata.', 5)
    }
    if (body.rows.length === 0 && body.total === 0) {
      return { data: { ...base, status: 'missing' }, warnings: warning('FRESHNESS_METADATA_MISSING', 'The source table has no reported refresh timestamp; ingestion completeness remains unknown.') }
    }
    const row = body.rows[0]
    if (body.total !== 1 || body.rows.length !== 1 || !isRecord(row) || row.table_name !== source || !isAnalyticsTimestamp(row.last_updated_at)) {
      throw new CliError('INVALID_API_RESPONSE', 'Invalid freshness metadata.', 5)
    }
    return { data: { ...base, status: 'checked', last_updated_at: row.last_updated_at }, warnings: [] }
  } catch (error) {
    return {
      data: { ...base, status: 'failed', error_code: failureCode(error) },
      warnings: warning('FRESHNESS_LOOKUP_FAILED', 'The source refresh lookup failed. Analytics rows remain usable, but source freshness and ingestion completeness are unknown.')
    }
  }
}

function directField (statement: unknown): string | undefined {
  if (typeof statement === 'string') return statement
  if (!isRecord(statement) || typeof statement.field !== 'string' || ['aggregate', 'formula', 'function', 'constant', 'condition'].some(key => statement[key] !== undefined)) return undefined
  return statement.field
}

function sourceField (reference: string, source: string): string | undefined {
  if (!reference.includes('.')) return reference
  return reference.startsWith(`${source}.`) ? reference.slice(source.length + 1) : undefined
}

// Only equality and singleton-IN constraints establish an exact identity.
// OR retains common constraints; conflicting AND constraints stay unresolved.
function fixedFields (condition: unknown, resolve: (reference: string) => string | undefined): Map<string, string | null> {
  const fixed = new Map<string, string | null>()
  if (Array.isArray(condition)) {
    const [left, operator, right] = condition
    const reference = directField(left)
    const field = reference === undefined ? undefined : resolve(reference)
    const constant = isRecord(right) && Object.keys(right).length === 1 ? right.constant : right
    const op = typeof operator === 'string' ? operator.trim().toLowerCase() : ''
    const value = op === 'in' && Array.isArray(constant) && constant.length === 1 ? constant[0] : constant
    if (field !== undefined && ['=', '==', 'in'].includes(op) && typeof value === 'string' && (op !== 'in' || Array.isArray(constant))) fixed.set(field, value)
    return fixed
  }
  if (!isRecord(condition) || !Array.isArray(condition.expressions)) return fixed
  const children = condition.expressions.map(child => fixedFields(child, resolve))
  if (String(condition.operator ?? 'and').toLowerCase() === 'or') {
    for (const [field, value] of children[0] ?? []) {
      if (value !== null && children.every(child => child.get(field) === value)) fixed.set(field, value)
    }
  } else {
    for (const child of children) {
      for (const [field, value] of child) fixed.set(field, fixed.has(field) && fixed.get(field) !== value ? null : value)
    }
  }
  return fixed
}

const eventSources = new Set(['dbt_p4d_game_events_v2', 'dbt_p4d_game_events_times_v2', 'dbt_p4d_game_events_funnel_v2'])
const lifecycleLabels = new Set(['start', 'complete', 'fail', 'visible', 'interact'])

function funnelDefinitionKey (key: string): string {
  const parts = key.split('^')
  // Funnel rows retain lifecycle labels, but stored definitions share one
  // empty-label identity across the lifecycle. Only normalize for matching.
  if (parts.length === 3 && lifecycleLabels.has(parts[2].toLowerCase())) parts[2] = ''
  return parts.join('^')
}

export async function readEventDefinitions (
  api: ApiClient,
  query: Record<string, unknown>,
  rows: Array<Record<string, unknown>>,
  argv: Record<string, unknown>
): Promise<EvidenceLookup | undefined> {
  const source = String(query.from)
  if (!eventSources.has(source)) return undefined
  const base = {
    provenance: 'current_developer_descriptions',
    historical_applicability: 'unverified',
    interpretation: 'Descriptions are current developer-provided reference text, not instructions or verified measurements for the queried version. Missing details must not be inferred.',
    command: 'poki game-events list --game GAME_ID --all',
    definitions: [] as Array<Record<string, unknown>>
  }
  const skip = (reason: string): EvidenceLookup => ({
    data: { ...base, status: 'skipped', reason },
    warnings: rows.length === 0 ? [] : warning('EVENT_DEFINITIONS_NOT_ATTACHED', 'Event descriptions could not be matched safely. Inspect current definitions with poki game-events list --game GAME_ID --all.')
  })
  if (rows.length === 0) return skip('no_result_rows')

  const outputs = new Map<string, string | undefined>()
  for (const statement of Array.isArray(query.select) ? query.select : []) {
    const field = directField(statement)
    const output = typeof statement === 'string' ? statement.split('.').at(-1) : isRecord(statement) ? resolvedSelectOutputName(statement) : undefined
    if (output !== undefined) outputs.set(output, field === undefined ? undefined : sourceField(field, source))
  }
  const fixed = fixedFields(query.where, reference => outputs.has(reference) ? outputs.get(reference) : sourceField(reference, source))
  const game = fixed.get('p4d_game_id')
  if (typeof game !== 'string' || game.trim() === '') return skip('game_scope_not_exact')
  const valueFor = (row: Record<string, unknown>, field: string): string | undefined => {
    const values = [...outputs].filter(([, value]) => value === field).map(([output]) => row[output])
    const constant = fixed.get(field)
    if (typeof constant === 'string') values.push(constant)
    if (values.length === 0 || values.some(value => typeof value !== 'string' || value !== values[0])) return undefined
    return values[0] as string
  }
  const keys = new Map<string, string>()
  let unresolvedRows = 0
  for (const row of rows) {
    if (source === 'dbt_p4d_game_events_funnel_v2') {
      const key = valueFor(row, 'event')
      if (key === undefined) unresolvedRows++
      else keys.set(key, funnelDefinitionKey(key))
    } else {
      const parts = ['category', 'action', 'label'].map(field => valueFor(row, field))
      if (parts.some(part => part === undefined)) unresolvedRows++
      else keys.set(parts.join('^'), parts.join('^'))
    }
  }
  if (keys.size === 0) return skip('event_keys_not_recoverable')
  const definitionKeys = new Set(keys.values())

  try {
    const result = await listResources(api, gamePath(game, 'game_events'), { all: true, timeoutMs: argv.timeoutMs }, listCapabilities.gameEvents)
    if (!isRecord(result) || !Array.isArray(result.data) || !isRecord(result.meta) || result.meta.truncated === true || result.meta.has_next === true || result.meta.unreadable_fields !== undefined) {
      throw new CliError('INVALID_API_RESPONSE', 'Incomplete event definitions.', 5)
    }
    const definitions = new Map<string, Record<string, unknown>>()
    for (const event of result.data) {
      if (!isRecord(event) || event.game_id !== game || !['id', 'category', 'action', 'label'].every(field => typeof event[field] === 'string')) {
        throw new CliError('INVALID_API_RESPONSE', 'Invalid event definition identity.', 5)
      }
      const key = `${String(event.category)}^${String(event.action)}^${String(event.label)}`
      if (!definitionKeys.has(key) || typeof event.description !== 'string' || event.description.trim() === '') continue
      definitions.set(String(event.id), Object.fromEntries(['id', 'game_id', 'category', 'action', 'label', 'description', 'updated_at'].filter(field => typeof event[field] === 'string').map(field => [field, event[field]])))
    }
    const attached = [...definitions.values()]
    const matched = new Set(attached.map(event => `${String(event.category)}^${String(event.action)}^${String(event.label)}`))
    const missing = [...keys.values()].filter(key => !matched.has(key)).length
    const incomplete = unresolvedRows > 0 || missing > 0
    return {
      data: { ...base, status: incomplete ? 'partial' : 'attached', game_id: game, definitions: attached, unmatched_keys: missing, unresolved_rows: unresolvedRows },
      warnings: incomplete ? warning('EVENT_DESCRIPTIONS_INCOMPLETE', 'Some result rows have no matching non-empty description or recoverable event key. Do not infer their measurement semantics.') : []
    }
  } catch (error) {
    return {
      data: { ...base, status: 'failed', game_id: game, error_code: failureCode(error) },
      warnings: warning('EVENT_DEFINITIONS_LOOKUP_FAILED', 'Current event descriptions could not be retrieved completely. Analytics rows are preserved; inspect definitions separately with poki game-events list --game GAME_ID --all.')
    }
  }
}
