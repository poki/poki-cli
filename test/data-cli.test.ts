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
  assert.equal(tableList.data[0].column_count, undefined)
  assert.equal(typeof tableList.data[0].grain, 'string')
  assert.equal(typeof tableList.data[0].population, 'string')

  const fullTables = await runCli(['data', 'tables', '--full', '--format', 'json'])
  assert.equal(typeof JSON.parse(fullTables.stdout).data[0].column_count, 'number')

  const events = await runCli(['data', 'table', 'dbt_p4d_game_events_v2', '--format', 'json'])
  assert.equal(events.code, 0, events.stderr)
  assert.equal(events.stderr, '')
  assert.doesNotMatch(events.stdout, /role_notes|team_bound/)
  const eventTable = JSON.parse(events.stdout).data
  assert.equal(typeof eventTable.description, 'string')
  assert.ok(eventTable.columns.length > 0)
  assert.ok(eventTable.columns.every((column: { name?: unknown, summary?: unknown }) => {
    return typeof column.name === 'string' && column.name !== '' && typeof column.summary === 'string' && column.summary !== ''
  }))

  const metric = await runCli(['data', 'metric', 'gameplays_per_day', '--format', 'json'])
  assert.equal(metric.code, 0, metric.stderr)
  const metricDocument = JSON.parse(metric.stdout).data
  assert.deepEqual(metricDocument.supported_tables, ['dbt_p4d_gameplays', 'dbt_p4d_games_overview'])
  assert.deepEqual(metricDocument.table_recommendations.map((table: { name: string }) => table.name), metricDocument.supported_tables)
  assert.ok(metricDocument.table_recommendations.every((table: { grain?: unknown, population?: unknown }) => {
    return typeof table.grain === 'string' && typeof table.population === 'string'
  }))

  const column = await runCli(['data', 'column', 'dbt_p4d_game_events_v2', 'action', '--format', 'json'])
  assert.equal(column.code, 0, column.stderr)
  assert.equal(typeof JSON.parse(column.stdout).data.column.summary, 'string')

  const overview = await runCli(['data', 'describe', '--format', 'json'])
  const overviewDocument = JSON.parse(overview.stdout)
  for (const topic of ['conditions', 'joins', 'timezone']) {
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
  const complete = await runCli(['data', 'describe', 'all', '--format', 'json'])
  assert.equal(JSON.parse(complete.stdout).limits.default_limit, 10000)
})

void test('installed discovery is self-contained and exposes no private source references', async () => {
  const provenanceResult = await runCli(['data', 'provenance', '--format', 'json'])
  assert.equal(provenanceResult.code, 0, provenanceResult.stderr)
  const provenance = JSON.parse(provenanceResult.stdout).data
  assert.equal(provenance.documentation.bundled, true)
  assert.equal(provenance.documentation.external_sources_required, false)
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
