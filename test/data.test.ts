import assert from 'node:assert/strict'
import test from 'node:test'

import { snapshotWarnings, tableCatalog } from '../src/data/catalog'
import { dataRecipes, recipeNamesForTable, recipePlaceholders } from '../src/data/examples'
import { comparisonOperators, describeQueryTopic, queryDescription, queryTopics, validateDataQuery } from '../src/data/grammar'
import { dataMetrics } from '../src/data/metrics'
import { sanitizeDeveloperResourceAttribute } from '../src/developer-surface'
import { CliError } from '../src/errors'
import { ANALYTICS_TIME_ZONE } from '../src/timezones'

void test('the offline catalog keeps structural invariants for every bundled table', () => {
  const names = tableCatalog.map(table => table.name)
  assert.equal(new Set(names).size, names.length)
  assert.ok(names.every(name => name.trim() !== ''))
  const topLevel = tableCatalog.filter(table => table.top_level)
  const joinOnly = tableCatalog.filter(table => !table.top_level)
  assert.equal(topLevel.length + joinOnly.length, tableCatalog.length)
  assert.ok(topLevel.length >= 10)

  for (const table of tableCatalog) {
    assert.ok(table.description.trim().length > 0)
    assert.ok(table.grain.trim().length > 0)
    assert.ok(table.population.trim().length > 0)
    assert.ok(table.columns.length > 0)
    assert.equal(new Set(table.columns.map(column => column.name)).size, table.columns.length)
    assert.ok(table.columns.every(column => !column.name.startsWith('_')))
    assert.ok(table.columns.every(column => column.description.trim().length > 0))
    for (const column of table.columns.filter(column => column.type.includes('Date'))) {
      assert.match(column.description, /Europe\/Amsterdam/, `${table.name}.${column.name}`)
      assert.doesNotMatch(column.description, /\bUTC\b/, `${table.name}.${column.name}`)
    }
    assert.equal('role_notes' in table, false)
    assert.equal('team_bound' in table, false)
  }
})

void test('all requested data recipes contain structurally valid queries', () => {
  assert.equal(new Set(dataRecipes.map(recipe => recipe.name)).size, dataRecipes.length)
  for (const recipe of dataRecipes) {
    validateDataQuery(recipe.query)
    assert.ok(recipe.description.length > 0)
    assert.ok(Object.keys(recipe.parameters).length > 0)
    assert.ok(recipe.tables.every(name => tableCatalog.some(table => table.name === name)))
    for (const [name, description] of Object.entries(recipe.parameters)) {
      if (name.includes('DATE')) assert.match(description, /Europe\/Amsterdam/, `${recipe.name}.${name}`)
    }
  }

  const engagement = dataRecipes.find(recipe => recipe.name === 'engagement-per-gameplay')
  assert.deepEqual(engagement?.tables, ['dbt_p4d_engagement_per_gameplay'])
  assert.deepEqual(engagement?.query.select, [
    {
      alias: 'engagement_seconds_per_gameplay',
      formula: {
        operator: '/',
        terms: [
          {
            formula: {
              operator: '/',
              terms: [
                {
                  formula: {
                    operator: '+',
                    terms: [
                      { field: 'video_ad_visible_time', aggregate: 'sum' },
                      { field: 'play_time', aggregate: 'sum' },
                      { field: 'pre_play_time', aggregate: 'sum' }
                    ]
                  }
                },
                { constant: 1000 }
              ]
            }
          },
          { field: 'gameplays', aggregate: 'sum' }
        ]
      }
    },
    { field: 'date' }
  ])

  const gameUsers = dataRecipes.find(recipe => recipe.name === 'game-users')
  const loadingUsers = (gameUsers?.query.select as Array<Record<string, unknown>>).find(statement => statement.alias === 'daily_loading_users')
  assert.deepEqual(loadingUsers?.function, {
    name: 'if',
    args: [
      ['context', '==', 'playground'],
      { field: 'daily_loading_users' },
      { field: 'daily_active_users' }
    ]
  })

  const allEvents = dataRecipes.find(recipe => recipe.name === 'all-game-events')
  assert.equal(allEvents?.query.limit, 10000)
  assert.ok(JSON.stringify(allEvents?.query).includes('<FROM_DATE>'))

  const visibility = dataRecipes.find(recipe => recipe.name === 'game-event-visibility-export')
  const visibilityWhere = visibility?.query.where as { expressions: unknown[] } | undefined
  assert.deepEqual(visibilityWhere?.expressions.slice(4), [{
    operator: 'or',
    expressions: [
      ['dbt_p4d_game_events_v2.seen', '>', 0],
      ['dbt_p4d_game_events_v2.interacted', '>', 0]
    ]
  }])

  const totalTime = dataRecipes.find(recipe => recipe.name === 'total-time-spent')
  assert.deepEqual(totalTime?.tables, ['dbt_p4d_engagement_per_gameplay'])
  assert.equal(totalTime?.query.from, 'dbt_p4d_engagement_per_gameplay')
  assert.match(JSON.stringify(totalTime?.query.select), /gameplays/)
  assert.doesNotMatch(JSON.stringify(totalTime?.query.select), /daily_active_users/)
  assert.ok((totalTime?.query.select as Array<Record<string, unknown>>).slice(1)
    .every(statement => JSON.stringify(statement.formula).includes('"constant":1000')))

  const netlib = dataRecipes.find(recipe => recipe.name === 'netlib-hourly')
  assert.deepEqual(netlib?.tables, ['dbt_p4d_netlib_overview'])
  assert.match(JSON.stringify(netlib?.query), /peer_connections/)
  assert.match(JSON.stringify(netlib?.query), /"constant":2/)
})

void test('query grammar metadata and validation cover supported structures without enforcing the catalog', () => {
  assert.ok(comparisonOperators.includes('has_any_string'))
  assert.equal(queryDescription.limits.default_limit, 10000)
  assert.equal(queryDescription.timezone.time_zone, ANALYTICS_TIME_ZONE)
  assert.doesNotMatch(JSON.stringify(queryDescription), /team-bound|Benchmark tables/)

  validateDataQuery({
    from: 'a_newer_server_table',
    select: [{ alias: 'choice', function: { name: 'if', args: [['value', '>', 0], { constant: 'yes' }, { constant: 'no' }] } }],
    where: { expressions: [['team_id', '==', 'team-1']] },
    order: [{ field: 'choice', direction: 'desc', numeric: false }],
    limit: 10,
    offset: 0
  })

  assert.throws(() => validateDataQuery({ from: 'table', select: [{ field: 'value' }], mystery: true }), /unsupported key/)
  assert.throws(() => validateDataQuery({ from: 'table', select: [{ field: 'table._private' }] }), /internal fields/)
  assert.throws(() => validateDataQuery({ from: 'table', select: [{ alias: 'x', function: { name: 'if', args: [{ constant: true }] } }] }), /exactly three/)
  assert.throws(() => validateDataQuery({ from: 'table', select: [{ field: 'value' }], where: { expressions: [['value', 'contains', 1]] } }), /comparison operator/)

  // Right operands are documented per operator family and their structural
  // shapes are validated locally without pretending to validate table data.
  assert.match(queryDescription.conditions.expression, /left may be a field name or a validated select-statement expression/i)
  assert.match(queryDescription.conditions.right_operands.scalar.right, /finite number.*select-statement expression/i)
  assert.deepEqual(queryDescription.conditions.right_operands.in.example, ['country_id', 'in', ['US', 'GB']])
  assert.match(queryDescription.conditions.right_operands.in.right, /expression, not a database subquery/i)
  assert.match(queryDescription.conditions.right_operands.like.right, /literal string pattern.*dynamic pattern/i)
  validateDataQuery({ from: 'table', select: [{ field: 'value' }], where: { expressions: [['country_id', 'in', ['US', 'GB']]] } })
  assert.throws(() => validateDataQuery({ from: 'table', select: [{ field: 'value' }], where: { expressions: [['country_id', 'in', 'US']] } }), /array of primitive/)
  assert.throws(() => validateDataQuery({ from: 'table', select: [{ field: 'value' }], where: { expressions: [['country_id', 'in', [['US']]]] } }), /array of primitive/)
  const exactHash = '-8340446448795919230'
  assert.deepEqual(queryDescription.conditions.right_operands.has_any.example, ['prefix_hashes', 'has_any_int64', [exactHash]])
  assert.match(queryDescription.conditions.right_operands.has_any.signed_int64_precision, /groupUniqArray\(toString\(event_hash\)\).*never.*JavaScript numbers/i)
  assert.deepEqual(queryDescription.select_statement.signed_int64_hashes.select_one.example, {
    alias: 'event_hash',
    function: { name: 'toString', args: [{ field: 'event_hash' }] }
  })
  assert.deepEqual(queryDescription.select_statement.signed_int64_hashes.select_distinct.example, {
    alias: 'event_hashes',
    aggregate: 'groupUniqArray',
    function: { name: 'toString', args: [{ field: 'event_hash' }] }
  })
  validateDataQuery({ from: 'table', select: [{ field: 'value' }], where: { expressions: [['prefix_hashes', 'has_any_int64', [exactHash]]] } })
  assert.throws(() => validateDataQuery({ from: 'table', select: [{ field: 'value' }], where: { expressions: [['prefix_hashes', 'has_any_int64', [Number(exactHash)]]] } }), /exact base-10 signed integer strings.*never JavaScript numbers/)

  assert.ok(queryTopics.includes('result'))
  assert.deepEqual(describeQueryTopic('result'), { result: queryDescription.result })
  assert.match(queryDescription.result.column_names, /alias when set, otherwise by the final segment.*qualification/i)
  assert.match(queryDescription.result.column_names, /duplicate header names is invalid/i)
  assert.match(queryDescription.result.envelope, /total: integer, header: string\[\], rows: object\[\]/)
  assert.match(queryDescription.result.rows, /keyed by header names/)
  assert.match(queryDescription.result.included, /JSON:API resource type/)
  assert.match(queryDescription.result.evidence, /exact query/)
  assert.match(queryDescription.result.csv, /cannot carry meta\.evidence/)
  assert.match(queryDescription.result.signed_int64_hashes, /derived hash condition expressions.*length\(prefix_hashes\) == 0/i)
})

void test('table recipe names are derived from the recipe registry', () => {
  assert.deepEqual(recipeNamesForTable('dbt_p4d_gameplays'), ['team-gameplays', 'game-gameplays'])
  assert.deepEqual(recipeNamesForTable('table_update_times'), [])
})

void test('every bundled metric has explicit grain-compatible table recommendations', () => {
  for (const metric of dataMetrics) {
    validateDataQuery({ from: 'dbt_p4d_users', select: [{ alias: 'metric', formula: metric.formula }] })
    assert.ok(metric.population.trim().length > 0, metric.name)
    assert.ok(['sum', 'ratio_of_sums', 'row_level'].includes(metric.aggregation_kind), metric.name)
    assert.ok(metric.aggregation_guidance.trim().length > 0, metric.name)
    assert.ok(metric.supported_tables.length > 0, metric.name)
    assert.equal(new Set(metric.supported_tables).size, metric.supported_tables.length, metric.name)
    for (const name of metric.supported_tables) {
      const table = tableCatalog.find(table => table.name === name)
      assert.ok(table !== undefined, `${metric.name} references missing table ${name}`)
      assert.ok(table.top_level, `${metric.name} recommends join-only table ${name}`)
      for (const field of metric.required_fields) {
        assert.ok(table.columns.some(column => column.name === field), `${metric.name} requires missing ${name}.${field}`)
      }
    }
  }

  const gameplayRate = dataMetrics.find(metric => metric.name === 'gameplays_per_day')
  assert.deepEqual(gameplayRate?.supported_tables, ['dbt_p4d_gameplays', 'dbt_p4d_games_overview'])
  assert.ok(tableCatalog.filter(table => table.name.includes('game_events')).every(table => !(gameplayRate?.supported_tables.includes(table.name) ?? false)))

  const overviewTime = dataMetrics.find(metric => metric.name === 'time_spent')
  assert.deepEqual(overviewTime?.supported_tables, ['dbt_p4d_games_overview'])
  const engagementTime = dataMetrics.find(metric => metric.name === 'engagement_time_spent')
  assert.deepEqual(engagementTime?.supported_tables, ['dbt_p4d_engagement_per_gameplay'])
  assert.match(JSON.stringify(engagementTime?.formula), /"constant":1000/)

  const netlibPeers = dataMetrics.find(metric => metric.name === 'netlib_connected_peer_pairs')
  assert.deepEqual(netlibPeers?.supported_tables, ['dbt_p4d_netlib_overview'])
  assert.match(JSON.stringify(netlibPeers?.formula), /"constant":2/)

  assert.deepEqual(dataMetrics.find(metric => metric.name === 'ads_per_dau')?.required_fields, [
    'ingame_display_impressions',
    'gamebar_display_impressions',
    'platform_display_impressions',
    'preroll_video_impressions',
    'midroll_video_impressions',
    'rewarded_video_impressions',
    'daily_active_users'
  ])
  assert.deepEqual(dataMetrics.find(metric => metric.name === 'gameplays_per_day')?.required_fields, ['gameplays', 'date'])
})

void test('engagement source units and Netlib analytics fields stay explicit', () => {
  const engagement = tableCatalog.find(table => table.name === 'dbt_p4d_engagement_per_gameplay')
  assert.ok(engagement !== undefined)
  for (const field of ['video_ad_visible_time', 'play_time', 'pre_play_time']) {
    assert.match(engagement.columns.find(column => column.name === field)?.description ?? '', /milliseconds.*1000.*seconds/i, field)
  }

  const netlib = tableCatalog.find(table => table.name === 'dbt_p4d_netlib_overview')
  assert.ok(netlib !== undefined)
  assert.deepEqual(netlib.columns.map(column => column.name), [
    'hour', 'p4d_game_id', 'team_id', 'lobbies_created', 'lobbies_joined',
    'lobbies_updated', 'client_connected', 'peer_connections'
  ])
})

void test('the funnel catalog preserves signed 64-bit hash types and precision guidance', () => {
  const funnel = tableCatalog.find(table => table.name === 'dbt_p4d_game_events_funnel_v2')
  assert.ok(funnel !== undefined)
  const eventHash = funnel.columns.find(column => column.name === 'event_hash')
  const prefixHashes = funnel.columns.find(column => column.name === 'prefix_hashes')
  assert.equal(eventHash?.type, 'Int64')
  assert.equal(prefixHashes?.type, 'Array(Int64)')
  assert.match(eventHash?.description ?? '', /toString.*groupUniqArray.*never.*JavaScript number/i)
  assert.match(prefixHashes?.description ?? '', /has_any_int64.*-8340446448795919230.*decimal strings.*never JavaScript numbers/i)
})

void test('snapshot warnings flag unknown tables and columns without rejecting the query', () => {
  const unknownTable = { from: 'a_newer_server_table', select: [{ field: 'value' }] }
  validateDataQuery(unknownTable)
  assert.deepEqual(snapshotWarnings(unknownTable), ["table 'a_newer_server_table' is not in the bundled snapshot; the API may reject it"])

  const unknownColumn = {
    from: 'dbt_p4d_users',
    select: [{ field: 'bogus_field' }, { field: 'daily_active_users', aggregate: 'sum', alias: 'dau' }],
    where: { expressions: [['team_id', '==', 'team-1']] },
    group: ['date'],
    order: [{ field: 'dau', direction: 'desc' }]
  }
  validateDataQuery(unknownColumn)
  assert.deepEqual(snapshotWarnings(unknownColumn), ["field 'bogus_field' is not a bundled column of table 'dbt_p4d_users'; the API may reject it"])

  const unknownJoinColumn = {
    from: 'dbt_p4d_gameplays',
    select: [{ field: 'gameplays', aggregate: 'sum', alias: 'gameplays' }],
    where: { expressions: [['pokifordevs_games.bogus', '==', 'value'], { operator: 'or', expressions: [['unknown_join_table.title', '==', 'value']] }] }
  }
  validateDataQuery(unknownJoinColumn)
  assert.deepEqual(snapshotWarnings(unknownJoinColumn), [
    "field 'bogus' is not a bundled column of table 'pokifordevs_games'; the API may reject it",
    "table 'unknown_join_table' is not in the bundled snapshot; the API may reject it"
  ])

  const qualifiedOutputName = {
    from: 'dbt_p4d_gameplays',
    select: [{ field: 'pokifordevs_games.id' }],
    group: ['id'],
    order: [{ field: 'id', direction: 'asc' }],
    include: { id: { type: 'games' } }
  }
  validateDataQuery(qualifiedOutputName)
  assert.deepEqual(snapshotWarnings(qualifiedOutputName), [])

  const unknownNestedColumns = {
    from: 'dbt_p4d_users',
    select: [
      {
        alias: 'formula_value',
        // This source name matches another select's alias. Aliases do not hide
        // unknown fields inside an expression tree.
        formula: { operator: '+', terms: [{ field: 'function_value' }, { constant: 1 }] }
      },
      {
        alias: 'function_value',
        function: { name: 'number', args: [{ field: 'bogus_function' }] }
      },
      {
        field: 'daily_active_users',
        aggregate: 'sum',
        alias: 'conditioned_dau',
        condition: { expressions: [['bogus_aggregate_condition', '>', 0]] }
      }
    ],
    where: {
      expressions: [{
        operator: 'or',
        expressions: [
          // formula_value is another select's output name, which a condition may
          // reference; only names that resolve to no output column are checked
          // against the bundled table.
          [{ function: { name: 'lower', args: [{ field: 'formula_value' }] } }, '==', { constant: 'value' }],
          ['daily_active_users', '>', { formula: { operator: '+', terms: [{ field: 'bogus_condition_right' }, { constant: 1 }] } }]
        ]
      }]
    }
  }
  validateDataQuery(unknownNestedColumns)
  assert.deepEqual(snapshotWarnings(unknownNestedColumns), [
    "field 'function_value' is not a bundled column of table 'dbt_p4d_users'; the API may reject it",
    "field 'bogus_function' is not a bundled column of table 'dbt_p4d_users'; the API may reject it",
    "field 'bogus_aggregate_condition' is not a bundled column of table 'dbt_p4d_users'; the API may reject it",
    "field 'bogus_condition_right' is not a bundled column of table 'dbt_p4d_users'; the API may reject it"
  ])

  for (const recipe of dataRecipes) {
    assert.deepEqual(snapshotWarnings(recipe.query), [], recipe.name)
  }
})

void test('conditions may reference select output names without a snapshot mismatch', () => {
  const aliasInWhere = {
    from: 'dbt_p4d_users',
    select: [
      { field: 'date' },
      { field: 'daily_playing_users', aggregate: 'sum', alias: 'playing_users' },
      { field: 'pokifordevs_games.title' }
    ],
    where: {
      expressions: [
        ['playing_users', '>', 0],
        ['title', '!=', ''],
        ['bogus_condition_field', '==', 'value']
      ]
    },
    group: ['date', 'title'],
    order: [{ field: 'playing_users', direction: 'desc' }]
  }
  validateDataQuery(aliasInWhere)
  // where resolves output names exactly like group, order, and include: the
  // alias when present, otherwise the final segment after qualification. Only a
  // name that resolves to no output column is checked against the snapshot.
  assert.deepEqual(snapshotWarnings(aliasInWhere), [
    "field 'bogus_condition_field' is not a bundled column of table 'dbt_p4d_users'; the API may reject it"
  ])
})

void test('every bundled recipe declares exactly the placeholders its query contains', () => {
  for (const recipe of dataRecipes) {
    // Only declared names are placeholders. An undeclared <UPPERCASE> token
    // would never be reported as unresolved and would reach the API as a
    // literal value; a declared name that no longer appears documents an input
    // the recipe silently ignores.
    assert.deepEqual(recipePlaceholders(recipe.query), Object.keys(recipe.parameters).sort(), recipe.name)
  }
})

void test('arbitrary JSON survives hostile nesting depth with a structural error', () => {
  // Netlib custom_data is game-controlled and preserved verbatim, including
  // objects that happen to contain type or id keys.
  const lobbyMetadata = { type: 'match', id: 42, players: [{ type: 'peer', id: 'p-1', tags: ['ready'] }] }
  assert.deepEqual(sanitizeDeveloperResourceAttribute('lobbies', 'custom_data', lobbyMetadata), { valid: true, value: lobbyMetadata })

  let nested: unknown = 'leaf'
  for (let level = 0; level < 60; level++) nested = { nested }
  assert.deepEqual(sanitizeDeveloperResourceAttribute('lobbies', 'custom_data', nested), { valid: true, value: nested })

  let hostile: unknown = 'leaf'
  for (let level = 0; level < 50000; level++) hostile = [{ nested: hostile }]
  assert.throws(() => sanitizeDeveloperResourceAttribute('lobbies', 'custom_data', hostile), (error: unknown) => {
    // A stack overflow would fail the complete command; the depth breach is
    // reported through non-sensitive structural facts only.
    assert.ok(error instanceof CliError)
    assert.equal(error.code, 'INVALID_API_RESPONSE')
    assert.deepEqual(error.details, { expected: { max_depth: 64 }, received: { kind: 'array' } })
    return true
  })
})
