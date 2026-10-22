import assert from 'node:assert/strict'
import test from 'node:test'

import { comparisonOperators, includeResourceTypes, resolvedSelectOutputName, validateDataQuery } from '../src/data/grammar'
import { CliError } from '../src/errors'

function baseQuery (overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { from: 'dbt_p4d_gameplays', select: [{ field: 'date' }], ...overrides }
}

interface NegativeCase {
  name: string
  query: Record<string, unknown>
  message: string
}

const negativeCases: NegativeCase[] = [
  {
    name: 'count aggregate without alias',
    query: baseQuery({ select: [{ aggregate: 'count' }] }),
    message: 'select[0].alias is required for count'
  },
  {
    name: 'top-level formula without alias',
    query: baseQuery({ select: [{ formula: { operator: '+', terms: [{ field: 'gameplays' }, { constant: 1 }] } }] }),
    message: 'select[0].alias is required for a top-level formula, function, or constant expression'
  },
  {
    name: 'top-level function without alias',
    query: baseQuery({ select: [{ function: { name: 'lower', args: [{ field: 'country_id' }] } }] }),
    message: 'select[0].alias is required for a top-level formula, function, or constant expression'
  },
  {
    name: 'top-level constant without alias',
    query: baseQuery({ select: [{ constant: 1 }] }),
    message: 'select[0].alias is required for a top-level formula, function, or constant expression'
  },
  {
    name: 'duplicate unaliased output fields',
    query: baseQuery({ select: [{ field: 'date' }, { field: 'date' }] }),
    message: 'select[1] resolves to duplicate output column "date"'
  },
  {
    name: 'duplicate aliased output fields',
    query: baseQuery({ select: [{ field: 'date', alias: 'value' }, { field: 'gameplays', alias: 'value' }] }),
    message: 'select[1] resolves to duplicate output column "value"'
  },
  {
    name: 'alias colliding with an unaliased field',
    query: baseQuery({ select: [{ field: 'date' }, { field: 'gameplays', alias: 'date' }] }),
    message: 'select[1] resolves to duplicate output column "date"'
  },
  {
    name: 'qualified fields with the same final output segment',
    query: baseQuery({ select: [{ field: 'dbt_p4d_gameplays.p4d_game_id' }, { field: 'pokifordevs_games.p4d_game_id' }] }),
    message: 'select[1] resolves to duplicate output column "p4d_game_id"'
  },
  {
    name: 'non-distinct count with a field',
    query: baseQuery({ select: [{ field: 'p4d_game_id', aggregate: 'count', alias: 'rows' }] }),
    message: 'select[0] must omit field, formula, function, and constant for non-distinct count'
  },
  {
    name: 'distinct count without a field',
    query: baseQuery({ select: [{ aggregate: 'count', distinct: true, alias: 'games' }] }),
    message: 'select[0] must contain exactly one expression source'
  },
  {
    name: 'multiple expression sources',
    query: baseQuery({ select: [{ alias: 'ambiguous', formula: { operator: '+', terms: [{ constant: 1 }] }, function: { name: 'number', args: [{ constant: 2 }] } }] }),
    message: 'select[0] must contain exactly one expression source'
  },
  {
    name: 'constant combined with a formula',
    query: baseQuery({ select: [{ alias: 'ambiguous', constant: 1, formula: { operator: '+', terms: [{ constant: 2 }] } }] }),
    message: 'select[0] must contain exactly one expression source'
  },
  {
    name: 'aggregate combined with a constant',
    query: baseQuery({ select: [{ alias: 'ignored_sum', aggregate: 'sum', constant: 1 }] }),
    message: 'select[0].aggregate must be omitted for constant expressions'
  },
  {
    name: 'distinct on a non-count aggregate',
    query: baseQuery({ select: [{ field: 'gameplays', aggregate: 'sum', distinct: true }] }),
    message: 'select[0].distinct is supported only with count'
  },
  {
    name: 'weight on an aggregate other than topKWeighted',
    query: baseQuery({ select: [{ field: 'gameplays', aggregate: 'sum', weight: 'daily_playing_users' }] }),
    message: 'select[0].weight is supported only with topKWeighted'
  },
  {
    name: 'val on an aggregate other than argMax',
    query: baseQuery({ select: [{ field: 'gameplays', aggregate: 'max', val: 'date' }] }),
    message: 'select[0].val is supported only with argMax'
  },
  {
    name: 'level on an aggregate other than quantileTDigest',
    query: baseQuery({ select: [{ field: 'gameplays', aggregate: 'avg', level: 0.5 }] }),
    message: 'select[0].level is supported only with quantileTDigest'
  },
  {
    name: 'topKWeighted without weight',
    query: baseQuery({ select: [{ field: 'p4d_game_id', aggregate: 'topKWeighted', alias: 'top_games' }] }),
    message: 'select[0].weight is required for topKWeighted'
  },
  {
    name: 'argMax without val',
    query: baseQuery({ select: [{ field: 'p4d_game_id', aggregate: 'argMax', alias: 'latest' }] }),
    message: 'select[0].val is required for argMax'
  },
  {
    name: 'quantileTDigest without level',
    query: baseQuery({ select: [{ field: 'gameplays', aggregate: 'quantileTDigest', alias: 'p50' }] }),
    message: 'select[0].level is required for quantileTDigest'
  },
  {
    name: 'quantileTDigest with out-of-range level',
    query: baseQuery({ select: [{ field: 'gameplays', aggregate: 'quantileTDigest', level: 1.5, alias: 'p150' }] }),
    message: 'select[0].level must be a number from 0.01 through 0.99'
  },
  {
    name: 'formula with unsupported operator',
    query: baseQuery({ select: [{ alias: 'ratio', formula: { operator: '%', terms: [{ field: 'gameplays' }] } }] }),
    message: 'select[0].formula.operator must be a supported formula operator'
  },
  {
    // The validator enforces non-empty terms; it has no per-operator arity.
    name: 'formula with empty terms',
    query: baseQuery({ select: [{ alias: 'ratio', formula: { operator: '/', terms: [] } }] }),
    message: 'select[0].formula.terms must be a non-empty array'
  },
  {
    name: 'formula with a non-object term',
    query: baseQuery({ select: [{ alias: 'ratio', formula: { operator: '+', terms: ['gameplays'] } }] }),
    message: 'select[0].formula.terms[0] must be a select statement'
  },
  {
    name: 'order with invalid direction',
    query: baseQuery({ order: [{ field: 'date', direction: 'sideways' }] }),
    message: 'order[0].direction must be asc or desc'
  },
  {
    name: 'include with a non-object entry',
    query: baseQuery({ include: { p4d_game_id: 'games' } }),
    message: 'include.p4d_game_id must be an object'
  },
  {
    name: 'include entry with an unsupported key',
    query: baseQuery({ include: { p4d_game_id: { type: 'games', extra: true } } }),
    message: 'include.p4d_game_id contains unsupported key'
  },
  {
    name: 'include entry with an unknown resource type',
    query: baseQuery({ include: { p4d_game_id: { type: 'unknown_resources' } } }),
    message: 'include.p4d_game_id.type must be a supported resource type'
  },
  {
    name: 'include key that is not a selected output',
    query: baseQuery({ include: { p4d_game_id: { type: 'games' } } }),
    message: 'include.p4d_game_id must match a selected output column'
  },
  {
    name: 'include key using the source field instead of its selected alias',
    query: baseQuery({ select: [{ field: 'p4d_game_id', alias: 'game_id' }], include: { p4d_game_id: { type: 'games' } } }),
    message: 'include.p4d_game_id must match a selected output column'
  },
  {
    name: 'empty IN values',
    query: baseQuery({ where: { expressions: [['country_id', 'in', []]] } }),
    message: 'where.expressions[0][2] must be a non-empty array'
  },
  {
    name: 'array value with a scalar operator',
    query: baseQuery({ where: { expressions: [['country_id', '==', ['US']]] } }),
    message: 'where.expressions[0][2] must not be an array'
  },
  {
    name: 'non-finite scalar comparison value',
    query: baseQuery({ where: { expressions: [['gameplays', '>', Number.NaN]] } }),
    message: 'where.expressions[0][2] must be a primitive string, finite number, or boolean value'
  },
  {
    name: 'non-finite IN array value',
    query: baseQuery({ where: { expressions: [['gameplays', 'in', [1, Number.POSITIVE_INFINITY]]] } }),
    message: 'where.expressions[0][2] must be a non-empty array of primitive string, finite number, or boolean values'
  },
  {
    name: 'numeric LIKE literal',
    query: baseQuery({ where: { expressions: [['browser_name', 'like', 1]] } }),
    message: 'where.expressions[0][2] must be a literal string pattern or a select-statement expression'
  },
  {
    name: 'boolean ILIKE literal',
    query: baseQuery({ where: { expressions: [['browser_name', 'ilike', false]] } }),
    message: 'where.expressions[0][2] must be a literal string pattern or a select-statement expression'
  },
  {
    name: 'invalid object as a scalar comparison expression',
    query: baseQuery({ where: { expressions: [['gameplays', '>', { arbitrary: true }]] } }),
    message: 'where.expressions[0][2] contains unsupported key: arbitrary'
  },
  {
    name: 'condition on topKWeighted',
    query: baseQuery({ select: [{ field: 'p4d_game_id', aggregate: 'topKWeighted', weight: 'gameplays', condition: { expressions: [['gameplays', '>', 0]] } }] }),
    message: 'select[0].condition is supported only with avg, count, sum, min, or max'
  },
  {
    name: 'numeric aggregate of string function',
    query: baseQuery({ select: [{ aggregate: 'sum', alias: 'bad', function: { name: 'lower', args: [{ field: 'country_id' }] } }] }),
    message: 'select[0].function cannot produce a string for the sum aggregate'
  },
  {
    name: 'zero limit',
    query: baseQuery({ limit: 0 }),
    message: 'Query limit must be a positive integer'
  },
  {
    name: 'negative limit',
    query: baseQuery({ limit: -10 }),
    message: 'Query limit must be a positive integer'
  },
  {
    // The validator sets no upper limit bound; non-integers are the other
    // rejected shape besides values below 1.
    name: 'fractional limit',
    query: baseQuery({ limit: 2.5 }),
    message: 'Query limit must be a positive integer'
  },
  {
    name: 'negative offset',
    query: baseQuery({ offset: -1 }),
    message: 'Query offset must be a non-negative integer'
  },
  {
    name: 'non-array group',
    query: baseQuery({ group: 'date' }),
    message: 'Query group must be an array of field names'
  },
  {
    name: 'nested condition with invalid logical operator',
    query: baseQuery({ where: { expressions: [{ operator: 'xor', expressions: [['date', '==', '2026-08-01']] }] } }),
    message: 'where.expressions[0].operator must be and or or'
  },
  {
    name: 'top-level OR condition that the backend would rewrite to AND',
    query: baseQuery({ where: { operator: 'or', expressions: [['date', '==', '2026-08-01'], ['date', '==', '2026-08-02']] } }),
    message: 'where.operator must be and at the top level'
  },
  {
    name: 'field name with uppercase letters',
    query: baseQuery({ from: 'Gameplays' }),
    message: 'Query field "from" must be a valid lowercase field name'
  },
  {
    name: 'field name over the 63-character maximum',
    query: baseQuery({ from: 'a'.repeat(64) }),
    message: 'Query field "from" must be a valid lowercase field name'
  },
  {
    name: 'field name with a trailing dot',
    query: baseQuery({ select: [{ field: 'gameplays.' }] }),
    message: 'select[0].field must be a valid lowercase field name'
  },
  {
    name: 'field referencing an internal segment',
    query: baseQuery({ select: [{ field: 'games._secret' }] }),
    message: 'select[0].field cannot reference internal fields'
  }
]

for (const entry of negativeCases) {
  void test(`validateDataQuery rejects ${entry.name}`, () => {
    assert.throws(() => validateDataQuery(entry.query), (error: unknown) => {
      assert.ok(error instanceof CliError, `${entry.name}: expected a CliError, got ${String(error)}`)
      assert.equal(error.code, 'INVALID_INPUT', entry.name)
      assert.equal(error.exitCode, 2, entry.name)
      assert.ok(error.message.includes(entry.message), `${entry.name}: got "${error.message}"`)
      return true
    })
  })
}

void test('validateDataQuery rejects null for every comparison operator', () => {
  for (const operator of comparisonOperators) {
    assert.throws(() => validateDataQuery(baseQuery({
      where: { expressions: [['value', operator, null]] }
    })), (error: unknown) => {
      assert.ok(error instanceof CliError, `${operator}: expected a CliError, got ${String(error)}`)
      assert.equal(error.code, 'INVALID_INPUT', operator)
      return true
    })
  }
})

void test('validateDataQuery accepts the documented minimal query shape', () => {
  assert.doesNotThrow(() => validateDataQuery({
    from: 'dbt_p4d_gameplays',
    select: [
      { field: 'date' },
      { field: 'gameplays', aggregate: 'sum', alias: 'gameplays' }
    ],
    where: {
      expressions: [
        ['team_id', '==', 'team-1'],
        ['p4d_game_id', '==', 'game-1'],
        ['date', '>=', '2026-07-01'],
        ['date', '<=', '2026-07-31']
      ]
    },
    group: ['date'],
    order: [{ field: 'date', direction: 'asc' }],
    limit: 1000
  }))
})

void test('validateDataQuery accepts every aggregate with its required companions', () => {
  assert.doesNotThrow(() => validateDataQuery(baseQuery({
    select: [
      { field: 'p4d_game_id', aggregate: 'count', alias: 'rows', distinct: true },
      { field: 'p4d_game_id', aggregate: 'topKWeighted', weight: 'gameplays', alias: 'top_games' },
      { field: 'date', aggregate: 'argMax', val: 'gameplays', alias: 'best_day' },
      { field: 'gameplays', aggregate: 'quantileTDigest', level: 0.5, alias: 'p50' },
      { alias: 'total', formula: { operator: '+', terms: [{ field: 'gameplays' }, { constant: 1 }] } },
      { alias: 'label', function: { name: 'concat', args: [{ field: 'p4d_game_id' }, { constant: '-suffix' }] } },
      { field: 'p4d_game_id' }
    ],
    include: { p4d_game_id: { type: 'games' } },
    order: [{ field: 'date', direction: 'desc', numeric: true }],
    limit: 100,
    offset: 0
  })))
})

void test('validateDataQuery accepts aggregates over one computed expression source', () => {
  assert.doesNotThrow(() => validateDataQuery(baseQuery({
    select: [
      {
        aggregate: 'sum',
        alias: 'adjusted_gameplays',
        formula: { operator: '+', terms: [{ field: 'gameplays' }, { constant: 1 }] }
      },
      {
        aggregate: 'count',
        distinct: true,
        alias: 'normalized_games',
        function: { name: 'lower', args: [{ field: 'p4d_game_id' }] }
      }
    ]
  })))
})

void test('validateDataQuery accepts an include keyed by the resolved alias', () => {
  assert.doesNotThrow(() => validateDataQuery(baseQuery({
    select: [{ field: 'p4d_game_id', alias: 'game_id' }],
    include: { game_id: { type: 'games' } }
  })))
})

void test('qualified select fields resolve to their final segment for output and includes', () => {
  assert.equal(resolvedSelectOutputName({ field: 'pokifordevs_games.p4d_game_id' }), 'p4d_game_id')
  assert.equal(resolvedSelectOutputName({ field: 'pokifordevs_games.p4d_game_id', alias: 'game_id' }), 'game_id')
  assert.doesNotThrow(() => validateDataQuery(baseQuery({
    select: [{ field: 'pokifordevs_games.p4d_game_id' }],
    include: { p4d_game_id: { type: 'games' } }
  })))
  assert.throws(() => validateDataQuery(baseQuery({
    select: [{ field: 'pokifordevs_games.p4d_game_id' }],
    include: { 'pokifordevs_games.p4d_game_id': { type: 'games' } }
  })), /must match a selected output column/)
})

void test('funnel hash conditions allow only direct exact filters and the canonical derived empty-prefix predicate', () => {
  const from = 'dbt_p4d_game_events_funnel_v2'
  const select = [{ field: 'event' }]
  const exactHash = '-8340446448795919230'

  for (const operator of ['==', '=', ' == ', ' = ']) {
    const canonicalEmptyPrefix = [{ function: { name: 'length', args: [{ field: 'prefix_hashes' }] } }, operator, 0]
    assert.doesNotThrow(() => validateDataQuery({ from, select, where: { expressions: [canonicalEmptyPrefix] } }), operator)
  }
  assert.doesNotThrow(() => validateDataQuery({ from, select, where: { expressions: [['event_hash', '==', exactHash]] } }))
  assert.doesNotThrow(() => validateDataQuery({ from, select, where: { expressions: [['event_hash', '==', { constant: exactHash }]] } }))
  assert.doesNotThrow(() => validateDataQuery({ from, select, where: { expressions: [['prefix_hashes', 'has_any_int64', [exactHash]]] } }))

  for (const expression of [
    [{ function: { name: 'length', args: [{ field: 'prefix_hashes' }] } }, '>', 0],
    [{ function: { name: 'length', args: [{ field: 'prefix_hashes' }] } }, '==', 1],
    [{ function: { name: 'toString', args: [{ field: 'event_hash' }] } }, '==', exactHash],
    ['event', '==', { function: { name: 'toString', args: [{ field: 'event_hash' }] } }]
  ]) {
    assert.throws(() => validateDataQuery({ from, select, where: { expressions: [expression] } }), /unsupported derived condition expression/)
  }
})

void test('funnel hash output allows nested counts without weakening raw hash restrictions', () => {
  const from = 'dbt_p4d_game_events_funnel_v2'
  assert.doesNotThrow(() => validateDataQuery({
    from,
    select: [{
      alias: 'hash_count_plus_one',
      formula: {
        operator: '+',
        terms: [
          { field: 'event_hash', aggregate: 'count', distinct: true },
          { constant: 1 }
        ]
      }
    }]
  }))

  assert.throws(() => validateDataQuery({
    from,
    select: [{
      alias: 'unsafe_hash_plus_one',
      formula: { operator: '+', terms: [{ field: 'event_hash' }, { constant: 1 }] }
    }]
  }), /uses event_hash in an unsupported select expression/)

  // A count protects its output only. Its aggregate condition still has to use
  // an exact string representation for the signed hash.
  assert.throws(() => validateDataQuery({
    from,
    select: [{
      aggregate: 'count',
      alias: 'rows',
      condition: { expressions: [['event_hash', '==', Number('8340446448795919230')]] }
    }]
  }), /must not compare event_hash with a numeric value or numeric-producing expression/)
})

void test('a rejected funnel hash select names the supported forms instead of the output type', () => {
  const from = 'dbt_p4d_game_events_funnel_v2'
  // Both expressions provably return a string and a number of elements, so an
  // agent told the query "would return event_hash as an unsafe signed Int64
  // value" can disprove the claim and retry the same rejected shape forever.
  const stringOutput = {
    alias: 'decorated_hash',
    function: { name: 'concat', args: [{ function: { name: 'toString', args: [{ field: 'event_hash' }] } }, { constant: '!' }] }
  }
  const countOutput = {
    alias: 'prefix_depth',
    aggregate: 'sum',
    function: { name: 'length', args: [{ field: 'prefix_hashes' }] }
  }

  assert.throws(() => validateDataQuery({ from, select: [stringOutput] }), (error: unknown) => {
    assert.ok(error instanceof CliError)
    assert.equal(error.code, 'INVALID_INPUT')
    assert.match(error.message, /select\[0\] uses event_hash in an unsupported select expression/)
    assert.match(error.message, /count, toString\(event_hash\), and groupUniqArray\(toString\(event_hash\)\) are the supported forms/)
    assert.doesNotMatch(error.message, /would return/)
    const details = error.details as Record<string, unknown>
    assert.deepEqual(details.safe_single_value, { alias: 'event_hash', function: { name: 'toString', args: [{ field: 'event_hash' }] } })
    assert.deepEqual(details.safe_distinct_values, { alias: 'event_hashes', aggregate: 'groupUniqArray', function: { name: 'toString', args: [{ field: 'event_hash' }] } })
    assert.deepEqual(details.safe_row_count, { aggregate: 'count', alias: 'events' })
    assert.deepEqual(details.safe_prefix_hashes_condition, [{ function: { name: 'length', args: [{ field: 'prefix_hashes' }] } }, '==', 0])
    return true
  })

  assert.throws(() => validateDataQuery({ from, select: [countOutput] }), (error: unknown) => {
    assert.ok(error instanceof CliError)
    // prefix_hashes has no safe identity output at all, so pointing at
    // toString would send the agent into a second rejected attempt.
    assert.match(error.message, /select\[0\] uses prefix_hashes in an unsupported select expression/)
    assert.match(error.message, /count is the only supported form.*has_any_int64 exact decimal strings/)
    assert.doesNotMatch(error.message, /toString\(prefix_hashes\)/)
    return true
  })

  // The boundary itself is unchanged: the permitted forms still pass and every
  // wrapped bypass still fails.
  assert.doesNotThrow(() => validateDataQuery({ from, select: [{ alias: 'event_hash', function: { name: 'toString', args: [{ field: 'event_hash' }] } }] }))
  assert.doesNotThrow(() => validateDataQuery({ from, select: [{ alias: 'event_hashes', aggregate: 'groupUniqArray', function: { name: 'toString', args: [{ field: 'event_hash' }] } }] }))
  assert.doesNotThrow(() => validateDataQuery({ from, select: [{ aggregate: 'count', alias: 'events' }] }))
  assert.doesNotThrow(() => validateDataQuery({ from, select: [{ field: 'event_hash', aggregate: 'count', distinct: true, alias: 'distinct_hashes' }] }))
  for (const statement of [
    { field: 'event_hash' },
    { field: 'prefix_hashes' },
    { alias: 'lowered', function: { name: 'lower', args: [{ field: 'event_hash' }] } },
    { alias: 'hashes', aggregate: 'groupUniqArray', function: { name: 'toString', args: [{ field: 'prefix_hashes' }] } },
    { alias: 'top_hashes', aggregate: 'topKWeighted', weight: 'gameplays', function: { name: 'toString', args: [{ field: 'event_hash' }] } },
    { alias: 'nested_hash', function: { name: 'toString', args: [{ function: { name: 'toString', args: [{ field: 'event_hash' }] } }] } }
  ]) {
    assert.throws(() => validateDataQuery({ from, select: [statement] }), /unsupported select expression/, JSON.stringify(statement))
  }
})

void test('funnel event hashes reject numeric-producing right-side expressions', () => {
  const from = 'dbt_p4d_game_events_funnel_v2'
  const select = [{ field: 'event' }]
  const exactHash = '-8340446448795919230'

  for (const right of [
    { function: { name: 'number', args: [{ constant: exactHash }] } },
    { function: { name: 'toString', args: [{ function: { name: 'number', args: [{ constant: exactHash }] } }] } },
    { function: { name: 'length', args: [{ constant: exactHash }] } },
    { formula: { operator: '+', terms: [{ constant: exactHash }, { constant: 0 }] } },
    { aggregate: 'count', alias: 'numeric_hash' },
    {
      function: {
        name: 'if',
        args: [
          ['event', '==', { constant: 1 }],
          { constant: exactHash },
          { constant: 0 }
        ]
      }
    }
  ]) {
    assert.throws(
      () => validateDataQuery({ from, select, where: { expressions: [['event_hash', '==', right]] } }),
      /must not compare event_hash with a numeric value or numeric-producing expression/
    )
  }
})

void test('array-valued operators reject JavaScript numbers for event_hash', () => {
  const from = 'dbt_p4d_game_events_funnel_v2'
  const select = [{ field: 'event' }]
  const exactHash = '-8340446448795919230'
  // Number(exactHash) rounds to -8340446448795919000, so accepting the numeric
  // form would silently query a hash that does not exist and return zero rows.
  const roundedHash = Number(exactHash)
  const arrayOperators = ['in', 'has_any_int64', 'has_any_uint64', 'has_any_float64', 'has_any_string']

  for (const operator of arrayOperators) {
    assert.throws(
      () => validateDataQuery({ from, select, where: { expressions: [['event_hash', operator, [roundedHash]]] } }),
      /must not compare event_hash with a numeric value|must be a non-empty array of exact base-10 signed integer strings/,
      `${operator} accepted a numeric hash`
    )
    assert.throws(
      () => validateDataQuery({ from, select, where: { expressions: [['event_hash', operator, [exactHash, roundedHash]]] } }),
      /must not compare event_hash with a numeric value|must be a non-empty array of exact base-10 signed integer strings/,
      `${operator} accepted a numeric hash beside a string`
    )
    assert.doesNotThrow(
      () => validateDataQuery({ from, select, where: { expressions: [['event_hash', operator, [exactHash]]] } }),
      `${operator} rejected the exact string form`
    )
  }

  // The boundary has to hold inside nested statements and aggregate conditions.
  assert.throws(() => validateDataQuery({
    from,
    select: [{ aggregate: 'count', alias: 'n', condition: { expressions: [['event_hash', 'in', [roundedHash]]] } }]
  }), /must not compare event_hash with a numeric value/)
  assert.throws(() => validateDataQuery({
    from,
    select,
    where: { operator: 'or', expressions: [['event_hash', 'has_any_string', [roundedHash]]] }
  }), /must not compare event_hash with a numeric value/)
})

void test('analytics include exposes only reviewed developer resource types', () => {
  assert.deepEqual(includeResourceTypes, [
    'game_versions',
    'games',
    'player_feedback_questions',
    'teams',
    'users'
  ])

  for (const type of [
    'ad_revenue_shares',
    'auditlog',
    'billing',
    'invoices',
    'minimum_guarantees',
    'one_off_payments',
    'upfront_payments'
  ]) {
    assert.throws(
      () => validateDataQuery(baseQuery({ include: { resource_id: { type } } })),
      /must be a supported resource type/,
      type
    )
  }
})

void test('validateDataQuery accepts boundary field names and nested OR conditions', () => {
  const longField = 'a'.repeat(63)
  assert.doesNotThrow(() => validateDataQuery(baseQuery({
    select: [{ field: longField }],
    where: {
      expressions: [
        ['team_id', '==', 'team-1'],
        {
          operator: 'or',
          expressions: [
            ['date', '>=', '2026-07-01'],
            ['country_id', 'in', ['US', 'GB']],
            {
              operator: 'and',
              expressions: [
                ['browser_name', 'ilike', '%chrome%'],
                ['device_type', '==', 'desktop']
              ]
            }
          ]
        }
      ]
    }
  })))
})

void test('validateDataQuery accepts select expressions on applicable condition operands', () => {
  assert.doesNotThrow(() => validateDataQuery(baseQuery({
    where: {
      expressions: [
        [
          { function: { name: 'lower', args: [{ field: 'browser_name' }] } },
          '==',
          { constant: 'chrome' }
        ],
        ['gameplays', '>', { formula: { operator: '+', terms: [{ field: 'benchmark' }, { constant: 1 }] } }],
        ['browser_name', 'ilike', { function: { name: 'concat', args: [{ field: 'pattern_prefix' }, { constant: '%' }] } }],
        ['country_id', 'in', { field: 'allowed_country_ids' }]
      ]
    }
  })))
})

void test('validateDataQuery allows unaliased select statements nested inside computed expressions', () => {
  assert.doesNotThrow(() => validateDataQuery(baseQuery({
    select: [{
      alias: 'adjusted_gameplays',
      formula: {
        operator: '+',
        terms: [
          { function: { name: 'number', args: [{ field: 'gameplays' }] } },
          { constant: 1 }
        ]
      }
    }]
  })))
})

void test('count aliases follow the backend context rules for computed and condition expressions', () => {
  assert.doesNotThrow(() => validateDataQuery(baseQuery({
    select: [{
      alias: 'gameplays_per_day',
      formula: {
        operator: '/',
        terms: [
          { field: 'gameplays', aggregate: 'sum' },
          { field: 'date', aggregate: 'count', distinct: true }
        ]
      }
    }]
  })))

  assert.doesNotThrow(() => validateDataQuery(baseQuery({
    select: [{
      alias: 'rows_as_text',
      function: {
        name: 'toString',
        args: [{ aggregate: 'count' }]
      }
    }]
  })))

  assert.throws(() => validateDataQuery(baseQuery({
    where: { expressions: [[{ aggregate: 'count' }, '>', 0]] }
  })), /where\.expressions\[0\]\[0\]\.alias is required for count/)

  assert.throws(() => validateDataQuery(baseQuery({
    where: { expressions: [['gameplays', '<', { aggregate: 'count' }]] }
  })), /where\.expressions\[0\]\[2\]\.alias is required for count/)
})
