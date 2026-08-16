import { inputError } from '../errors'
import { analyticsTimeZone } from '../timezones'
import { resolvedSelectOutputName, SelectExpressionFieldContext, visitSelectExpression } from './select-expression'
import { isRecord } from '../json'

export { resolvedSelectOutputName } from './select-expression'

const comparisonOperatorFamilies = {
  scalar: ['==', '=', '!=', '>', '>=', '<', '<='],
  in: ['in'],
  inSet: ['in_set'],
  has: ['has'],
  hasAny: ['has_any_int64', 'has_any_uint64', 'has_any_float64', 'has_any_string'],
  like: ['like', 'not like', 'ilike', 'not ilike']
} as const

export const comparisonOperators = [
  ...comparisonOperatorFamilies.scalar,
  ...comparisonOperatorFamilies.in,
  ...comparisonOperatorFamilies.inSet,
  ...comparisonOperatorFamilies.has,
  ...comparisonOperatorFamilies.hasAny,
  ...comparisonOperatorFamilies.like
] as const

export const aggregates = ['avg', 'count', 'sum', 'min', 'max', 'topKWeighted', 'argMax', 'quantileTDigest', 'groupUniqArray'] as const
export const formulaOperators = ['+', '-', '/', '*', 'coalesce'] as const
export const functions = ['lower', 'upper', 'concat', 'if', 'number', 'toDate', 'toString', 'length'] as const
export const rootKeys = ['from', 'select', 'where', 'group', 'order', 'limit', 'offset', 'include'] as const
export const includeResourceTypes = [
  'game_versions',
  'games',
  'player_feedback_questions',
  'teams',
  'users'
] as const

const funnelHashTable = 'dbt_p4d_game_events_funnel_v2'
const funnelHashFields = ['event_hash', 'prefix_hashes'] as const
type FunnelHashField = typeof funnelHashFields[number]

export const joinPolicy = {
  supported: 'Only combine tables through joins supported by the deployed API and documented by the table metadata. The deployed API is authoritative.',
  shared_fields: 'Matching field names or independently aggregated rows do not prove that two tables can be joined or that their rows describe the same population.',
  unsupported: 'If two tables cannot be joined, do not estimate, infer, interpolate, or fabricate combined values that depend on the missing relationship. State that the data cannot be combined and report only independently supported results separately.'
}

export const queryDescription = {
  description: 'JSON query language accepted by POST /_data. The CLI validates its basic structure and forwards it without injecting filters or rewriting fields.',
  timezone: analyticsTimeZone,
  root_keys: rootKeys,
  root: {
    from: 'Required top-level table name. Use `poki data tables` to discover the bundled snapshot.',
    select: 'Required non-empty array of select statements.',
    where: 'Top-level condition statement: {operator?: "and", expressions: [condition or nested statement, ...]}. The top level is always conjunctive for developer access: omit operator for the normal AND default or set it to and. A top-level or is rejected because the deployed API rewrites it to AND; put OR expressions inside a nested condition statement instead.',
    group: 'Array of field names.',
    order: 'Array of {field, direction?: "asc|desc", numeric?: boolean}. Numeric ordering treats embedded numbers naturally.',
    limit: 'Positive row limit; the server defaults to 10000.',
    offset: 'Non-negative row offset.',
    include: `Map of a selected output column name (the alias when set) to {type: RESOURCE_TYPE}. Valid types: ${includeResourceTypes.join(', ')}. Each row's column value is used as a resource ID; IDs with no match are silently omitted from the response included map.`
  },
  joins: joinPolicy,
  select_statement: {
    expression_source: 'Use exactly one of field, formula, function, or constant. An aggregate may wrap a field, formula, or function, but not a constant. Non-distinct count is the only exception: it takes no expression source.',
    field: 'Field name, optionally qualified with a server-supported join table.',
    alias: 'Output field name; required for count and every top-level computed expression (formula, function, or constant). Top-level output names must be unique. Nested select statements inside computed expressions do not need aliases.',
    aggregate: aggregates,
    distinct: 'Accepted only with count. Set true and provide exactly one field, formula, or function expression to count distinct values.',
    weight: 'Accepted only with topKWeighted; names its required weight column.',
    level: 'Accepted only with quantileTDigest; required quantile from 0.01 through 0.99.',
    val: 'Accepted only with argMax; names its required ordering/value field.',
    condition: 'Optional aggregate condition statement; the server accepts it only with avg, count, sum, min, and max.',
    formula: '{operator, terms: [select statement, ...]}.',
    function: '{name, args: [select statement or, for if argument 1, condition tuple]}.',
    constant: 'Primitive string, number, or boolean value.',
    aggregate_rules: {
      count: 'Set alias and omit every expression source for a normal row count. To count distinct values, set distinct to true and provide exactly one field, formula, or function expression.',
      topKWeighted: 'Despite the name, the result is only the single highest-weighted value (the server builds topKWeighted(1)[...][1]); weight names the weighting column.',
      argMax: 'Returns the field value from the row where val is maximal.',
      quantileTDigest: 'level is the quantile from 0.01 through 0.99; a null result is returned as 0.',
      groupUniqArray: 'Returns the sorted array of distinct expression values; takes no companion fields. For signed funnel hashes, aggregate a toString function over event_hash so every identifier remains exact.'
    },
    signed_int64_hashes: {
      precision: 'dbt_p4d_game_events_funnel_v2.event_hash and prefix_hashes contain signed 64-bit identifiers that may exceed JavaScript safe-integer precision. For this bundled table, the CLI rejects direct hash output, numeric hash comparisons, scalar has on prefix_hashes, and derived hash condition expressions before contacting the API. The sole derived condition exception is the canonical length(prefix_hashes) == 0 empty-prefix predicate.',
      select_one: {
        guidance: 'Make the server emit event_hash as a string with toString(event_hash).',
        example: { alias: 'event_hash', function: { name: 'toString', args: [{ field: 'event_hash' }] } }
      },
      select_distinct: {
        guidance: 'For distinct hashes, use groupUniqArray(toString(event_hash)); applying groupUniqArray directly to event_hash can expose unsafe numeric output.',
        example: { alias: 'event_hashes', aggregate: 'groupUniqArray', function: { name: 'toString', args: [{ field: 'event_hash' }] } }
      }
    },
    function_aggregate_rule: 'sum, avg, min, and max reject string-producing lower, upper, concat, toDate, and toString functions.',
    naming: 'The server names each output column by its alias when set, otherwise by the final segment of its field name after join qualification. The CLI uses that same resolver for duplicate detection, includes, and freshness evidence; qualified fields with the same final segment therefore need distinct aliases. Every top-level computed select (formula, function, constant) requires an alias. Nested select statements inside computed expressions do not produce output columns and do not need aliases.'
  },
  conditions: {
    expression: '[left, operator, right]. Left may be a field name or a validated select-statement expression except where an operator family explicitly requires a plain field. Scalar comparisons, in, and like variants also accept a validated select-statement expression on the right; the backend renders these inline as expressions, not as database subqueries.',
    nested: '{operator: "and|or", expressions: [...]}',
    operators: comparisonOperators,
    right_operands: {
      scalar: {
        operators: comparisonOperatorFamilies.scalar,
        right: 'One string, finite number, or boolean value, or a validated select-statement expression. Null and arrays are rejected. == and = are the same equality; operator matching is case-insensitive.',
        example: ['date', '>=', '2026-07-01']
      },
      in: {
        operators: comparisonOperatorFamilies.in,
        right: 'Non-empty array of string, finite number, or boolean values, or a validated select-statement expression. The backend renders a select statement inline with SelectStatement.SQL(false); it is an expression, not a database subquery.',
        example: ['country_id', 'in', ['US', 'GB']]
      },
      in_set: {
        operators: comparisonOperatorFamilies.inSet,
        right: 'Non-empty array of strings, matched against a comma-separated-set left column: the condition is true when the column contains ANY of the values as a complete list element. Wildcards in values are matched literally. The left side must be a plain field name. No negated form exists.',
        example: ['flags', 'in_set', ['transforms-disabled']]
      },
      has: {
        operators: comparisonOperatorFamilies.has,
        right: 'One string or numeric value matched against an Array-typed left column. The CLI validates the operand shape; the deployed API remains authoritative for the column and element types. Use has_any_int64, not has, for signed funnel prefix hashes so their exact decimal strings are cast to Int64.',
        example: ['tags', 'has', 'beta']
      },
      has_any: {
        operators: comparisonOperatorFamilies.hasAny,
        right: 'Non-empty array of string or numeric values of the element type named by the operator, matched against an Array-typed left column. has_any_int64 requires exact base-10 signed integer strings so 64-bit values never pass through JavaScript numbers. The CLI validates the operand shape; the deployed API remains authoritative for casts, the column, and element types.',
        example: ['prefix_hashes', 'has_any_int64', ['-8340446448795919230']],
        signed_int64_precision: 'dbt_p4d_game_events_funnel_v2.prefix_hashes is Array(Int64). Copy hashes emitted by toString(event_hash) or groupUniqArray(toString(event_hash)) verbatim into has_any_int64 as decimal strings. On that table, the CLI rejects scalar has and every other direct prefix_hashes operator. The sole derived condition exception is [{function: {name: "length", args: [{field: "prefix_hashes"}]}}, "==", 0], which identifies the empty prefix. Never parse or write hashes as JavaScript numbers.'
      },
      like: {
        operators: comparisonOperatorFamilies.like,
        right: 'One literal string pattern using SQL wildcards, or a validated select-statement expression that produces a dynamic pattern. Literal numbers, booleans, null, and arrays are rejected. Literal patterns pass to the database verbatim: % matches any run of characters and _ matches one character. ilike is case-insensitive. Two-word operators take exactly one space.',
        example: ['browser_name', 'ilike', '%chrome%']
      }
    }
  },
  formulas: formulaOperators,
  functions: {
    names: functions,
    rules: {
      concat: 'At least two select-statement arguments.',
      if: 'Exactly three arguments: a condition tuple first, then two select statements.',
      other: 'At least one select-statement argument.'
    }
  },
  limits: {
    default_limit: 10000,
    default_limit_note: 'Applied when limit is omitted; the server documents no maximum.',
    minimum_limit: 1,
    minimum_offset: 0
  },
  security: [
    'Fields and aliases use lowercase letters, digits, underscores, dots, and supported join qualification.',
    'Any field segment beginning with _ is internal and unavailable.',
    'Most normal-user queries must provide a top-level ["team_id", "==", "<own-team-id>"] condition; the API determines which tables are exceptions.',
    'Qualified fields activate only joins supported by the server.',
    'Access failures surface as 404 responses rather than 403.',
    'The bundled catalog is informative. The server remains authoritative for newer tables and columns, joins, permissions, and types — it allows additional tables beyond the bundled snapshot.',
    'Bundled recipes mark their inputs with <UPPERCASE> tokens named by the recipe parameters listed in `poki data recipes`, and those names must be filled before a query executes. Angle-bracket text naming no recipe parameter is an ordinary string value, so patterns such as ["message", "ilike", "%<TAG>%"] execute unchanged.'
  ],
  result: {
    execution: 'Executing a query POSTs it to /_data. Structured output creates a fresh allowlisted total, header, rows, optional included, and meta.evidence envelope; backend metadata and extra document fields are omitted.',
    envelope: '{total: integer, header: string[], rows: object[], included?: object, meta: {evidence}}. total is the number of matching result rows before limit and offset; rows contains the returned window in header order.',
    rows: 'rows is an array of fresh objects keyed by header names and containing only those keys, in header order. Values under those selected keys, including nested arrays and objects, remain intact; backend row keys absent from header are omitted.',
    column_names: 'The server names each output column by its alias when set, otherwise by the final segment of its field name after join qualification. The CLI uses that same rule for includes and freshness evidence, and requires aliases for computed top-level selects plus unique resolved output names, preventing empty or duplicate row keys. A response with duplicate header names is invalid.',
    signed_int64_hashes: 'Funnel event_hash and prefix_hashes identifiers can exceed JavaScript safe-integer precision. Make the server return strings with toString(event_hash) or groupUniqArray(toString(event_hash)), and reuse those strings verbatim in has_any_int64 filters. Derived hash condition expressions are rejected except for the canonical length(prefix_hashes) == 0 empty-prefix predicate.',
    included: 'When the query uses include, the response included value is an object keyed by a reviewed developer JSON:API resource type, each mapping resource IDs to resources. The CLI flattens each valid resource with its standard JSON:API normalization (attributes and relationship data merged into one object). Unsupported response types are omitted, and malformed resources are reduced to their {type, id} identity instead of exposing unreviewed backend data.',
    evidence: 'meta.evidence contains the exact query, recipe name when applicable, source, requested limit and offset, returned and total row counts, completeness and has_more, analytics timezone, freshness status, and structured warnings. Freshness is returned_in_rows only when a selected last_updated_at output contains actual timestamp strings; using table_update_times without that output is not freshness evidence.',
    malformed_response: 'Malformed analytics responses fail closed with structural diagnostics only: document/member types, presence, lengths, and shape booleans. Backend values and arbitrary payload fields are never copied into the error.',
    csv: '--format csv executes the same structured query with the csv parameter and requests text/csv;base64. The CLI base64-decodes the payload and prints it verbatim with exactly one trailing newline; headers come from the server unchanged, so aliasing selects is the only bundled way to control CSV column names. CSV cannot carry meta.evidence: run once as JSON or TOON to inspect completeness before relying on an export. --format csv cannot be combined with --validate-only.',
    validate_only: '--validate-only performs local structural validation without contacting the API and prints {local_structure_valid: true, api_validated: false, executable: "unknown", query, warnings?, meta}. It never claims that the deployed API will accept or execute the query.'
  },
  minimal_example: {
    from: 'dbt_p4d_gameplays',
    select: [
      { field: 'date' },
      { field: 'gameplays', aggregate: 'sum', alias: 'gameplays' }
    ],
    where: {
      expressions: [
        ['team_id', '==', '<TEAM_ID>'],
        ['p4d_game_id', '==', '<GAME_ID>'],
        ['date', '>=', '<FROM_DATE>'],
        ['date', '<=', '<TO_DATE>']
      ]
    },
    group: ['date'],
    order: [{ field: 'date', direction: 'asc' }],
    limit: 1000
  }
}

export const queryTopics = [
  'root',
  'select',
  'conditions',
  'formulas',
  'functions',
  'joins',
  'ordering',
  'timezone',
  'limits',
  'security',
  'result',
  'example',
  'all'
] as const

export type QueryTopic = typeof queryTopics[number]

export function describeQueryTopic (topic?: QueryTopic): Record<string, unknown> {
  if (topic === undefined) {
    return {
      description: queryDescription.description,
      topics: queryTopics,
      timezone: queryDescription.timezone,
      joins: queryDescription.joins,
      minimal_example: queryDescription.minimal_example
    }
  }
  if (topic === 'all') return queryDescription
  if (topic === 'root') return { root_keys: queryDescription.root_keys, root: queryDescription.root }
  if (topic === 'select') return { select_statement: queryDescription.select_statement }
  if (topic === 'conditions') return { conditions: queryDescription.conditions }
  if (topic === 'formulas') return { formulas: queryDescription.formulas }
  if (topic === 'functions') return { functions: queryDescription.functions }
  if (topic === 'joins') return { joins: queryDescription.joins }
  if (topic === 'ordering') return { ordering: queryDescription.root.order }
  if (topic === 'timezone') return { timezone: queryDescription.timezone }
  if (topic === 'limits') return { limits: queryDescription.limits }
  if (topic === 'security') return { security: queryDescription.security }
  if (topic === 'result') return { result: queryDescription.result }
  return { minimal_example: queryDescription.minimal_example }
}

function operatorIsIn (family: readonly string[], operator: string): boolean {
  return family.includes(operator)
}

function rejectUnknownKeys (value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).filter(key => !allowed.includes(key))
  if (unknown.length > 0) {
    throw inputError(`${label} contains unsupported key${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}.`, {
      unsupported_keys: unknown,
      allowed_keys: [...allowed]
    }, 'Run `poki data describe` for the grammar topic index.')
  }
}

function validateField (field: unknown, label: string): void {
  if (typeof field !== 'string' || !/^[a-z0-9](?:[a-z0-9_.]{0,61}[a-z0-9])?$/.test(field)) {
    throw inputError(`${label} must be a valid lowercase field name.`, {
      rule: 'Lowercase letters, digits, underscores, and dots; 1 through 63 characters; must start and end with a letter or digit.'
    })
  }
  if (field.split('.').some(part => part.startsWith('_'))) {
    throw inputError(`${label} cannot reference internal fields.`, {
      rule: 'Field segments beginning with _ are internal and unavailable.'
    })
  }
}

type SelectStatementContext = 'top_level' | 'condition_expression' | 'computed_expression'

function validateConditionExpression (value: unknown, label: string): void {
  if (!Array.isArray(value) || value.length !== 3) {
    throw inputError(`${label} must be a [left, operator, right] tuple.`)
  }

  const [left, operator, right] = value
  if (typeof left === 'string') validateField(left, `${label}[0]`)
  else if (isRecord(left)) validateSelectStatement(left, `${label}[0]`, 'condition_expression')
  else throw inputError(`${label}[0] must be a field name or select expression.`)

  const normalizedOperator = typeof operator === 'string' ? operator.trim().toLowerCase() : ''
  if (!comparisonOperators.includes(normalizedOperator as typeof comparisonOperators[number])) {
    throw inputError(`${label}[1] must be a supported comparison operator.`, {
      supported_operators: [...comparisonOperators]
    }, 'Run `poki data describe conditions` for operator shapes and examples.')
  }

  const finitePrimitive = (item: unknown): boolean => typeof item === 'string' || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))
  if (operatorIsIn(comparisonOperatorFamilies.in, normalizedOperator)) {
    if (isRecord(right)) {
      validateSelectStatement(right, `${label}[2]`, 'condition_expression')
    } else if (!Array.isArray(right) || right.length === 0 || right.some(item => !finitePrimitive(item))) {
      throw inputError(`${label}[2] must be a non-empty array of primitive string, finite number, or boolean values, or a select-statement expression, for the in operator.`)
    }
    return
  }
  if (operatorIsIn(comparisonOperatorFamilies.inSet, normalizedOperator)) {
    if (typeof left !== 'string') throw inputError(`${label}[0] must be a field name for the in_set operator.`)
    if (!Array.isArray(right) || right.length === 0 || right.some(item => typeof item !== 'string')) {
      throw inputError(`${label}[2] must be a non-empty array of strings for the in_set operator.`)
    }
    return
  }
  if (operatorIsIn(comparisonOperatorFamilies.has, normalizedOperator)) {
    if (typeof left !== 'string') throw inputError(`${label}[0] must be a field name for the has operator.`)
    if (!['string', 'number'].includes(typeof right) || (typeof right === 'number' && !Number.isFinite(right))) {
      throw inputError(`${label}[2] must be a scalar string or numeric value for the has operator.`)
    }
    return
  }
  if (normalizedOperator === 'has_any_int64') {
    if (typeof left !== 'string') throw inputError(`${label}[0] must be a field name for the has_any_int64 operator.`)
    if (!Array.isArray(right) || right.length === 0 || right.some(item => typeof item !== 'string' || !/^-?(?:0|[1-9]\d*)$/.test(item))) {
      throw inputError(`${label}[2] must be a non-empty array of exact base-10 signed integer strings for the has_any_int64 operator; use strings, never JavaScript numbers.`)
    }
    return
  }
  if (operatorIsIn(comparisonOperatorFamilies.hasAny, normalizedOperator)) {
    if (typeof left !== 'string') throw inputError(`${label}[0] must be a field name for the ${normalizedOperator} operator.`)
    if (!Array.isArray(right) || right.length === 0 || right.some(item => !['string', 'number'].includes(typeof item) || (typeof item === 'number' && !Number.isFinite(item)))) {
      throw inputError(`${label}[2] must be a non-empty array of string or numeric values for the ${normalizedOperator} operator.`)
    }
    return
  }
  if (operatorIsIn(comparisonOperatorFamilies.like, normalizedOperator)) {
    if (isRecord(right)) {
      validateSelectStatement(right, `${label}[2]`, 'condition_expression')
    } else if (typeof right !== 'string') {
      throw inputError(`${label}[2] must be a literal string pattern or a select-statement expression for the ${normalizedOperator} operator.`)
    }
    return
  }
  if (operatorIsIn(comparisonOperatorFamilies.scalar, normalizedOperator)) {
    if (Array.isArray(right)) {
      throw inputError(`${label}[2] must not be an array for the ${normalizedOperator} operator.`)
    }
    if (isRecord(right)) {
      validateSelectStatement(right, `${label}[2]`, 'condition_expression')
    } else if (!finitePrimitive(right)) {
      throw inputError(`${label}[2] must be a primitive string, finite number, or boolean value, or a select-statement expression, for the ${normalizedOperator} operator.`)
    }
  }
}

function validateConditionStatement (value: unknown, label: string, topLevel = false): void {
  if (!isRecord(value)) throw inputError(`${label} must be a condition statement object.`)
  rejectUnknownKeys(value, ['operator', 'expressions'], label)
  if (value.operator !== undefined && (typeof value.operator !== 'string' || !['and', 'or'].includes(value.operator.toLowerCase()))) {
    throw inputError(`${label}.operator must be and or or.`)
  }
  if (topLevel && typeof value.operator === 'string' && value.operator.toLowerCase() === 'or') {
    throw inputError(`${label}.operator must be and at the top level.`, {
      supported_top_level_operator: 'and',
      nested_operator: 'or'
    }, 'Put OR expressions inside a nested condition statement so the deployed API cannot silently rewrite the requested logic.')
  }
  if (!Array.isArray(value.expressions) || value.expressions.length === 0) {
    throw inputError(`${label}.expressions must be a non-empty array.`)
  }
  value.expressions.forEach((expression, index) => {
    if (Array.isArray(expression)) validateConditionExpression(expression, `${label}.expressions[${index}]`)
    else validateConditionStatement(expression, `${label}.expressions[${index}]`)
  })
}

function validateFormula (value: unknown, label: string): void {
  if (!isRecord(value)) throw inputError(`${label} must be a formula object.`)
  rejectUnknownKeys(value, ['operator', 'terms'], label)
  if (typeof value.operator !== 'string' || !formulaOperators.includes(value.operator as typeof formulaOperators[number])) {
    throw inputError(`${label}.operator must be a supported formula operator.`, {
      supported_operators: [...formulaOperators]
    }, 'Run `poki data describe formulas` for the formula shape.')
  }
  if (!Array.isArray(value.terms) || value.terms.length === 0) throw inputError(`${label}.terms must be a non-empty array.`)
  value.terms.forEach((term, index) => {
    if (!isRecord(term)) throw inputError(`${label}.terms[${index}] must be a select statement.`)
    validateSelectStatement(term, `${label}.terms[${index}]`, 'computed_expression')
  })
}

function validateFunction (value: unknown, label: string): void {
  if (!isRecord(value)) throw inputError(`${label} must be a function object.`)
  rejectUnknownKeys(value, ['name', 'args'], label)
  if (typeof value.name !== 'string' || !functions.includes(value.name as typeof functions[number])) {
    throw inputError(`${label}.name must be a supported function.`, {
      supported_functions: [...functions]
    }, 'Run `poki data describe functions` for argument rules.')
  }
  if (!Array.isArray(value.args)) throw inputError(`${label}.args must be an array.`)
  if (value.name === 'if' && value.args.length !== 3) throw inputError(`${label}.args must contain exactly three arguments for if.`)
  if (value.name === 'concat' && value.args.length < 2) throw inputError(`${label}.args must contain at least two arguments for concat.`)
  if (value.name !== 'if' && value.name !== 'concat' && value.args.length < 1) throw inputError(`${label}.args must not be empty.`)

  value.args.forEach((argument, index) => {
    if (value.name === 'if' && index === 0) {
      validateConditionExpression(argument, `${label}.args[0]`)
      return
    }
    if (!isRecord(argument)) throw inputError(`${label}.args[${index}] must be a select statement.`)
    validateSelectStatement(argument, `${label}.args[${index}]`, 'computed_expression')
  })
}

function validateSelectStatement (
  value: Record<string, unknown>,
  label: string,
  context: SelectStatementContext
): void {
  const keys = ['field', 'alias', 'aggregate', 'distinct', 'weight', 'level', 'val', 'condition', 'formula', 'function', 'constant']
  rejectUnknownKeys(value, keys, label)
  if (value.field !== undefined) validateField(value.field, `${label}.field`)
  if (value.alias !== undefined) validateField(value.alias, `${label}.alias`)
  if (value.weight !== undefined) validateField(value.weight, `${label}.weight`)
  if (value.val !== undefined) validateField(value.val, `${label}.val`)
  if (value.distinct !== undefined && typeof value.distinct !== 'boolean') throw inputError(`${label}.distinct must be a boolean.`)
  if (value.aggregate !== undefined && (typeof value.aggregate !== 'string' || !aggregates.includes(value.aggregate as typeof aggregates[number]))) {
    throw inputError(`${label}.aggregate must be a supported aggregate.`, {
      supported_aggregates: [...aggregates]
    }, 'Run `poki data describe select` for aggregates and their required companion fields.')
  }
  if (value.level !== undefined && (typeof value.level !== 'number' || value.level < 0.01 || value.level > 0.99)) {
    throw inputError(`${label}.level must be a number from 0.01 through 0.99.`)
  }
  if (value.condition !== undefined) validateConditionStatement(value.condition, `${label}.condition`)
  if (value.formula !== undefined) validateFormula(value.formula, `${label}.formula`)
  if (value.function !== undefined) validateFunction(value.function, `${label}.function`)
  if (value.constant !== undefined && !['string', 'number', 'boolean'].includes(typeof value.constant)) {
    throw inputError(`${label}.constant must be a string, number, or boolean.`)
  }

  const expressionSources = [
    value.field !== undefined ? 'field' : undefined,
    value.formula !== undefined ? 'formula' : undefined,
    value.function !== undefined ? 'function' : undefined,
    value.constant !== undefined ? 'constant' : undefined
  ].filter((source): source is string => source !== undefined)
  const nonDistinctCount = value.aggregate === 'count' && value.distinct !== true
  if (nonDistinctCount && expressionSources.length > 0) {
    throw inputError(`${label} must omit field, formula, function, and constant for non-distinct count.`, {
      expression_sources: expressionSources
    })
  }
  if (!nonDistinctCount && expressionSources.length !== 1) {
    throw inputError(`${label} must contain exactly one expression source: field, formula, function, or constant.`, {
      expression_sources: expressionSources
    }, 'Remove the ignored expression source or split the calculation into nested select statements.')
  }
  if (context !== 'computed_expression' && value.aggregate === 'count' && value.alias === undefined) throw inputError(`${label}.alias is required for count.`)
  const computed = value.formula !== undefined || value.function !== undefined || value.constant !== undefined
  if (context === 'top_level' && computed && value.alias === undefined) {
    throw inputError(`${label}.alias is required for a top-level formula, function, or constant expression.`, {
      reason: 'Computed expressions have no field name and would otherwise produce an empty output column.'
    })
  }
  if (value.constant !== undefined && value.aggregate !== undefined) throw inputError(`${label}.aggregate must be omitted for constant expressions.`)
  if (value.distinct !== undefined && value.aggregate !== 'count') throw inputError(`${label}.distinct is supported only with count.`)
  if (value.weight !== undefined && value.aggregate !== 'topKWeighted') throw inputError(`${label}.weight is supported only with topKWeighted.`)
  if (value.val !== undefined && value.aggregate !== 'argMax') throw inputError(`${label}.val is supported only with argMax.`)
  if (value.level !== undefined && value.aggregate !== 'quantileTDigest') throw inputError(`${label}.level is supported only with quantileTDigest.`)
  if (value.condition !== undefined && (typeof value.aggregate !== 'string' || !['avg', 'count', 'sum', 'min', 'max'].includes(value.aggregate))) {
    throw inputError(`${label}.condition is supported only with avg, count, sum, min, or max.`)
  }
  if (isRecord(value.function) && typeof value.aggregate === 'string' && ['sum', 'avg', 'min', 'max'].includes(value.aggregate) && ['concat', 'lower', 'upper', 'toDate', 'toString'].includes(String(value.function.name))) {
    throw inputError(`${label}.function cannot produce a string for the ${value.aggregate} aggregate.`)
  }
  if (value.aggregate === 'topKWeighted' && value.weight === undefined) throw inputError(`${label}.weight is required for topKWeighted.`)
  if (value.aggregate === 'argMax' && value.val === undefined) throw inputError(`${label}.val is required for argMax.`)
  if (value.aggregate === 'quantileTDigest' && value.level === undefined) throw inputError(`${label}.level is required for quantileTDigest.`)
}

function validateOrder (value: unknown, label: string): void {
  if (!isRecord(value)) throw inputError(`${label} must be an order object.`)
  rejectUnknownKeys(value, ['field', 'direction', 'numeric'], label)
  validateField(value.field, `${label}.field`)
  if (value.direction !== undefined && (typeof value.direction !== 'string' || !['asc', 'desc'].includes(value.direction.toLowerCase()))) {
    throw inputError(`${label}.direction must be asc or desc.`)
  }
  if (value.numeric !== undefined && typeof value.numeric !== 'boolean') throw inputError(`${label}.numeric must be a boolean.`)
}

function funnelHashField (value: unknown): FunnelHashField | undefined {
  if (typeof value !== 'string') return undefined
  return funnelHashFields.find(field => value === field || value === `${funnelHashTable}.${field}`)
}

/**
 * Every signed-hash field an expression reads, narrowed to the field positions
 * a caller cares about. The select and condition boundaries ask different
 * questions about the same expression tree and walk it through one definition:
 * a second copy is how one of them ends up missing a nesting form the other
 * already rejects.
 */
function hashReferences (
  value: unknown,
  accept: (context: SelectExpressionFieldContext) => boolean = () => true
): Set<FunnelHashField> {
  const references = new Set<FunnelHashField>()
  const add = (field: string): void => {
    const reference = funnelHashField(field)
    if (reference !== undefined) references.add(reference)
  }

  if (typeof value === 'string') add(value)
  else if (isRecord(value)) {
    visitSelectExpression(value, {
      field: (field, context) => {
        if (accept(context)) add(field)
      }
    })
  }
  return references
}

// A select statement emits a hash only through a value position it does not
// count: count emits a count rather than the wrapped expression, and conditions
// are validated separately and never inherit that output exemption.
const emitsHashOutput = (context: SelectExpressionFieldContext): boolean =>
  context.role === 'value' && !context.inCondition && !context.counted

function isExactEventHashStringSelect (statement: Record<string, unknown>): boolean {
  if (!isRecord(statement.function) || statement.function.name !== 'toString' || !Array.isArray(statement.function.args) || statement.function.args.length !== 1) return false
  const argument = statement.function.args[0]
  return isRecord(argument) && funnelHashField(argument.field) === 'event_hash' && argument.aggregate === undefined && argument.formula === undefined && argument.function === undefined && argument.constant === undefined
}

function validateFunnelHashSelect (statement: Record<string, unknown>, label: string): void {
  const references = hashReferences(statement, emitsHashOutput)
  if (references.size === 0) return

  // Safe public hash output is deliberately limited to the documented
  // server-side string form. count boundaries were removed by the visitor.
  if (isExactEventHashStringSelect(statement) && (statement.aggregate === undefined || statement.aggregate === 'groupUniqArray')) return

  const field = references.has('prefix_hashes') ? 'prefix_hashes' : 'event_hash'
  // The rejected expression may well produce a string or a count. What makes it
  // unsupported is that it reads a signed Int64 hash outside the exact forms
  // the backend renders safely, so the message names those forms instead of
  // claiming an output type an agent can disprove and argue with.
  const supported = field === 'event_hash'
    ? 'count, toString(event_hash), and groupUniqArray(toString(event_hash)) are the supported forms'
    : 'count is the only supported form, and prefix_hashes may be filtered with has_any_int64 exact decimal strings'
  throw inputError(`${label} uses ${field} in an unsupported select expression; ${supported}.`, {
    table: funnelHashTable,
    field,
    safe_row_count: { aggregate: 'count', alias: 'events' },
    safe_single_value: { alias: 'event_hash', function: { name: 'toString', args: [{ field: 'event_hash' }] } },
    safe_distinct_values: { alias: 'event_hashes', aggregate: 'groupUniqArray', function: { name: 'toString', args: [{ field: 'event_hash' }] } },
    safe_prefix_hashes_condition: [{ function: { name: 'length', args: [{ field: 'prefix_hashes' }] } }, '==', 0]
  }, 'Select event_hash through toString, aggregate distinct hashes with groupUniqArray(toString(event_hash)), count rows with count, and use prefix_hashes only with has_any_int64 exact decimal strings or the canonical length(prefix_hashes) == 0 condition.')
}

function conditionOperandProducesNumber (value: unknown): boolean {
  if (typeof value === 'number') return true
  if (!isRecord(value)) return false

  let producesNumber = false
  visitSelectExpression(value, {
    select: (statement, context) => {
      if (context.inCondition) return
      const functionName = isRecord(statement.function) ? statement.function.name : undefined
      const formulaOperator = isRecord(statement.formula) ? statement.formula.operator : undefined
      if (
        typeof statement.constant === 'number' ||
        functionName === 'number' ||
        functionName === 'length' ||
        (typeof formulaOperator === 'string' && formulaOperator !== 'coalesce') ||
        ['count', 'sum', 'avg', 'quantileTDigest'].includes(String(statement.aggregate))
      ) {
        producesNumber = true
      }
    }
  })
  return producesNumber
}

// Array-valued operators (in, has_any_*) carry their operands one level down,
// so the scalar check alone would let a rounded Int64 hash through.
function conditionOperandContainsNumber (value: unknown): boolean {
  if (Array.isArray(value)) return value.some(conditionOperandContainsNumber)
  return conditionOperandProducesNumber(value)
}

function directConditionHashField (value: unknown): FunnelHashField | undefined {
  if (typeof value === 'string') return funnelHashField(value)
  if (!isRecord(value)) return undefined
  const keys = Object.keys(value)
  return keys.length === 1 && keys[0] === 'field' ? funnelHashField(value.field) : undefined
}

function isCanonicalEmptyPrefixCondition (value: unknown[], operator: string): boolean {
  if (value.length !== 3 || !['==', '='].includes(operator) || value[2] !== 0) return false
  const left = value[0]
  if (!isRecord(left) || Object.keys(left).length !== 1 || !isRecord(left.function) || Object.keys(left.function).length !== 2) return false
  const functionExpression = left.function
  if (functionExpression.name !== 'length' || !Array.isArray(functionExpression.args) || functionExpression.args.length !== 1) return false
  const argument = functionExpression.args[0]
  return isRecord(argument) && Object.keys(argument).length === 1 && funnelHashField(argument.field) === 'prefix_hashes'
}

function validateFunnelHashCondition (value: unknown[], label: string): void {
  const operator = typeof value[1] === 'string' ? value[1].trim().toLowerCase() : undefined
  if (value.length !== 3 || operator === undefined || !comparisonOperators.includes(operator as typeof comparisonOperators[number])) return

  const left = value[0]
  const right = value[2]
  const directField = directConditionHashField(left)
  const leftReferences = hashReferences(left)
  const rightReferences = isRecord(right) ? hashReferences(right) : new Set<FunnelHashField>()
  const references = new Set([...leftReferences, ...rightReferences])

  if (references.size > 0 && isCanonicalEmptyPrefixCondition(value, operator)) return

  if (references.size > 0 && (directField === undefined || rightReferences.size > 0 || leftReferences.size !== 1 || !leftReferences.has(directField))) {
    const field = references.has('prefix_hashes') ? 'prefix_hashes' : 'event_hash'
    throw inputError(`${label} uses ${field} through an unsupported derived condition expression.`, {
      table: funnelHashTable,
      field,
      allowed_derived_condition: [{ function: { name: 'length', args: [{ field: 'prefix_hashes' }] } }, '==', 0]
    }, 'Use only the canonical length(prefix_hashes) == 0 predicate for the empty-prefix case; filter prefix_hashes directly with has_any_int64 exact strings and event_hash directly without JavaScript numbers.')
  }
  if (directField === 'prefix_hashes' && operator !== 'has_any_int64') {
    throw inputError(`${label} must filter prefix_hashes with has_any_int64.`, {
      table: funnelHashTable,
      rejected_operator: operator,
      required_operator: 'has_any_int64'
    }, 'Pass a non-empty array of exact base-10 signed-integer strings copied from toString(event_hash) output.')
  }
  if (directField === 'event_hash' && conditionOperandContainsNumber(right)) {
    throw inputError(`${label} must not compare event_hash with a numeric value or numeric-producing expression.`, {
      table: funnelHashTable,
      field: 'event_hash',
      rejected_representation: 'numeric_value_or_expression'
    }, 'Use an exact base-10 decimal string so neither JSON parsing nor server-side numeric conversion can round the signed Int64 identifier.')
  }
}

function validateFunnelHashConditions (query: Record<string, unknown>): void {
  const visitor = {
    condition: (expression: unknown[], context: { path: string }) => validateFunnelHashCondition(expression, context.path)
  }
  if (Array.isArray(query.select)) {
    query.select.forEach((statement, index) => {
      if (isRecord(statement)) visitSelectExpression(statement, visitor, { path: `query.select[${index}]` })
    })
  }
  if (query.where !== undefined) {
    visitSelectExpression(query.where, visitor, { root: 'condition', path: 'query.where' })
  }
}

export function validateDataQuery (query: Record<string, unknown>): void {
  rejectUnknownKeys(query, rootKeys, 'Query')
  validateField(query.from, 'Query field "from"')
  if (!Array.isArray(query.select) || query.select.length === 0) throw inputError('Query field "select" must be a non-empty array.')
  const outputNames = new Map<string, number>()
  query.select.forEach((statement, index) => {
    if (!isRecord(statement)) throw inputError(`select[${index}] must be an object.`)
    validateSelectStatement(statement, `select[${index}]`, 'top_level')
    const outputName = resolvedSelectOutputName(statement)
    if (typeof outputName === 'string') {
      const previousIndex = outputNames.get(outputName)
      if (previousIndex !== undefined) {
        throw inputError(`select[${index}] resolves to duplicate output column "${outputName}".`, {
          output_name: outputName,
          first_select_index: previousIndex,
          duplicate_select_index: index
        }, 'Give each top-level select a unique alias so structured result rows cannot overwrite columns.')
      }
      outputNames.set(outputName, index)
    }
  })
  if (query.from === funnelHashTable) {
    query.select.forEach((statement, index) => {
      if (isRecord(statement)) validateFunnelHashSelect(statement, `select[${index}]`)
    })
    validateFunnelHashConditions(query)
  }
  if (query.limit !== undefined && (!Number.isInteger(query.limit) || Number(query.limit) < 1)) {
    throw inputError('Query limit must be a positive integer.')
  }
  if (query.offset !== undefined && (!Number.isInteger(query.offset) || Number(query.offset) < 0)) {
    throw inputError('Query offset must be a non-negative integer.')
  }
  if (query.group !== undefined) {
    if (!Array.isArray(query.group)) throw inputError('Query group must be an array of field names.')
    query.group.forEach((field, index) => validateField(field, `group[${index}]`))
  }
  if (query.order !== undefined) {
    if (!Array.isArray(query.order)) throw inputError('Query order must be an array.')
    query.order.forEach((order, index) => validateOrder(order, `order[${index}]`))
  }
  if (query.where !== undefined) validateConditionStatement(query.where, 'where', true)
  if (query.include !== undefined) {
    if (!isRecord(query.include)) throw inputError('Query include must be an object.')
    for (const [field, include] of Object.entries(query.include)) {
      validateField(field, `include.${field}`)
      if (!isRecord(include)) throw inputError(`include.${field} must be an object.`)
      rejectUnknownKeys(include, ['type'], `include.${field}`)
      if (typeof include.type !== 'string' || !includeResourceTypes.includes(include.type as typeof includeResourceTypes[number])) {
        throw inputError(`include.${field}.type must be a supported resource type.`, {
          supported_types: [...includeResourceTypes]
        })
      }
      if (!outputNames.has(field)) {
        throw inputError(`include.${field} must match a selected output column.`, {
          include_key: field,
          selected_output_columns: [...outputNames.keys()]
        }, 'Use the selected alias when one is set; otherwise use the selected field name.')
      }
    }
  }
}
