import assert from 'node:assert/strict'
import test from 'node:test'

import { ApiClient } from '../src/api'
import { isAnalyticsTimestamp, readEventDefinitions, readSourceFreshness } from '../src/data/evidence'
import { queryDescription, validateDataQuery } from '../src/data/grammar'
import { validateDataQuerySemantics } from '../src/data/semantics'
import { apiHarness, jsonApi, parseToon, requestBody, runCli } from './helpers'

const source = 'dbt_p4d_game_events_v2'
const timestamp = '2026-09-17T09:00:00+02:00'
const event = {
  type: 'game_events',
  id: 'event-1',
  attributes: {
    game_id: 'game-1',
    category: 'perf',
    action: 'fps',
    label: '60-plus',
    description: 'Sent once after 90 seconds of visible play; excludes early departures.',
    updated_at: '2026-09-17T07:00:00Z',
    private_field: 'private-secret'
  }
}
const eventRow = { category: 'perf', action: 'fps', label: '60-plus' }
const eventQuery = {
  from: source,
  select: [{ field: 'category' }, { field: 'action' }, { field: 'label' }],
  where: { expressions: [['p4d_game_id', '==', 'game-1']] }
}

function fakeApi (handler: (url: URL, init: RequestInit) => Response | Promise<Response>): ApiClient {
  return new ApiClient('https://example.invalid', {
    readAuth: () => ({ access_type: 'Bearer', access_token: 'test-token' }),
    fetch: (async (input: string | URL | Request, init?: RequestInit) => await handler(new URL(String(input)), init ?? {})) as typeof fetch
  })
}

function response (body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

void test('the lifecycle example counts completing gameplays separately from repeated occurrences', () => {
  const example = queryDescription.game_events.query_example
  const query = { from: source, select: example.backend_select, where: { expressions: example.backend_filters } }
  validateDataQuery(query)
  validateDataQuerySemantics(query)
  assert.deepEqual(example.backend_filters.at(-1), ['label', '==', ''])
  assert.deepEqual(example.backend_select.map(select => select.field), ['completes', 'total_completes'])
})

void test('freshness distinguishes matching refreshes, missing metadata, malformed timestamps, and failures', async () => {
  const envelope = (rows: unknown[], total = rows.length): unknown => ({ total, header: ['table_name', 'last_updated_at'], rows })
  const cases = [
    { body: envelope([{ table_name: source, last_updated_at: timestamp }]), status: 'checked' },
    { body: envelope([]), status: 'missing' },
    { body: envelope([{ table_name: 'another_table', last_updated_at: timestamp }]), status: 'failed' },
    ...['not-a-date', '', '2026-02-30 09:00:00', '2026-09-17 25:00:00'].map(value => ({ body: envelope([{ table_name: source, last_updated_at: value }]), status: 'failed' })),
    { body: envelope([{ table_name: source, last_updated_at: timestamp }], 2), status: 'failed' },
    { body: { total: 0, header: ['table_name', 'last_updated_at', 'last_updated_at'], rows: [] }, status: 'failed' },
    { body: { total: 1, header: ['table_name'], rows: [{ table_name: source, last_updated_at: timestamp }] }, status: 'failed' },
    { body: { diagnostic: 'private-secret' }, status: 'failed', http: 403 }
  ]
  for (const entry of cases) {
    let requests = 0
    const result = await readSourceFreshness(fakeApi((url, init) => {
      requests++
      assert.equal(url.pathname, '/_data')
      const body = JSON.parse(String(init.body))
      assert.deepEqual(body.where, { expressions: [['table_name', '==', source]] })
      return response(entry.body, entry.http)
    }), source, {})
    assert.equal(requests, 1)
    assert.equal(result.data.status, entry.status)
    assert.equal(result.data.time_zone, 'Europe/Amsterdam')
    assert.equal(result.data.last_updated_at, entry.status === 'checked' ? timestamp : undefined)
    assert.equal(result.warnings.length, entry.status === 'checked' ? 0 : 1)
    assert.doesNotMatch(JSON.stringify(result), /private-secret/)
  }
})

void test('freshness accepts API timestamp offsets and precision while rejecting invalid dates', async () => {
  for (const value of [
    timestamp,
    '2026-01-17T09:00:00+01:00',
    '2026-09-17T07:00:00Z',
    '2026-09-17T07:00:00.123456789Z',
    '2026-09-17T23:59:59.123456789-05:30',
    '2024-02-29T00:00:00+02:00',
    '2026-09-17 09:00:00'
  ]) {
    const result = await readSourceFreshness(fakeApi(() => response({
      total: 1,
      header: ['table_name', 'last_updated_at'],
      rows: [{ table_name: source, last_updated_at: value }]
    })), source, {})
    assert.equal(result.data.status, 'checked', value)
    assert.equal(result.data.last_updated_at, value)
    assert.deepEqual(result.warnings, [])
  }
  for (const value of [
    '2026-02-30T09:00:00+02:00',
    '2026-02-29T09:00:00Z',
    '2026-09-17T24:00:00Z',
    '2026-09-17T09:60:00Z',
    '2026-09-17T09:00:60Z',
    '2026-09-17T09:00:00+24:00',
    '2026-09-17T09:00:00+02:60',
    '2026-09-17T09:00:00',
    '2026-09-17T09:00:00.Z',
    '2026-09-17',
    null,
    0
  ]) assert.equal(isAnalyticsTimestamp(value), false, String(value))
})

void test('event descriptions match aliased rows, paginate, deduplicate, and omit unrelated/private fields', async () => {
  const paths: string[] = []
  const result = await readEventDefinitions(fakeApi(url => {
    paths.push(url.pathname + url.search)
    return response(url.searchParams.get('page[number]') === '2'
      ? { data: [event], links: { next: null } }
      : { data: [{ ...event, id: 'unrelated', attributes: { ...event.attributes, action: 'other' } }], links: { next: '/games/game-1/game_events?page[number]=2' } })
  }), {
    ...eventQuery,
    select: [{ field: `${source}.category`, alias: 'kind' }, { field: 'action', alias: 'what' }, { field: 'label', alias: 'bucket' }]
  }, [{ kind: 'perf', what: 'fps', bucket: '60-plus' }, { kind: 'perf', what: 'fps', bucket: '60-plus' }], {})
  assert.equal(paths.length, 2)
  assert.ok(paths.every(path => path.startsWith('/games/game-1/game_events?')))
  assert.equal(result?.data.status, 'attached')
  assert.equal(result?.data.historical_applicability, 'unverified')
  assert.deepEqual(result?.data.definitions, [{
    id: event.id,
    game_id: 'game-1',
    ...eventRow,
    description: event.attributes.description,
    updated_at: event.attributes.updated_at
  }])
  assert.doesNotMatch(JSON.stringify(result), /private-secret|unrelated/)
})

void test('fixed normalized lifecycle keys resolve to current definitions', async () => {
  const lifecycle = { ...event, attributes: { ...event.attributes, category: 'progress', action: 'level_1', label: '' } }
  const api = fakeApi(() => response({ data: [lifecycle], links: { next: null } }))
  for (const from of [source, 'dbt_p4d_game_events_times_v2']) {
    const query = {
      from,
      select: [{ field: from === source ? 'total_completes' : 'gameplays', aggregate: 'sum' }],
      where: { expressions: [['p4d_game_id', 'in', ['game-1']], ...queryDescription.game_events.query_example.backend_filters, ...(from === source ? [] : [['time_type', '==', 'complete']])] }
    }
    validateDataQuery(query)
    validateDataQuerySemantics(query)
    const result = await readEventDefinitions(api, query, [{ [query.select[0].field]: 7 }], {})
    assert.equal(result?.data.status, 'attached')
    assert.equal((result?.data.definitions as unknown[]).length, 1)
  }
})

void test('funnel lifecycle keys share a definition without changing rows or custom labels', async () => {
  const lifecycle = { ...event, id: 'lifecycle', attributes: { ...event.attributes, category: 'progress', action: 'level_1', label: '' } }
  const api = fakeApi(() => response({ data: [lifecycle, event], links: { next: null } }))
  const query = { ...eventQuery, from: 'dbt_p4d_game_events_funnel_v2', select: [{ field: 'event', alias: 'key' }] }
  const rows = ['', 'start', 'complete', 'fail', 'visible', 'interact'].map(label => ({ key: `progress^level_1^${label}` }))
  rows.push({ key: 'perf^fps^60-plus' })
  const originalRows = structuredClone(rows)
  validateDataQuery(query)
  validateDataQuerySemantics(query)
  const result = await readEventDefinitions(api, query, rows, {})
  assert.equal(result?.data.status, 'attached')
  assert.equal(result?.data.unmatched_keys, 0)
  assert.equal(result?.data.unresolved_rows, 0)
  assert.deepEqual((result?.data.definitions as Array<Record<string, unknown>>).map(definition => [definition.id, definition.label]), [['lifecycle', ''], [event.id, '60-plus']])
  assert.deepEqual(result?.warnings, [])
  assert.deepEqual(rows, originalRows)

  const fixedQuery = {
    ...query,
    select: [{ aggregate: 'count', alias: 'count' }],
    where: { expressions: [...eventQuery.where.expressions, ['event', '==', 'progress^level_1^complete']] }
  }
  validateDataQuery(fixedQuery)
  validateDataQuerySemantics(fixedQuery)
  const fixed = await readEventDefinitions(api, fixedQuery, [{ count: 7 }], {})
  assert.equal(fixed?.data.status, 'attached')
  assert.equal((fixed?.data.definitions as unknown[]).length, 1)

  const missing = await readEventDefinitions(api, query, [
    { key: 'progress^level_2^start' },
    { key: 'progress^level_2^complete' },
    { key: 'perf^fps^60-PLUS' }
  ], {})
  assert.equal(missing?.data.status, 'partial')
  assert.equal(missing?.data.unmatched_keys, 3)
  assert.deepEqual(missing?.data.definitions, [])
})

void test('event lookups skip unknown or contradictory scope and computed or missing event keys', async () => {
  let requests = 0
  const api = fakeApi(() => { requests++; return response({ data: [event] }) })
  const scopes = [
    undefined,
    { expressions: [['p4d_game_id', 'in', ['game-1', 'game-2']]] },
    { expressions: [['p4d_game_id', '==', 'game-1'], ['p4d_game_id', '==', 'game-2']] },
    { expressions: [{ operator: 'or', expressions: [['p4d_game_id', '==', 'game-1'], ['p4d_game_id', '==', 'game-2']] }] },
    { expressions: [['p4d_game_id', '==', 'game-1']] }
  ]
  for (const where of scopes) {
    const result = await readEventDefinitions(api, { ...eventQuery, select: [{ field: 'category' }], where }, [eventRow], { game: 'game-1' })
    assert.equal(result?.data.status, 'skipped')
  }
  const computed = await readEventDefinitions(api, {
    ...eventQuery, select: [{ field: 'category' }, { field: 'action' }, { field: 'label', aggregate: 'any', alias: 'bucket' }]
  }, [{ ...eventRow, bucket: '60-plus' }], {})
  assert.equal(computed?.data.status, 'skipped')
  const empty = await readEventDefinitions(api, eventQuery, [], {})
  assert.deepEqual(empty?.warnings, [])
  assert.equal(requests, 0)
})

void test('common OR constraints and exact aliased filters establish one game without guessing', async () => {
  const query = {
    ...eventQuery,
    select: [...eventQuery.select, { field: 'p4d_game_id', alias: 'game' }],
    where: {
      expressions: [{
        operator: 'or',
        expressions: [
          { expressions: [['game', '==', 'game-1'], ['user_new', '==', 1]] },
          { expressions: [['game', '==', 'game-1'], ['user_new', '==', 0]] }
        ]
      }]
    }
  }
  const result = await readEventDefinitions(fakeApi(() => response({ data: [event], links: { next: null } })), query, [eventRow], {})
  assert.equal(result?.data.status, 'attached')
})

void test('missing descriptions, permission failures, and incomplete definition scans remain explicit', async () => {
  const missing = await readEventDefinitions(fakeApi(() => response({ data: [{ ...event, attributes: { ...event.attributes, description: '' } }] })), eventQuery, [eventRow], {})
  assert.equal(missing?.data.status, 'partial')
  assert.equal(missing?.data.unmatched_keys, 1)
  assert.deepEqual(missing?.data.definitions, [])
  for (const failure of [
    () => response({ diagnostic: 'private-secret' }, 403),
    () => response({ data: [event], links: { next: 'https://elsewhere.invalid/secret' } }),
    () => response({ data: [event], links: { next: '/games/game-1/game_events?page[number]=2' } }),
    () => response({ data: [{ ...event, attributes: { ...event.attributes, game_id: 'game-2' } }] })
  ]) {
    const result = await readEventDefinitions(fakeApi(failure), eventQuery, [eventRow], {})
    assert.equal(result?.data.status, 'failed')
    assert.deepEqual(result?.data.definitions, [])
    assert.equal(result?.warnings[0].blocking, false)
    assert.doesNotMatch(JSON.stringify(result), /private-secret|elsewhere/)
  }
})

void test('metadata timeouts honor the requested deadline without throwing away the lookup result', async () => {
  const api = fakeApi(async (_url, init) => await new Promise<Response>((resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(new Error('private-timeout-detail')), { once: true })
  }))
  const freshness = await readSourceFreshness(api, source, { timeoutMs: 5 })
  assert.equal(freshness.data.error_code, 'API_TIMEOUT')
  const definitions = await readEventDefinitions(api, eventQuery, [eventRow], { timeoutMs: 5 })
  assert.equal(definitions?.data.error_code, 'API_TIMEOUT')
  assert.doesNotMatch(JSON.stringify([freshness, definitions]), /private-timeout-detail/)
})

void test('structured execution enriches events; CSV and offline validation make no auxiliary requests', async t => {
  let primary = 0
  let freshness = 0
  let definitions = 0
  let denied = false
  let empty = false
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  const { env } = await apiHarness(t, async (req, res) => {
    if (req.method === 'GET') {
      definitions++
      jsonApi(res, { data: [event], links: { next: null } }, denied ? 403 : 200)
      return
    }
    const body = await requestBody(req)
    if (body.from === 'table_update_times') {
      freshness++
      jsonApi(res, { total: 1, header: ['table_name', 'last_updated_at'], rows: [{ table_name: source, last_updated_at: timestamp }] }, denied ? 403 : 200)
    } else {
      primary++
      if (req.url === '/_data?csv=') {
        res.end(Buffer.from('category,action,label\nperf,fps,60-plus\n').toString('base64'))
      } else {
        jsonApi(res, { total: empty ? 0 : 1, header: ['category', 'action', 'label'], rows: empty ? [] : [eventRow] })
      }
    }
  }, 'analytics-metadata')
  const command = ['data', 'query', '--query', JSON.stringify(eventQuery)]
  const json = await runCli([...command, '--format', 'json'], { env })
  const toon = await runCli([...command, '--format', 'toon'], { env })
  assert.equal(json.code, 0, json.stderr)
  assert.equal(toon.code, 0, toon.stderr)
  const result = JSON.parse(json.stdout)
  assert.deepEqual(parseToon(toon.stdout), result)
  assert.deepEqual(result.rows, [eventRow])
  assert.equal(result.meta.evidence.freshness.status, 'checked')
  assert.equal(result.meta.evidence.completeness.ingestion_completeness, 'unknown')
  assert.equal(result.meta.evidence.interpretation.event_definitions.status, 'attached')
  const csv = await runCli([...command, '--format', 'csv'], { env })
  assert.equal(csv.stdout, 'category,action,label\nperf,fps,60-plus\n')
  const offline = await runCli([...command, '--validate-only'], { env })
  assert.equal(offline.code, 0, offline.stderr)
  assert.deepEqual([primary, freshness, definitions], [3, 2, 2])
  const recipe = await runCli(['data', 'run', 'all-game-events', '--game', 'game-1', '--team', 'team-1', '--from-date', '2026-09-17', '--to-date', '2026-09-17', '--format', 'json'], { env })
  assert.equal(recipe.code, 0, recipe.stderr)
  assert.equal(JSON.parse(recipe.stdout).meta.evidence.recipe, 'all-game-events')
  assert.equal(JSON.parse(recipe.stdout).meta.evidence.interpretation.event_definitions.status, 'attached')
  empty = true
  const emptyResult = await runCli([...command, '--format', 'json'], { env })
  assert.equal(emptyResult.code, 0, emptyResult.stderr)
  assert.deepEqual(JSON.parse(emptyResult.stdout).rows, [])
  assert.equal(JSON.parse(emptyResult.stdout).meta.evidence.freshness.status, 'checked')
  assert.deepEqual([primary, freshness, definitions], [5, 4, 3])
  empty = false
  denied = true
  const degraded = await runCli([...command, '--format', 'json'], { env })
  assert.equal(degraded.code, 0, degraded.stderr)
  assert.deepEqual(JSON.parse(degraded.stdout).rows, [eventRow])
  assert.deepEqual(JSON.parse(degraded.stdout).meta.evidence.warnings.map((item: { code: string }) => item.code), ['FRESHNESS_LOOKUP_FAILED', 'EVENT_DEFINITIONS_LOOKUP_FAILED'])
  denied = false
  const listing = await runCli(['game-events', 'list', '--game', 'game-1', '--format', 'json'], { env })
  assert.equal(listing.code, 0, listing.stderr)
  assert.equal(JSON.parse(listing.stdout).data[0].description, event.attributes.description)
})
