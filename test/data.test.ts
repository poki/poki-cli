import assert from 'node:assert/strict'
import test from 'node:test'

import { SEMANTIC_CONTRACT_VERSION, tableCatalog } from '../src/data/catalog'
import { dataRecipes, recipeNamesForTable, recipePlaceholders } from '../src/data/examples'
import { comparisonOperators, describeQueryTopic, queryDescription, queryTopics, validateDataQuery } from '../src/data/grammar'
import { dataMetrics } from '../src/data/metrics'
import { validateDataQuerySemantics } from '../src/data/semantics'
import { sanitizeDeveloperResourceAttribute } from '../src/developer-surface'
import { CliError } from '../src/errors'
import { ANALYTICS_TIME_ZONE } from '../src/timezones'

function captureCliError (run: () => void): CliError {
  try {
    run()
  } catch (error) {
    assert.ok(error instanceof CliError)
    return error
  }
  assert.fail('expected CliError')
}

void test('the offline catalog keeps structural invariants for every bundled table', () => {
  assert.equal(SEMANTIC_CONTRACT_VERSION, 1)
  const names = tableCatalog.map(table => table.name)
  assert.equal(new Set(names).size, names.length)
  assert.ok(names.every(name => name.trim() !== ''))
  const topLevel = tableCatalog.filter(table => table.top_level)
  const joinOnly = tableCatalog.filter(table => !table.top_level)
  const aggregationKinds = new Set(['dimension', 'identifier', 'additive_measure', 'distinct_count', 'repeated_measure', 'row_ratio', 'window_total'])
  const aggregateNames = new Set(['avg', 'count', 'sum', 'min', 'max', 'topKWeighted', 'argMax', 'quantileTDigest', 'groupUniqArray'])
  assert.equal(topLevel.length + joinOnly.length, tableCatalog.length)
  assert.equal(topLevel.length, 16)
  assert.equal(joinOnly.length, 2)

  for (const table of tableCatalog) {
    assert.ok(table.description.trim().length > 0)
    assert.ok(table.grain.trim().length > 0)
    assert.ok(table.grain_fields.length > 0)
    assert.ok(table.population.trim().length > 0)
    assert.ok(table.columns.length > 0)
    assert.equal(new Set(table.grain_fields).size, table.grain_fields.length, table.name)
    assert.equal(new Set(table.columns.map(column => column.name)).size, table.columns.length)
    assert.ok(table.columns.every(column => !column.name.startsWith('_')))
    assert.ok(table.columns.every(column => column.description.trim().length > 0))
    assert.ok(table.grain_fields.every(field => table.columns.some(column => column.name === field)), table.name)
    for (const column of table.columns) {
      assert.ok(aggregationKinds.has(column.aggregation.kind), `${table.name}.${column.name}`)
      assert.ok(column.aggregation.unit.trim().length > 0, `${table.name}.${column.name}`)
      assert.ok(column.aggregation.guidance.trim().length > 0, `${table.name}.${column.name}`)
      assert.equal(new Set(column.enum_values ?? []).size, (column.enum_values ?? []).length, `${table.name}.${column.name}`)
      if (column.frontend_name !== undefined) assert.ok(column.frontend_name.trim().length > 0, `${table.name}.${column.name}`)
      assert.equal(new Set(column.aggregation.allowed_aggregates).size, column.aggregation.allowed_aggregates.length, `${table.name}.${column.name}`)
      assert.ok(column.aggregation.allowed_aggregates.every(aggregate => aggregateNames.has(aggregate)), `${table.name}.${column.name}`)
      const required = column.aggregation.required_dimensions
      assert.equal(new Set(required?.all_of ?? []).size, (required?.all_of ?? []).length, `${table.name}.${column.name}`)
      for (const field of required?.all_of ?? []) {
        assert.ok(table.columns.some(candidate => candidate.name === field), `${table.name}.${column.name} requires missing ${field}`)
      }
      for (const option of required?.one_of ?? []) {
        assert.ok(option.length > 0, `${table.name}.${column.name}`)
        assert.equal(new Set(option).size, option.length, `${table.name}.${column.name}`)
        for (const field of option) assert.ok(table.columns.some(candidate => candidate.name === field), `${table.name}.${column.name} requires missing ${field}`)
      }
      if (column.aggregation.incompatible_addition_group !== undefined) {
        assert.equal(column.aggregation.kind, 'window_total', `${table.name}.${column.name}`)
        assert.ok(column.aggregation.incompatible_addition_group.trim().length > 0, `${table.name}.${column.name}`)
      }
    }
    for (const column of table.columns.filter(column => column.type.includes('Date'))) {
      assert.match(column.description, /Europe\/Amsterdam/, `${table.name}.${column.name}`)
      assert.doesNotMatch(column.description, /\bUTC\b/, `${table.name}.${column.name}`)
    }
    assert.equal('role_notes' in table, false)
    assert.equal('team_bound' in table, false)
  }

  const incompatibleGroups = tableCatalog.flatMap(table => table.columns.flatMap(column => {
    const group = column.aggregation.incompatible_addition_group
    return group === undefined ? [] : [`${table.name}.${group}`]
  }))
  for (const group of new Set(incompatibleGroups)) {
    assert.ok(incompatibleGroups.filter(candidate => candidate === group).length > 1, group)
  }

  for (const table of tableCatalog.filter(table => table.columns.some(column => column.name === 'context'))) {
    const context = table.columns.find(column => column.name === 'context')
    assert.deepEqual(context?.enum_values, ['playground', 'external'], table.name)
    assert.match(context?.description ?? '', /playground.*gameplay occurred on Poki.*external otherwise/i, table.name)
  }

  for (const name of ['dbt_p4d_game_events_v2', 'dbt_p4d_game_events_times_v2']) {
    const table = tableCatalog.find(table => table.name === name)
    assert.deepEqual(table?.field_terminology?.mappings, [
      { frontend_name: 'Category', backend_field: 'category' },
      { frontend_name: 'What', backend_field: 'action' },
      { frontend_name: 'Action', backend_field: 'label' }
    ])
    assert.match(table?.field_terminology?.instruction ?? '', /Communicate.*Category.*What.*Action.*backend field/i)
    assert.deepEqual(
      table?.columns.filter(column => column.frontend_name !== undefined).map(column => [column.name, column.frontend_name]),
      [['category', 'Category'], ['action', 'What'], ['label', 'Action']]
    )
  }
})

void test('all requested data recipes contain structurally valid queries', () => {
  assert.equal(new Set(dataRecipes.map(recipe => recipe.name)).size, dataRecipes.length)
  for (const recipe of dataRecipes) {
    validateDataQuery(recipe.query)
    validateDataQuerySemantics(recipe.query)
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
  assert.deepEqual(visibilityWhere?.expressions.slice(4), [
    ['label', '==', ''],
    {
      operator: 'or',
      expressions: [
        ['dbt_p4d_game_events_v2.seen', '>', 0],
        ['dbt_p4d_game_events_v2.interacted', '>', 0]
      ]
    }
  ])

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
  assert.ok(queryTopics.includes('aggregation'))
  assert.ok(queryTopics.includes('game-events'))
  assert.deepEqual(describeQueryTopic('aggregation'), { aggregation: queryDescription.aggregation })
  assert.deepEqual(describeQueryTopic('game-events'), { game_events: queryDescription.game_events })
  assert.match(queryDescription.aggregation.failure, /INCOMPATIBLE_GRAIN/)
  assert.deepEqual(queryDescription.game_events.field_mapping.map(mapping => [mapping.frontend_name, mapping.backend_field]), [
    ['Category', 'category'],
    ['What', 'action'],
    ['Action', 'label']
  ])
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
    assert.equal(new Set(metric.required_dimensions).size, metric.required_dimensions.length, metric.name)
    assert.ok(metric.supported_tables.length > 0, metric.name)
    assert.equal(new Set(metric.supported_tables).size, metric.supported_tables.length, metric.name)
    for (const name of metric.supported_tables) {
      const table = tableCatalog.find(table => table.name === name)
      assert.ok(table !== undefined, `${metric.name} references missing table ${name}`)
      assert.ok(table.top_level, `${metric.name} recommends join-only table ${name}`)
      for (const field of metric.required_fields) {
        assert.ok(table.columns.some(column => column.name === field), `${metric.name} requires missing ${name}.${field}`)
      }
      for (const field of metric.required_dimensions) {
        assert.ok(table.columns.some(column => column.name === field), `${metric.name} requires missing dimension ${name}.${field}`)
      }
      const where = metric.required_dimensions.length === 0
        ? undefined
        : { expressions: metric.required_dimensions.map(field => [field, '==', `<${field.toUpperCase()}>`]) }
      const query = {
        from: name,
        select: [{ alias: 'metric', formula: metric.formula }],
        ...(where === undefined ? {} : { where })
      }
      validateDataQuery(query)
      validateDataQuerySemantics(query)
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
  assert.deepEqual(netlibPeers?.required_dimensions, ['hour', 'p4d_game_id'])
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

void test('semantic validation fails closed on every unknown table, join source, and column', () => {
  const queries = [
    { from: 'a_newer_server_table', select: [{ field: 'value' }] },
    { from: 'dbt_p4d_meta_game', select: [{ field: 'p4d_game_id' }] },
    { from: 'dbt_p4d_users', select: [{ field: 'bogus_field' }] },
    { from: 'dbt_p4d_gameplays', select: [{ field: 'pokifordevs_games.bogus' }] },
    { from: 'dbt_p4d_gameplays', select: [{ field: 'unknown_join_table.title' }] },
    { from: 'dbt_p4d_gameplays', select: [{ field: 'dbt_p4d_users.daily_active_users' }] },
    { from: 'dbt_p4d_quick_stats', select: [{ field: 'pokifordevs_games.title' }] },
    {
      from: 'dbt_p4d_gameplays',
      select: [{ constant: 'title', alias: 'unknown_join_table.title' }],
      group: ['unknown_join_table.title']
    }
  ]
  for (const query of queries) {
    validateDataQuery(query)
    const error = captureCliError(() => validateDataQuerySemantics(query))
    assert.equal(error.code, 'UNKNOWN_DATA_REFERENCE')
    assert.equal(error.exitCode, 2)
    assert.ok(Array.isArray((error.details as { violations: unknown[] }).violations))
  }

  const qualifiedOutputName = {
    from: 'dbt_p4d_gameplays',
    select: [{ field: 'pokifordevs_games.id' }],
    group: ['id'],
    order: [{ field: 'id', direction: 'asc' }],
    include: { id: { type: 'games' } }
  }
  validateDataQuery(qualifiedOutputName)
  assert.doesNotThrow(() => validateDataQuerySemantics(qualifiedOutputName))

  const unknownNestedColumns = {
    from: 'dbt_p4d_users',
    select: [
      { alias: 'formula_value', formula: { operator: '+', terms: [{ field: 'function_value' }, { constant: 1 }] } },
      { alias: 'function_value', function: { name: 'number', args: [{ field: 'bogus_function' }] } },
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
          [{ function: { name: 'lower', args: [{ field: 'formula_value' }] } }, '==', { constant: 'value' }],
          ['daily_active_users', '>', { formula: { operator: '+', terms: [{ field: 'bogus_condition_right' }, { constant: 1 }] } }]
        ]
      }]
    }
  }
  validateDataQuery(unknownNestedColumns)
  const nestedError = captureCliError(() => validateDataQuerySemantics(unknownNestedColumns))
  assert.equal(nestedError.code, 'UNKNOWN_DATA_REFERENCE')
  assert.equal((nestedError.details as { violations: unknown[] }).violations.length, 4)
})

void test('conditions may reference known select output names but not hide unknown fields', () => {
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
        ['p4d_game_id', '==', 'game-1']
      ]
    },
    group: ['date', 'title'],
    order: [{ field: 'playing_users', direction: 'desc' }]
  }
  validateDataQuery(aliasInWhere)
  assert.doesNotThrow(() => validateDataQuerySemantics(aliasInWhere))

  const unknown = structuredClone(aliasInWhere)
  unknown.where.expressions.push(['bogus_condition_field', '==', 'value'])
  const error = captureCliError(() => validateDataQuerySemantics(unknown))
  assert.equal(error.code, 'UNKNOWN_DATA_REFERENCE')
})

void test('event gameplay counts require every event-key dimension and report actionable violations', () => {
  const reportedQuery: {
    from: string
    select: Array<Record<string, unknown>>
    where: { expressions: unknown[][] }
    group: string[]
    limit: number
  } = {
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
  validateDataQuery(reportedQuery)
  const error = captureCliError(() => validateDataQuerySemantics(reportedQuery))
  assert.equal(error.code, 'INCOMPATIBLE_GRAIN')
  assert.equal(error.exitCode, 2)
  const violations = (error.details as { violations: Array<Record<string, unknown>> }).violations
  assert.equal(violations.length, 1)
  assert.deepEqual(violations[0], {
    path: 'select[3].field',
    table: 'dbt_p4d_game_events_v2',
    field: 'gameplays',
    aggregate: 'sum',
    aggregation_kind: 'distinct_count',
    unit: 'gameplay sessions',
    allowed_aggregates: ['sum'],
    missing_dimensions: ['label'],
    reason: 'The query drops dimensions needed to keep the represented entities disjoint or the repeated value well-defined.',
    why_misleading: 'A gameplay can contribute to multiple event keys. Keep frontend Category (backend category), What (backend action), and Action (backend label) visible or exactly filtered; a unique cross-key total is unavailable from this table.',
    safe_reformulations: [
      'Select and group by Action (backend field label), or constrain each backend field to one exact value.',
      'Use only the declared aggregate: sum.',
      'A gameplay can contribute to multiple event keys. Keep frontend Category (backend category), What (backend action), and Action (backend label) visible or exactly filtered; a unique cross-key total is unavailable from this table.'
    ],
    relevant_recipes: ['all-game-events', 'game-event-starts-export', 'game-event-visibility-export', 'game-events-export', 'game-events']
  })

  const selectedLabel = structuredClone(reportedQuery)
  selectedLabel.select.splice(3, 0, { field: 'label' })
  selectedLabel.group.push('label')
  assert.doesNotThrow(() => validateDataQuerySemantics(selectedLabel))

  const aliasedLabel = structuredClone(reportedQuery)
  aliasedLabel.select.splice(3, 0, { field: 'label', alias: 'event_label' })
  aliasedLabel.group.push('event_label')
  assert.doesNotThrow(() => validateDataQuerySemantics(aliasedLabel))

  const exactLabel = structuredClone(reportedQuery)
  exactLabel.where.expressions.push(['label', '==', ''])
  assert.doesNotThrow(() => validateDataQuerySemantics(exactLabel))

  const qualifiedLabel = structuredClone(reportedQuery)
  qualifiedLabel.where.expressions.push(['dbt_p4d_game_events_v2.label', '==', ''])
  assert.doesNotThrow(() => validateDataQuerySemantics(qualifiedLabel))

  const expressionLabel = structuredClone(reportedQuery)
  expressionLabel.where.expressions.push([{ field: 'label' }, '==', { constant: '' }])
  validateDataQuery(expressionLabel)
  assert.doesNotThrow(() => validateDataQuerySemantics(expressionLabel))

  const singletonLabel = structuredClone(reportedQuery)
  singletonLabel.where.expressions.push(['label', 'in', ['']])
  assert.doesNotThrow(() => validateDataQuerySemantics(singletonLabel))

  const boundedLabel = structuredClone(reportedQuery)
  boundedLabel.where.expressions.push(['label', '>=', ''], ['label', '<=', ''])
  assert.doesNotThrow(() => validateDataQuerySemantics(boundedLabel))

  const hiddenLabel = structuredClone(reportedQuery)
  hiddenLabel.group.push('label')
  const hiddenError = captureCliError(() => validateDataQuerySemantics(hiddenLabel))
  assert.deepEqual((hiddenError.details as { violations: Array<{ missing_dimensions: string[] }> }).violations[0].missing_dimensions, ['label'])

  const computedAlias = structuredClone(reportedQuery)
  computedAlias.select.splice(3, 0, { alias: 'label', constant: '' })
  computedAlias.where.expressions.push(['label', '==', ''])
  const computedAliasError = captureCliError(() => validateDataQuerySemantics(computedAlias))
  assert.deepEqual((computedAliasError.details as { violations: Array<{ missing_dimensions: string[] }> }).violations[0].missing_dimensions, ['label'])

  const conditionalLabel = structuredClone(reportedQuery)
  conditionalLabel.select[3].condition = { expressions: [['label', '==', '']] }
  assert.doesNotThrow(() => validateDataQuerySemantics(conditionalLabel))

  const occurrences = structuredClone(reportedQuery)
  occurrences.select[3] = { field: 'total_events', aggregate: 'sum' }
  assert.doesNotThrow(() => validateDataQuerySemantics(occurrences))
})

void test('nested expressions, weights, and multiple selects cannot bypass aggregation contracts', () => {
  const dimensions = [{ field: 'category' }, { field: 'action' }]
  const where = { expressions: [['category', '==', 'level'], ['action', '==', '1']] }
  const nestedQueries = [
    {
      from: 'dbt_p4d_game_events_v2',
      select: [...dimensions, {
        alias: 'nested_gameplays',
        aggregate: 'sum',
        formula: { operator: '+', terms: [{ field: 'gameplays' }, { constant: 0 }] }
      }],
      where,
      group: ['category', 'action']
    },
    {
      from: 'dbt_p4d_game_events_v2',
      select: [...dimensions, {
        alias: 'nested_gameplays',
        aggregate: 'sum',
        function: { name: 'number', args: [{ field: 'gameplays' }] }
      }],
      where,
      group: ['category', 'action']
    }
  ]
  const expectedPaths = ['select[2].formula.terms[0].field', 'select[2].function.args[0].field']
  nestedQueries.forEach((query, index) => {
    validateDataQuery(query)
    const error = captureCliError(() => validateDataQuerySemantics(query))
    const violations = (error.details as { violations: Array<{ path: string, missing_dimensions: string[] }> }).violations
    assert.equal(violations[0].path, expectedPaths[index])
    assert.deepEqual(violations[0].missing_dimensions, ['label'])
  })

  const weighted = {
    from: 'dbt_p4d_game_events_v2',
    select: [{ field: 'category', aggregate: 'topKWeighted', weight: 'gameplays', alias: 'top_category' }],
    where
  }
  validateDataQuery(weighted)
  const weightedError = captureCliError(() => validateDataQuerySemantics(weighted))
  const weightedViolation = (weightedError.details as { violations: Array<Record<string, unknown>> }).violations[0]
  assert.equal(weightedViolation.path, 'select[0].weight')
  assert.equal(weightedViolation.aggregate, 'sum')
  assert.deepEqual(weightedViolation.missing_dimensions, ['label'])

  const multiple = {
    from: 'dbt_p4d_game_events_v2',
    select: [
      ...dimensions,
      { field: 'gameplays', aggregate: 'sum', alias: 'gameplays' },
      { field: 'starts', aggregate: 'sum', alias: 'starts' }
    ],
    where,
    group: ['category', 'action']
  }
  const multipleError = captureCliError(() => validateDataQuerySemantics(multiple))
  assert.deepEqual(
    (multipleError.details as { violations: Array<{ path: string }> }).violations.map(violation => violation.path),
    ['select[2].field', 'select[3].field']
  )
})

void test('daily user counts retain both date and game, including inside ratios', () => {
  for (const [table, fields] of [
    ['dbt_p4d_users', ['daily_active_users', 'daily_playing_users', 'daily_not_playing_users', 'daily_loading_users', 'daily_finished_loading_users']],
    ['dbt_p4d_monetization', ['daily_active_users', 'daily_playing_users']],
    ['dbt_p4d_games_overview', ['daily_active_users', 'daily_playing_users']]
  ] as const) {
    for (const field of fields) {
      const query = {
        from: table,
        select: [{ field, aggregate: 'sum', alias: field }],
        where: {
          expressions: [
            ['p4d_game_id', '==', 'game-1'],
            ['date', '>=', '2026-07-01'],
            ['date', '<=', '2026-07-31']
          ]
        }
      }
      const error = captureCliError(() => validateDataQuerySemantics(query))
      assert.deepEqual((error.details as { violations: Array<{ missing_dimensions: string[] }> }).violations[0].missing_dimensions, ['date'], `${table}.${field}`)
    }
  }

  const exactDay = {
    from: 'dbt_p4d_users',
    select: [{ field: 'daily_active_users', aggregate: 'sum', alias: 'users' }],
    where: {
      expressions: [
        ['p4d_game_id', 'in', ['game-1']],
        ['date', '>=', '2026-07-01'],
        ['date', '<=', '2026-07-01']
      ]
    }
  }
  assert.doesNotThrow(() => validateDataQuerySemantics(exactDay))

  const visibleAliasedGrain = {
    from: 'dbt_p4d_users',
    select: [
      { field: 'date', alias: 'metric_date' },
      { field: 'p4d_game_id', alias: 'game' },
      { field: 'daily_active_users', aggregate: 'sum', alias: 'users' }
    ],
    group: ['metric_date', 'game']
  }
  assert.doesNotThrow(() => validateDataQuerySemantics(visibleAliasedGrain))

  const hiddenGrain = {
    from: 'dbt_p4d_users',
    select: [{ field: 'daily_active_users', aggregate: 'sum', alias: 'users' }],
    group: ['date', 'p4d_game_id']
  }
  const hiddenError = captureCliError(() => validateDataQuerySemantics(hiddenGrain))
  assert.deepEqual((hiddenError.details as { violations: Array<{ missing_dimensions: string[] }> }).violations[0].missing_dimensions, ['date', 'p4d_game_id'])

  const ratio = {
    from: 'dbt_p4d_users',
    select: [{
      alias: 'playing_share',
      formula: {
        operator: '/',
        terms: [
          { field: 'daily_playing_users', aggregate: 'sum' },
          { field: 'daily_active_users', aggregate: 'sum' }
        ]
      }
    }],
    where: {
      expressions: [
        ['p4d_game_id', '==', 'game-1'],
        ['date', '>=', '2026-07-01'],
        ['date', '<=', '2026-07-31']
      ]
    }
  }
  const ratioError = captureCliError(() => validateDataQuerySemantics(ratio))
  const ratioViolations = (ratioError.details as { violations: Array<{ path: string, missing_dimensions: string[] }> }).violations
  assert.deepEqual(
    ratioViolations.map(({ path, missing_dimensions: missingDimensions }) => ({ path, missing_dimensions: missingDimensions })),
    [
      { path: 'select[0].formula.terms[0].field', missing_dimensions: ['date'] },
      { path: 'select[0].formula.terms[1].field', missing_dimensions: ['date'] }
    ]
  )
})

void test('specialized repeated, overlapping, and row-level measures enforce their declared grains', () => {
  const timing = {
    from: 'dbt_p4d_game_events_times_v2',
    select: [{ field: 'gameplays', aggregate: 'sum', alias: 'gameplays' }],
    where: { expressions: [['category', '==', 'level'], ['action', '==', '1'], ['label', '==', 'complete']] }
  }
  const timingError = captureCliError(() => validateDataQuerySemantics(timing))
  assert.deepEqual((timingError.details as { violations: Array<{ missing_dimensions: string[] }> }).violations[0].missing_dimensions, ['time_type'])
  timing.where.expressions.push(['time_type', '==', 'complete'])
  assert.doesNotThrow(() => validateDataQuerySemantics(timing), 'time_bucket may be rolled up')

  const funnel = {
    from: 'dbt_p4d_game_events_funnel_v2',
    select: [{ field: 'gameplays', aggregate: 'sum', alias: 'gameplays' }]
  }
  const funnelError = captureCliError(() => validateDataQuerySemantics(funnel))
  assert.deepEqual((funnelError.details as { violations: Array<{ missing_dimensions: string[] }> }).violations[0].missing_dimensions, ['prefix_len'])
  const fixedFunnel = { ...funnel, where: { expressions: [['prefix_len', '==', 2]] } }
  assert.doesNotThrow(() => validateDataQuerySemantics(fixedFunnel))
  const sampleError = captureCliError(() => validateDataQuerySemantics({
    from: 'dbt_p4d_game_events_funnel_v2',
    select: [{ field: 'gameplay_sample_percentage', aggregate: 'avg', alias: 'sample_percentage' }]
  }))
  assert.deepEqual((sampleError.details as { violations: Array<{ allowed_aggregates: string[] }> }).violations[0].allowed_aggregates, [])

  const affected = {
    from: 'dbt_p4d_game_new_high_impact_errors',
    select: [{ field: 'affected_gameplays', aggregate: 'sum', alias: 'affected_gameplays' }]
  }
  const affectedError = captureCliError(() => validateDataQuerySemantics(affected))
  assert.deepEqual((affectedError.details as { violations: Array<{ missing_dimensions: string[] }> }).violations[0].missing_dimensions, ['error_id'])
  assert.doesNotThrow(() => validateDataQuerySemantics({ ...affected, where: { expressions: [['error_id', '==', 'error-1']] } }))

  const totalGameplays = {
    from: 'dbt_p4d_game_new_high_impact_errors',
    select: [{ field: 'total_gameplays', aggregate: 'sum', alias: 'total_gameplays' }],
    where: { expressions: [['date', '==', '2026-07-01'], ['p4d_game_id', '==', 'game-1']] }
  }
  const totalError = captureCliError(() => validateDataQuerySemantics(totalGameplays))
  const totalViolation = (totalError.details as { violations: Array<{ allowed_aggregates: string[], missing_dimensions: string[] }> }).violations[0]
  assert.deepEqual(totalViolation.allowed_aggregates, ['max'])
  assert.deepEqual(totalViolation.missing_dimensions, [])
  totalGameplays.select[0].aggregate = 'max'
  assert.doesNotThrow(() => validateDataQuerySemantics(totalGameplays))
  const impactError = captureCliError(() => validateDataQuerySemantics({
    from: 'dbt_p4d_game_new_high_impact_errors',
    select: [{ field: 'gameplay_percentage', aggregate: 'avg', alias: 'impact' }]
  }))
  assert.deepEqual((impactError.details as { violations: Array<{ allowed_aggregates: string[] }> }).violations[0].allowed_aggregates, [])

  const peers = {
    from: 'dbt_p4d_netlib_overview',
    select: [{ field: 'peer_connections', aggregate: 'sum', alias: 'peers' }],
    where: { expressions: [['p4d_game_id', '==', 'game-1'], ['hour', '>=', '2026-07-01 10:00:00'], ['hour', '<=', '2026-07-01 11:00:00']] }
  }
  const peersError = captureCliError(() => validateDataQuerySemantics(peers))
  assert.deepEqual((peersError.details as { violations: Array<{ missing_dimensions: string[] }> }).violations[0].missing_dimensions, ['hour'])
  peers.where.expressions[2][2] = '2026-07-01 10:00:00'
  assert.doesNotThrow(() => validateDataQuerySemantics(peers))
})

void test('determinant alternatives, repeated domains, and quick-stat windows remain unambiguous', () => {
  const domains = {
    from: 'dbt_p4d_games_overview',
    select: [{ field: 'num_domains_live', aggregate: 'sum', alias: 'domains' }],
    where: { expressions: [['date', '==', '2026-07-01'], ['p4d_game_id', '==', 'game-1']] }
  }
  const domainsError = captureCliError(() => validateDataQuerySemantics(domains))
  assert.deepEqual((domainsError.details as { violations: Array<{ allowed_aggregates: string[] }> }).violations[0].allowed_aggregates, ['max'])
  domains.select[0].aggregate = 'max'
  assert.doesNotThrow(() => validateDataQuerySemantics(domains))

  const joinedDomains = {
    from: 'dbt_p4d_gameplays',
    select: [{ field: 'dbt_p4d_meta_game.num_domains_live', aggregate: 'max', alias: 'domains' }],
    where: { expressions: [['p4d_game_id', '==', 'game-1']] }
  }
  assert.doesNotThrow(() => validateDataQuerySemantics(joinedDomains))
  joinedDomains.select[0].aggregate = 'sum'
  assert.equal(captureCliError(() => validateDataQuerySemantics(joinedDomains)).code, 'INCOMPATIBLE_GRAIN')

  const byErrorId = {
    from: 'dbt_p4d_game_errors_per_gameplay',
    select: [
      { field: 'error_id' },
      { field: 'same_engine_games', aggregate: 'max', alias: 'same_engine_games' }
    ],
    group: ['error_id']
  }
  assert.doesNotThrow(() => validateDataQuerySemantics(byErrorId))
  const bySignature = {
    from: 'dbt_p4d_game_errors_per_gameplay',
    select: [
      { field: 'engine' },
      { field: 'error_name' },
      { field: 'error_message' },
      { field: 'same_engine_games', aggregate: 'max', alias: 'same_engine_games' }
    ],
    group: ['engine', 'error_name', 'error_message']
  }
  assert.doesNotThrow(() => validateDataQuerySemantics(bySignature))
  const unrelatedJoinedEngine = structuredClone(bySignature)
  unrelatedJoinedEngine.select[0] = { field: 'pokifordevs_games.engine' }
  assert.equal(captureCliError(() => validateDataQuerySemantics(unrelatedJoinedEngine)).code, 'INCOMPATIBLE_GRAIN')
  bySignature.select[3].aggregate = 'sum'
  const signatureError = captureCliError(() => validateDataQuerySemantics(bySignature))
  assert.deepEqual((signatureError.details as { violations: Array<{ allowed_aggregates: string[] }> }).violations[0].allowed_aggregates, ['max'])

  const separateWindows = {
    from: 'dbt_p4d_quick_stats',
    select: [
      { field: 'yesterday_developer_earnings_eur' },
      { field: 'last_7_days_developer_earnings_eur' }
    ]
  }
  assert.doesNotThrow(() => validateDataQuerySemantics(separateWindows))
  const overlappingWindows = {
    from: 'dbt_p4d_quick_stats',
    select: [{
      alias: 'invalid_earnings',
      formula: {
        operator: '+',
        terms: [
          { field: 'yesterday_developer_earnings_eur' },
          { field: 'last_7_days_developer_earnings_eur' }
        ]
      }
    }]
  }
  const windowsError = captureCliError(() => validateDataQuerySemantics(overlappingWindows))
  const windowsViolation = (windowsError.details as { violations: Array<Record<string, unknown>> }).violations[0]
  assert.equal(windowsViolation.path, 'select[0].formula')
  assert.match(String(windowsViolation.why_misleading), /double counts/)
  const duplicatedWindow = structuredClone(overlappingWindows)
  duplicatedWindow.select[0].formula.terms[1] = { field: 'yesterday_developer_earnings_eur' }
  assert.equal(captureCliError(() => validateDataQuerySemantics(duplicatedWindow)).code, 'INCOMPATIBLE_GRAIN')

  assert.doesNotThrow(() => validateDataQuerySemantics({
    from: 'dbt_p4d_gameplays',
    select: [{ field: 'gameplays', aggregate: 'sum', alias: 'gameplays' }]
  }))
  assert.doesNotThrow(() => validateDataQuerySemantics({
    from: 'dbt_p4d_game_events_v2',
    select: [{ field: 'total_events', aggregate: 'sum', alias: 'events' }]
  }))
  const additiveAverage = captureCliError(() => validateDataQuerySemantics({
    from: 'dbt_p4d_gameplays',
    select: [{ field: 'gameplays', aggregate: 'avg', alias: 'gameplays' }]
  }))
  assert.deepEqual((additiveAverage.details as { violations: Array<{ allowed_aggregates: string[] }> }).violations[0].allowed_aggregates, ['sum'])
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
