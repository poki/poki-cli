import assert from 'node:assert/strict'
import { encode } from '@toon-format/toon'
import test from 'node:test'

import { apiHarness, parseToon, requestBody, runCli } from './helpers'

// Catalog invariants are checked at unit level in test/data.test.ts; this test
// checks that the CLI serves the bundled snapshot structurally.
void test('offline data discovery omits removed access metadata and serves the bundled snapshot', async () => {
  const tables = await runCli(['data', 'tables', '--format', 'json'])
  assert.equal(tables.code, 0, tables.stderr)
  assert.equal(tables.stderr, '')
  assert.doesNotMatch(tables.stdout, /role_notes|team_bound/)
  const tableList = JSON.parse(tables.stdout)
  assert.ok(tableList.meta.total > 0)
  assert.equal(tableList.meta.total, Number(tableList.meta.top_level) + Number(tableList.meta.join_only))
  assert.equal(typeof tableList.meta.join_policy.unsupported, 'string')
  assert.equal(tableList.meta.date_time_zone, 'Europe/Amsterdam')
  assert.equal(tableList.meta.semantic_contract_version, 1)
  assert.equal(tableList.data[0].column_count, undefined)
  assert.ok(Array.isArray(tableList.data[0].grain_fields))
  assert.equal(typeof tableList.data[0].grain, 'string')
  assert.equal(typeof tableList.data[0].population, 'string')

  const fullTables = await runCli(['data', 'tables', '--full', '--format', 'json'])
  const fullTable = JSON.parse(fullTables.stdout).data[0]
  assert.equal(typeof fullTable.column_count, 'number')
  assert.ok(fullTable.columns.every((column: Record<string, unknown>) => typeof column.aggregation === 'object'))

  const events = await runCli(['data', 'table', 'dbt_p4d_game_events_v2', '--format', 'json'])
  assert.equal(events.code, 0, events.stderr)
  assert.equal(events.stderr, '')
  assert.doesNotMatch(events.stdout, /role_notes|team_bound/)
  const eventTable = JSON.parse(events.stdout).data
  assert.equal(typeof eventTable.description, 'string')
  assert.deepEqual(eventTable.grain_fields, ['date', 'p4d_game_id', 'p4d_version_id', 'team_id', 'category', 'action', 'label', 'user_new', 'device_category'])
  assert.deepEqual(eventTable.field_terminology.mappings, [
    { frontend_name: 'Category', backend_field: 'category' },
    { frontend_name: 'What', backend_field: 'action' },
    { frontend_name: 'Action', backend_field: 'label' }
  ])
  assert.ok(eventTable.columns.length > 0)
  assert.ok(eventTable.columns.every((column: { name?: unknown, summary?: unknown, aggregation?: unknown }) => {
    return typeof column.name === 'string' && column.name !== '' && typeof column.summary === 'string' && column.summary !== '' && typeof column.aggregation === 'object'
  }))

  const metric = await runCli(['data', 'metric', 'gameplays_per_day', '--format', 'json'])
  assert.equal(metric.code, 0, metric.stderr)
  const metricDocument = JSON.parse(metric.stdout).data
  assert.deepEqual(metricDocument.supported_tables, ['dbt_p4d_gameplays', 'dbt_p4d_games_overview'])
  assert.deepEqual(metricDocument.required_dimensions, [])
  assert.deepEqual(metricDocument.table_recommendations.map((table: { name: string }) => table.name), metricDocument.supported_tables)
  assert.ok(metricDocument.table_recommendations.every((table: { grain?: unknown, grain_fields?: unknown, population?: unknown, required_dimensions?: unknown }) => {
    return typeof table.grain === 'string' && Array.isArray(table.grain_fields) && typeof table.population === 'string' && Array.isArray(table.required_dimensions)
  }))
  const peerMetric = await runCli(['data', 'metric', 'netlib_connected_peer_pairs', '--format', 'json'])
  const peerMetricDocument = JSON.parse(peerMetric.stdout).data
  assert.deepEqual(peerMetricDocument.required_dimensions, ['hour', 'p4d_game_id'])
  assert.deepEqual(peerMetricDocument.table_recommendations[0].required_dimensions, ['hour', 'p4d_game_id'])

  const column = await runCli(['data', 'column', 'dbt_p4d_game_events_v2', 'gameplays', '--format', 'json'])
  assert.equal(column.code, 0, column.stderr)
  const columnDocument = JSON.parse(column.stdout).data.column
  assert.equal(typeof columnDocument.summary, 'string')
  assert.equal(columnDocument.aggregation.kind, 'distinct_count')
  assert.deepEqual(columnDocument.aggregation.required_dimensions.all_of, ['category', 'action', 'label'])

  const eventAction = await runCli(['data', 'column', 'dbt_p4d_game_events_v2', 'label', '--format', 'json'])
  const eventActionDocument = JSON.parse(eventAction.stdout).data
  assert.equal(eventActionDocument.column.frontend_name, 'Action')
  assert.equal(eventActionDocument.field_terminology.mappings[1].backend_field, 'action')
  assert.match(eventActionDocument.column.summary, /Frontend term: Action.*Backend analytics field: label/i)

  const context = await runCli(['data', 'column', 'dbt_p4d_gameplays', 'context', '--format', 'json'])
  const contextColumn = JSON.parse(context.stdout).data.column
  assert.deepEqual(contextColumn.enum_values, ['playground', 'external'])
  assert.match(contextColumn.summary, /playground.*gameplay occurred on Poki.*external otherwise/i)

  const overview = await runCli(['data', 'describe', '--format', 'json'])
  const overviewDocument = JSON.parse(overview.stdout)
  for (const topic of ['conditions', 'joins', 'aggregation', 'game-events', 'timezone']) {
    assert.ok(overviewDocument.topics.includes(topic), topic)
  }
  assert.equal(typeof overviewDocument.joins.unsupported, 'string')
  assert.equal(overviewDocument.timezone.time_zone, 'Europe/Amsterdam')
  assert.equal(overviewDocument.conditions, undefined)
  const conditions = await runCli(['data', 'describe', 'conditions', '--format', 'json'])
  const conditionDocument = JSON.parse(conditions.stdout).conditions
  assert.ok(conditionDocument.operators.includes('ilike'))
  assert.match(conditionDocument.expression, /select-statement expression/)
  assert.match(conditionDocument.right_operands.in.right, /not a database subquery/)
  assert.match(conditionDocument.right_operands.like.right, /dynamic pattern/)
  const timezone = await runCli(['data', 'describe', 'timezone', '--format', 'json'])
  assert.equal(JSON.parse(timezone.stdout).timezone.time_zone, 'Europe/Amsterdam')
  assert.match(JSON.parse(timezone.stdout).timezone.contrast, /UTC/)
  const aggregation = await runCli(['data', 'describe', 'aggregation', '--format', 'json'])
  assert.match(JSON.parse(aggregation.stdout).aggregation.failure, /UNKNOWN_DATA_REFERENCE.*INCOMPATIBLE_GRAIN/)
  const gameEvents = await runCli(['data', 'describe', 'game-events', '--format', 'json'])
  assert.deepEqual(JSON.parse(gameEvents.stdout).game_events.field_mapping[2], { frontend_name: 'Action', backend_field: 'label', measure_argument: 3 })
  const complete = await runCli(['data', 'describe', 'all', '--format', 'json'])
  assert.equal(JSON.parse(complete.stdout).limits.default_limit, 10000)
})

void test('installed discovery is self-contained and exposes no private source references', async () => {
  const provenanceResult = await runCli(['data', 'provenance', '--format', 'json'])
  assert.equal(provenanceResult.code, 0, provenanceResult.stderr)
  const provenance = JSON.parse(provenanceResult.stdout).data
  assert.equal(provenance.documentation.bundled, true)
  assert.equal(provenance.documentation.external_sources_required, false)
  assert.equal(provenance.semantic_contract_version, 1)
  assert.match(provenance.cli_schema_authority, /bundled catalog.*authoritative/i)
  assert.match(provenance.api_authority, /permissions.*execution/i)
  assert.equal('sources' in provenance, false)
  assert.equal('revision' in provenance, false)
  assert.equal('catalog_version' in provenance, false)
  assert.equal('generated_at' in provenance, false)

  const fields = await runCli(['playtest-recordings', 'fields', '--format', 'json'])
  assert.equal(fields.code, 0, fields.stderr)
  const fieldDocument = JSON.parse(fields.stdout)
  assert.equal(fieldDocument.meta.timestamp_time_zone, 'UTC')
  assert.ok(fieldDocument.data.fields.length > 0)
  assert.ok(fieldDocument.data.fields.every((field: Record<string, unknown>) => {
    return ['name', 'type', 'nullable', 'mutability', 'relationship', 'source', 'summary']
      .every(key => Object.prototype.hasOwnProperty.call(field, key))
  }))

  const outputs = [
    provenanceResult.stdout,
    (await runCli(['help', '--all', '--format', 'json'])).stdout,
    (await runCli(['data', 'describe', 'all', '--format', 'json'])).stdout,
    fields.stdout
  ].join('\n')
  const internalRepositories = [`poki-${'devs'}`, `mother${'ship'}`]
  assert.doesNotMatch(outputs, new RegExp(`github\\.com/poki/(?:${internalRepositories.join('|')})|poki/(?:${internalRepositories.join('|')})|${internalRepositories[1]}`, 'i'))
})

void test('data query supports JSON and TOON stdin plus decoded CSV', async t => {
  // The test server callback intentionally owns its async request lifecycle.
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  const { env } = await apiHarness(t, async (req, res) => {
    const body = await requestBody(req)
    assert.equal(body.from, 'dbt_p4d_gameplays')
    if (req.url === '/_data?csv=') {
      res.writeHead(200, { 'Content-Type': 'text/csv;base64' })
      res.end(Buffer.from('gameplays\n42\n').toString('base64'))
      return
    }
    if (req.url === '/_data') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        total: 1,
        header: ['gameplays', 'p4d_version_id', 'selected_payload'],
        rows: [{
          gameplays: 42,
          p4d_version_id: 'version-1',
          selected_payload: { nested: { value: 'preserved-selected-value' } },
          private_row_key: 'private-row-secret'
        }],
        included: {
          game_versions: {
            'version-1': { type: 'game_versions', id: 'version-1', attributes: { label: 'v1', internal_build_path: '/private/build' } },
            'version-2': { type: 'game_versions', id: 'wrong-version', attributes: { label: 'wrong identity', internal_build_path: '/private/build' } },
            'version-3': 'malformed private response'
          },
          auditlog: {
            'audit-1': { type: 'auditlog', id: 'audit-1', attributes: { payload: 'private audit data' } }
          }
        },
        meta: { private_backend_meta: 'private-meta-secret' },
        private_document_key: 'private-document-secret'
      }))
      return
    }
    res.writeHead(500)
    res.end()
  }, 'data')
  const query = JSON.stringify({ from: 'dbt_p4d_gameplays', select: [{ field: 'gameplays' }] })

  const csv = await runCli(['data', 'query', '--query', query, '--format', 'csv'], { env })
  assert.equal(csv.code, 0, csv.stderr)
  assert.equal(csv.stdout, 'gameplays\n42\n')

  const json = await runCli(['data', 'query', '--query', query, '--format', 'json'], { env })
  assert.equal(json.code, 0, json.stderr)
  const jsonDocument = JSON.parse(json.stdout)
  assert.deepEqual(jsonDocument, {
    total: 1,
    header: ['gameplays', 'p4d_version_id', 'selected_payload'],
    rows: [{
      gameplays: 42,
      p4d_version_id: 'version-1',
      selected_payload: { nested: { value: 'preserved-selected-value' } }
    }],
    included: {
      game_versions: {
        'version-1': { type: 'game_versions', id: 'version-1', label: 'v1' },
        'version-2': { type: 'game_versions', id: 'version-2' },
        'version-3': { type: 'game_versions', id: 'version-3' }
      }
    },
    meta: {
      evidence: {
        query: JSON.parse(query),
        recipe: null,
        source: 'dbt_p4d_gameplays',
        requested: { limit: 10000, offset: 0 },
        returned: { rows: 1, total_rows: 1 },
        completeness: { complete: true, has_more: false, omitted_before_offset: false },
        time_zone: 'Europe/Amsterdam',
        semantic_validation: { status: 'passed', contract_version: 1 },
        interpretation: {
          source_contract: {
            grain: 'One row per date, game, version, device category, country, context, and team.',
            grain_fields: ['date', 'p4d_game_id', 'p4d_game_version_id', 'device_category', 'country_id', 'context', 'team_id'],
            population: 'Gameplay sessions observed through Poki SDK gameplay events.'
          },
          selected_measure_contracts: [{
            output: 'gameplays',
            source: { table: 'dbt_p4d_gameplays', field: 'gameplays' },
            description: 'Number of gameplay sessions in the dimension row.',
            aggregation: {
              kind: 'additive_measure',
              unit: 'gameplay sessions',
              allowed_aggregates: ['sum'],
              guidance: 'Sum gameplay sessions over compatible rows; do not average pre-aggregated totals.'
            }
          }],
          notes: [],
          warnings: []
        },
        freshness: { status: 'not_checked', command: 'poki data freshness' },
        warnings: [{
          code: 'FRESHNESS_NOT_CHECKED',
          message: 'This query result does not establish source freshness; run poki data freshness separately.',
          blocking: false
        }]
      }
    }
  })
  assert.doesNotMatch(json.stdout, /private-(?:row|meta|document)-secret/)

  const toonQuery = encode({ from: 'dbt_p4d_gameplays', select: [{ field: 'gameplays' }] })
  const toon = await runCli(['data', 'query', '--query', '-'], { env, stdin: toonQuery })
  assert.equal(toon.code, 0, toon.stderr)
  assert.deepEqual(parseToon(toon.stdout), jsonDocument)

  const queryOnly = await runCli([
    'data', 'recipe', 'game-gameplays', '--team', 'team-1', '--game', 'game-1',
    '--from-date', '2026-07-01', '--to-date', '2026-07-31', '--query-only'
  ])
  assert.equal(queryOnly.code, 0, queryOnly.stderr)
  assert.equal(typeof parseToon(queryOnly.stdout).from, 'string')
  const piped = await runCli(['data', 'query', '--query', '-'], { env, stdin: queryOnly.stdout })
  assert.equal(piped.code, 0, piped.stderr)
  assert.equal(parseToon(piped.stdout).total, 1)

  const unresolved = await runCli(['data', 'recipe', 'game-gameplays', '--query-only'])
  assert.equal(unresolved.code, 0, unresolved.stderr)
  const rejected = await runCli(['data', 'query', '--query', '-', '--format', 'json'], { env, stdin: unresolved.stdout })
  assert.equal(rejected.code, 2)
  assert.equal(JSON.parse(rejected.stderr).error.code, 'INVALID_INPUT')
  assert.match(JSON.parse(rejected.stderr).error.message, /unresolved recipe placeholders/)

  // Only names a recipe declares are placeholders: angle brackets are ordinary
  // characters in a like pattern and must reach the API unchanged.
  const literal = await runCli(['data', 'query', '--query', JSON.stringify({
    from: 'dbt_p4d_gameplays',
    select: [{ field: 'gameplays', aggregate: 'sum', alias: 'gameplays' }],
    where: { expressions: [['p4d_game_id', 'ilike', '%<TAG>%']] },
    limit: 1
  }), '--format', 'json'], { env })
  assert.equal(literal.code, 0, literal.stderr)
  assert.equal(JSON.parse(literal.stdout).meta.evidence.query.where.expressions[0][2], '%<TAG>%')
})

void test('unsafe event gameplay rollups fail locally in every query mode and safe label handling passes', async t => {
  let requests = 0
  // The test server callback intentionally owns its async request lifecycle.
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  const { env } = await apiHarness(t, async (req, res) => {
    requests++
    await requestBody(req)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ total: 0, header: ['gameplays'], rows: [] }))
  }, 'data-semantic-event')
  const unsafeQuery = {
    from: 'dbt_p4d_game_events_v2',
    select: [
      { field: 'p4d_version_id' },
      { field: 'category' },
      { field: 'action' },
      { field: 'gameplays', aggregate: 'sum' }
    ],
    where: {
      expressions: [
        ['team_id', '==', '788d4cf8-9408-47bc-89b0-a1fd06e250ad'],
        ['p4d_game_id', '==', 'e2c8dad4-6071-47ca-84b5-dc2f05a5f80f'],
        ['date', '>=', '2026-07-01'],
        ['date', '<=', '2026-08-31']
      ]
    },
    group: ['p4d_version_id', 'category', 'action'],
    limit: 5000
  }
  const serialized = JSON.stringify(unsafeQuery)
  const invocations = [
    { args: ['data', 'query', '--query', serialized, '--format', 'json'], parse: (value: string) => JSON.parse(value) },
    { args: ['data', 'query', '--query', '-', '--format', 'toon'], stdin: encode(unsafeQuery), parse: parseToon },
    { args: ['data', 'query', '--query', serialized, '--format', 'csv'], parse: parseToon },
    { args: ['data', 'query', '--query', serialized, '--validate-only', '--format', 'json'], parse: (value: string) => JSON.parse(value) }
  ]
  for (const invocation of invocations) {
    const result = await runCli(invocation.args, { env, ...(invocation.stdin === undefined ? {} : { stdin: invocation.stdin }) })
    assert.equal(result.code, 2, result.stderr)
    assert.equal(result.stdout, '')
    const error = invocation.parse(result.stderr).error
    assert.equal(error.code, 'INCOMPATIBLE_GRAIN')
    assert.equal(error.details.violations[0].path, 'select[3].field')
    assert.equal(error.details.violations[0].field, 'gameplays')
    assert.deepEqual(error.details.violations[0].missing_dimensions, ['label'])
  }
  assert.equal(requests, 0)

  const groupedLabel = structuredClone(unsafeQuery)
  groupedLabel.select.splice(3, 0, { field: 'label' })
  groupedLabel.group.push('label')
  const groupedValidation = await runCli(['data', 'query', '--query', JSON.stringify(groupedLabel), '--validate-only', '--format', 'json'], { env })
  assert.equal(groupedValidation.code, 0, groupedValidation.stderr)
  const validation = JSON.parse(groupedValidation.stdout)
  assert.equal(validation.local_structure_valid, true)
  assert.equal(validation.local_semantics_valid, true)
  assert.equal(validation.api_validated, false)
  assert.equal(validation.meta.contacted_api, false)
  assert.equal(validation.meta.validation_scope, 'local_structure_and_semantics')
  assert.equal(validation.meta.semantic_contract_version, 1)
  assert.equal(requests, 0)

  const filteredLabel = structuredClone(unsafeQuery)
  filteredLabel.where.expressions.push(['label', '==', ''])
  const executed = await runCli(['data', 'query', '--query', JSON.stringify(filteredLabel), '--format', 'json'], { env })
  assert.equal(executed.code, 0, executed.stderr)
  const eventEvidence = JSON.parse(executed.stdout).meta.evidence
  assert.equal(eventEvidence.semantic_validation.contract_version, 1)
  assert.deepEqual(eventEvidence.interpretation.field_terminology.mappings, [
    { frontend_name: 'Category', backend_field: 'category' },
    { frontend_name: 'What', backend_field: 'action' },
    { frontend_name: 'Action', backend_field: 'label' }
  ])
  assert.deepEqual(eventEvidence.interpretation.selected_measure_contracts[0].aggregation.required_dimensions, { all_of: ['category', 'action', 'label'] })
  assert.match(eventEvidence.interpretation.notes[0].message, /label field is normalized to an empty string/i)
  assert.equal(eventEvidence.interpretation.warnings[0].code, 'DISTINCT_COUNT_GRAIN')
  assert.match(eventEvidence.interpretation.warnings[0].message, /multiple event keys.*unique cross-key total is unavailable/i)
  assert.equal(requests, 1)

  const lifecycle = await runCli([
    'data', 'run', 'game-event-starts-export',
    '--team', 'team-1',
    '--game', 'game-1',
    '--from-date', '2026-07-01',
    '--to-date', '2026-07-31',
    '--validate-only',
    '--format', 'json'
  ], { env })
  assert.equal(lifecycle.code, 0, lifecycle.stderr)
  assert.deepEqual(JSON.parse(lifecycle.stdout).query.where.expressions[4], ['label', '==', ''])
  assert.equal(requests, 1)
})

void test('unknown tables, joins, and columns fail closed before execution or validate-only', async t => {
  let requests = 0
  const { env } = await apiHarness(t, (_req, res) => {
    requests++
    res.writeHead(500)
    res.end()
  }, 'data-unknown-reference')
  const queries = [
    { from: 'backend_only_table', select: [{ field: 'value' }] },
    { from: 'dbt_p4d_gameplays', select: [{ field: 'backend_only_column' }] },
    { from: 'dbt_p4d_gameplays', select: [{ field: 'backend_only_join.title' }] }
  ]
  for (const query of queries) {
    for (const validateOnly of [false, true]) {
      const result = await runCli([
        'data', 'query', '--query', JSON.stringify(query), '--format', 'json',
        ...(validateOnly ? ['--validate-only'] : [])
      ], { env })
      assert.equal(result.code, 2, result.stderr)
      assert.equal(result.stdout, '')
      const error = JSON.parse(result.stderr).error
      assert.equal(error.code, 'UNKNOWN_DATA_REFERENCE')
      assert.equal(error.details.violations[0].path, query.from === 'backend_only_table' ? 'from' : 'select[0].field')
    }
  }
  assert.equal(requests, 0)
})

void test('an empty analytics CSV response fails closed instead of printing a zero-byte export', async t => {
  let body: 'empty' | 'whitespace' | 'no_content' | 'rows' = 'empty'
  const { env } = await apiHarness(t, (req, res) => {
    assert.equal(req.url, '/_data?csv=')
    req.resume()
    req.on('end', () => {
      if (body === 'no_content') {
        res.writeHead(204)
        res.end()
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/csv;base64' })
      res.end(body === 'empty' ? '' : Buffer.from(body === 'whitespace' ? ' \n' : 'gameplays\n42\n').toString('base64'))
    })
  }, 'data-empty-csv')
  const query = JSON.stringify({ from: 'dbt_p4d_gameplays', select: [{ field: 'gameplays' }] })

  // A result an agent cannot distinguish from a successful empty export is the
  // one failure it cannot detect, so a missing header row fails closed.
  for (const empty of ['empty', 'whitespace', 'no_content'] as const) {
    body = empty
    const result = await runCli(['data', 'query', '--query', query, '--format', 'csv'], { env })
    assert.equal(result.code, 5, `${empty}: ${result.stderr}`)
    assert.equal(result.stdout, '', empty)
    const error = parseToon(result.stderr).error
    assert.equal(error.code, 'INVALID_API_RESPONSE', empty)
    assert.equal(error.retryable, false, empty)
    assert.equal(error.details.received.kind, 'string', empty)
    assert.equal(typeof error.details.received.length, 'number', empty)
  }

  body = 'rows'
  const csv = await runCli(['data', 'query', '--query', query, '--format', 'csv'], { env })
  assert.equal(csv.code, 0, csv.stderr)
  assert.equal(csv.stdout, 'gameplays\n42\n')
})

void test('data query preserves an exact signed 64-bit funnel hash string in the emitted POST body', async t => {
  let postedBody: Record<string, unknown> | undefined
  // The test server callback intentionally owns its async request lifecycle.
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  const { env } = await apiHarness(t, async (req, res) => {
    assert.equal(req.method, 'POST')
    assert.equal(req.url, '/_data')
    postedBody = await requestBody(req)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ total: 0, header: ['event_hashes'], rows: [] }))
  }, 'data-hash')
  const exactHash = '-8340446448795919230'
  const query = {
    from: 'dbt_p4d_game_events_funnel_v2',
    select: [{
      alias: 'event_hashes',
      aggregate: 'groupUniqArray',
      function: { name: 'toString', args: [{ field: 'event_hash' }] }
    }],
    where: { expressions: [['prefix_hashes', 'has_any_int64', [exactHash]]] }
  }

  const result = await runCli(['data', 'query', '--query', JSON.stringify(query), '--format', 'json'], { env })
  assert.equal(result.code, 0, result.stderr)
  assert.deepEqual(postedBody, query)
  const postedHash = ((postedBody?.where as { expressions: unknown[][] }).expressions[0][2] as unknown[])[0]
  assert.equal(postedHash, exactHash)
  assert.equal(typeof postedHash, 'string')
})

void test('unsafe signed funnel hash shapes fail locally without contacting the API', async t => {
  let requests = 0
  const { env } = await apiHarness(t, (req, res) => {
    requests++
    res.writeHead(500)
    res.end()
  }, 'data-unsafe-hash')
  const exactHash = '-8340446448795919230'
  const unsafeQueries = [
    {
      from: 'dbt_p4d_game_events_funnel_v2',
      select: [{ field: 'event_hash' }]
    },
    {
      from: 'dbt_p4d_game_events_funnel_v2',
      select: [{ field: 'prefix_hashes' }]
    },
    {
      from: 'dbt_p4d_game_events_funnel_v2',
      select: [{ field: 'event_hash', aggregate: 'groupUniqArray', alias: 'event_hashes' }]
    },
    {
      from: 'dbt_p4d_game_events_funnel_v2',
      select: [{ field: 'event' }],
      where: { expressions: [['event_hash', '==', Number(exactHash)]] }
    },
    {
      from: 'dbt_p4d_game_events_funnel_v2',
      select: [{ field: 'event' }],
      where: { expressions: [['prefix_hashes', 'has', exactHash]] }
    },
    {
      from: 'dbt_p4d_game_events_funnel_v2',
      select: [{ field: 'event' }],
      where: { expressions: [[{ function: { name: 'length', args: [{ field: 'prefix_hashes' }] } }, '>', 0]] }
    },
    {
      from: 'dbt_p4d_game_events_funnel_v2',
      select: [{ field: 'event' }],
      where: { expressions: [[{ function: { name: 'toString', args: [{ field: 'event_hash' }] } }, '==', exactHash]] }
    },
    {
      from: 'dbt_p4d_game_events_funnel_v2',
      select: [{ field: 'event' }],
      where: { expressions: [[{ function: { name: 'number', args: [{ field: 'event_hash' }] } }, '==', Number(exactHash)]] }
    },
    {
      from: 'dbt_p4d_game_events_funnel_v2',
      select: [{ field: 'event' }],
      where: { expressions: [['event_hash', '==', { function: { name: 'number', args: [{ constant: exactHash }] } }]] }
    }
  ]

  for (const query of unsafeQueries) {
    const result = await runCli(['data', 'query', '--query', JSON.stringify(query), '--format', 'json'], { env })
    assert.equal(result.code, 2, result.stderr)
    assert.equal(result.stdout, '')
    assert.equal(JSON.parse(result.stderr).error.code, 'INVALID_INPUT')
  }
  assert.equal(requests, 0)
})

void test('analytics evidence exposes partial windows and malformed responses fail closed', async t => {
  let malformed: false | 'total' | 'duplicate_header' = false
  const { env } = await apiHarness(t, (req, res) => {
    assert.equal(req.method, 'POST')
    assert.equal(req.url, '/_data')
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(malformed === 'total'
        ? { total: '5', header: ['gameplays'], rows: [{ gameplays: 10 }], meta: { diagnostic: 'malformed-meta-secret' }, diagnostic: 'malformed-document-secret' }
        : malformed === 'duplicate_header'
          ? { total: 1, header: ['gameplays', 'gameplays'], rows: [{ gameplays: 10 }] }
          : { total: 5, header: ['gameplays'], rows: [{ gameplays: 10 }, { gameplays: 20 }] }))
    })
  }, 'data-evidence')
  const query = JSON.stringify({
    from: 'dbt_p4d_gameplays',
    select: [{ field: 'gameplays' }],
    limit: 2,
    offset: 1
  })

  const partial = await runCli(['data', 'query', '--query', query, '--format', 'json'], { env })
  assert.equal(partial.code, 0, partial.stderr)
  const evidence = JSON.parse(partial.stdout).meta.evidence
  assert.deepEqual(evidence.requested, { limit: 2, offset: 1 })
  assert.deepEqual(evidence.returned, { rows: 2, total_rows: 5 })
  assert.deepEqual(evidence.completeness, { complete: false, has_more: true, omitted_before_offset: true })
  assert.deepEqual(evidence.query, JSON.parse(query))

  malformed = 'total'
  const invalid = await runCli(['data', 'query', '--query', query, '--format', 'json'], { env })
  assert.equal(invalid.code, 5)
  assert.equal(invalid.stdout, '')
  const invalidError = JSON.parse(invalid.stderr).error
  assert.equal(invalidError.code, 'INVALID_API_RESPONSE')
  assert.equal(invalidError.details.received_structure.total.type, 'string')
  assert.equal(invalidError.details.received_structure.rows.all_objects, true)
  assert.doesNotMatch(invalid.stderr, /malformed-(?:meta|document)-secret/)

  malformed = 'duplicate_header'
  const duplicateHeader = await runCli(['data', 'query', '--query', query, '--format', 'json'], { env })
  assert.equal(duplicateHeader.code, 5)
  assert.equal(duplicateHeader.stdout, '')
  const duplicateHeaderError = JSON.parse(duplicateHeader.stderr).error
  assert.equal(duplicateHeaderError.code, 'INVALID_API_RESPONSE')
  assert.equal(duplicateHeaderError.details.received_structure.header.unique, false)
})

// The backend's count query degrades to COUNT(*) over the source rows for an
// ungrouped query whose selects are formula wrappers rather than bare
// aggregates, so `total` is not a result-row count. Deriving completeness from
// it alone reported every such aggregate as truncated and sent agents paging
// with --offset into a result set that has exactly one row.
void test('an ungrouped aggregate is complete even when the reported total counts source rows', async t => {
  const { env } = await apiHarness(t, (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      total: 48211,
      header: ['play_time_seconds'],
      rows: [{ play_time_seconds: 91234.5 }]
    }))
  }, 'data-aggregate-total')

  const query = JSON.stringify({
    from: 'dbt_p4d_engagement_per_gameplay',
    select: [{
      alias: 'play_time_seconds',
      formula: { operator: '/', terms: [{ aggregate: 'sum', field: 'play_time' }, { constant: 1000 }] }
    }],
    limit: 10000
  })

  const result = await runCli(['data', 'query', '--query', query, '--format', 'json'], { env })
  assert.equal(result.code, 0, result.stderr)
  const evidence = JSON.parse(result.stdout).meta.evidence
  assert.deepEqual(evidence.returned, { rows: 1, total_rows: 48211 })
  assert.deepEqual(evidence.completeness, { complete: true, has_more: false, omitted_before_offset: false })
  assert.equal(evidence.interpretation.selected_measure_contracts[0].output, 'play_time_seconds')
  assert.deepEqual(evidence.interpretation.selected_measure_contracts[0].source, { table: 'dbt_p4d_engagement_per_gameplay', field: 'play_time' })

  // A window that actually filled the requested limit still reports more.
  const bounded = JSON.stringify({ from: 'dbt_p4d_engagement_per_gameplay', select: [{ field: 'play_time' }], limit: 1 })
  const partial = await runCli(['data', 'query', '--query', bounded, '--format', 'json'], { env })
  assert.equal(partial.code, 0, partial.stderr)
  assert.deepEqual(JSON.parse(partial.stdout).meta.evidence.completeness, {
    complete: false,
    has_more: true,
    omitted_before_offset: false
  })
})

void test('freshness evidence requires a returned timestamp column rather than only the source table', async t => {
  // The test server callback intentionally owns its async request lifecycle.
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  const { env } = await apiHarness(t, async (req, res) => {
    const body = await requestBody(req)
    assert.equal(body.from, 'table_update_times')
    res.writeHead(200, { 'Content-Type': 'application/json' })
    const timestampStatement = (body.select as Array<Record<string, unknown>>).find(statement => typeof statement.field === 'string' && (statement.field === 'last_updated_at' || statement.field.endsWith('.last_updated_at')))
    if (timestampStatement !== undefined) {
      const timestampOutput = typeof timestampStatement.alias === 'string' ? timestampStatement.alias : 'last_updated_at'
      res.end(JSON.stringify({
        total: 1,
        header: ['table_name', timestampOutput],
        rows: [{ table_name: 'dbt_p4d_gameplays', [timestampOutput]: '2026-08-13 09:00:00' }]
      }))
      return
    }
    res.end(JSON.stringify({ total: 1, header: ['table_name'], rows: [{ table_name: 'dbt_p4d_gameplays' }] }))
  }, 'data-freshness')

  const freshness = await runCli(['data', 'freshness', '--format', 'json'], { env })
  assert.equal(freshness.code, 0, freshness.stderr)
  const freshnessEvidence = JSON.parse(freshness.stdout).meta.evidence
  assert.deepEqual(freshnessEvidence.freshness, { status: 'returned_in_rows' })
  assert.deepEqual(freshnessEvidence.semantic_validation, { status: 'passed', contract_version: 1 })
  assert.ok(freshnessEvidence.warnings.every((warning: { code: string }) => warning.code !== 'FRESHNESS_NOT_CHECKED'))
  // evidence.recipe must never name a recipe that `poki data recipe` cannot
  // read back; freshness synthesizes its own query and names its source.
  assert.equal(freshnessEvidence.recipe, null)
  assert.equal(freshnessEvidence.source, 'table_update_times')

  const qualifiedQuery = JSON.stringify({
    from: 'table_update_times',
    select: [{ field: 'table_update_times.last_updated_at', alias: 'updated_at' }]
  })
  const qualified = await runCli(['data', 'query', '--query', qualifiedQuery, '--format', 'json'], { env })
  assert.equal(qualified.code, 0, qualified.stderr)
  const qualifiedDocument = JSON.parse(qualified.stdout)
  assert.deepEqual(qualifiedDocument.header, ['table_name', 'updated_at'])
  assert.deepEqual(qualifiedDocument.meta.evidence.freshness, { status: 'returned_in_rows' })
  assert.ok(qualifiedDocument.meta.evidence.warnings.every((warning: { code: string }) => warning.code !== 'FRESHNESS_NOT_CHECKED'))

  const namesOnlyQuery = JSON.stringify({ from: 'table_update_times', select: [{ field: 'table_name' }] })
  const namesOnly = await runCli(['data', 'query', '--query', namesOnlyQuery, '--format', 'json'], { env })
  assert.equal(namesOnly.code, 0, namesOnly.stderr)
  const namesOnlyEvidence = JSON.parse(namesOnly.stdout).meta.evidence
  assert.deepEqual(namesOnlyEvidence.freshness, { status: 'not_checked', command: 'poki data freshness' })
  assert.ok(namesOnlyEvidence.warnings.some((warning: { code: string }) => warning.code === 'FRESHNESS_NOT_CHECKED'))
})
