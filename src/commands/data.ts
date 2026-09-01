import type { Argv } from 'yargs'

import { ApiClient } from '../api'
import { requestTimeout, withFormatOption, withTimeoutOption } from './common'
import { findTable, SEMANTIC_CONTRACT_VERSION, tableCatalog, type AggregationKind, type ColumnDefinition, type TableDefinition } from '../data/catalog'
import { dataRecipes, fillRecipe, findRecipe, recipeNamesForTable, recipeParameterNames, recipePlaceholders, type DataRecipe } from '../data/examples'
import { describeQueryTopic, includeResourceTypes, joinPolicy, queryDescription, queryTopics, resolvedSelectOutputName, validateDataQuery } from '../data/grammar'
import { dataMetrics, findMetric } from '../data/metrics'
import { visitSelectExpression } from '../data/select-expression'
import { validateDataQuerySemantics } from '../data/semantics'
import { CliError, inputError } from '../errors'
import { readStructuredSource } from '../input'
import { isRecord } from '../json'
import { jsonValueKind, normalizeJsonApi } from '../jsonapi'
import { structuredFormat, writeStructured } from '../output'
import { getProjectGameId } from '../project'
import { ANALYTICS_TIME_ZONE } from '../timezones'

const provenance = {
  time_zone: ANALYTICS_TIME_ZONE,
  semantic_contract_version: SEMANTIC_CONTRACT_VERSION,
  documentation: {
    bundled: true,
    external_sources_required: false,
    command_contracts: 'poki help --all',
    query_grammar: 'poki data describe all',
    join_rules: 'poki data describe joins',
    tables: 'poki data tables; poki data table TABLE; poki data column TABLE COLUMN',
    metrics: 'poki data metrics; poki data metric NAME',
    recipes: 'poki data recipes; poki data recipe NAME'
  },
  cli_schema_authority: 'The bundled catalog is the authoritative table, join, field, and aggregation contract for this CLI. Unbundled references are rejected until a CLI update adds their contracts.',
  api_authority: 'The deployed API remains authoritative for permissions and final execution of queries that pass the bundled CLI contract.'
}

function withDataRequestOptions (yargs: Argv): Argv {
  return withTimeoutOption(yargs)
    .option('format', {
      describe: 'Executed result encoding',
      choices: ['toon', 'json', 'csv'] as const,
      default: 'toon'
    })
    .option('validate-only', {
      describe: 'Validate locally and print the query without contacting the API',
      type: 'boolean',
      default: false
    })
    .check(argv => {
      if (argv.validateOnly === true && argv.format === 'csv') throw inputError('--format csv requires query execution.')
      return true
    })
}

function columnIndex (column: ColumnDefinition): {
  name: string
  type: string
  nullable: boolean
  summary: string
  aggregation: ColumnDefinition['aggregation']
  enum_values?: string[]
  frontend_name?: string
} {
  const nullable = column.type.startsWith('Nullable(') && column.type.endsWith(')')
  return {
    name: column.name,
    type: nullable ? column.type.slice('Nullable('.length, -1) : column.type,
    nullable,
    summary: column.description,
    aggregation: column.aggregation,
    ...(column.enum_values === undefined ? {} : { enum_values: column.enum_values }),
    ...(column.frontend_name === undefined ? {} : { frontend_name: column.frontend_name })
  }
}

// Curated recommendations are declared by each metric instead of inferred
// from matching column names: identically named measures can have incompatible
// populations or grains (custom-event rows are the canonical example).
function metricTableRecommendations (names: string[], requiredDimensions: string[] = []): Array<Record<string, unknown>> {
  return names.map(name => {
    const table = findTable(name)
    if (table === undefined) throw new Error(`Metric references unknown bundled table '${name}'.`)
    return {
      name: table.name,
      grain: table.grain,
      grain_fields: table.grain_fields,
      population: table.population,
      required_dimensions: requiredDimensions
    }
  })
}

function normalizeIncluded (included: unknown): unknown {
  if (!isRecord(included)) return {}
  const normalized: Record<string, unknown> = {}
  for (const [type, resources] of Object.entries(included)) {
    if (!includeResourceTypes.includes(type as typeof includeResourceTypes[number])) continue
    if (!isRecord(resources)) {
      normalized[type] = {}
      continue
    }
    normalized[type] = Object.fromEntries(Object.entries(resources).map(([id, node]) => {
      const identity = { type, id }
      if (!isRecord(node) || node.type !== type || node.id !== id) return [id, identity]
      try {
        const resource = normalizeJsonApi({ data: node }).data
        return [id, isRecord(resource) && resource.type === type && resource.id === id ? resource : identity]
      } catch (error) {
        return [id, identity]
      }
    }))
  }
  return normalized
}

function analyticsResponseStructure (body: unknown): Record<string, unknown> {
  if (!isRecord(body)) return { document_type: jsonValueKind(body) }
  return {
    document_type: 'object',
    total: {
      present: Object.prototype.hasOwnProperty.call(body, 'total'),
      type: jsonValueKind(body.total),
      non_negative_integer: typeof body.total === 'number' && Number.isInteger(body.total) && body.total >= 0
    },
    header: {
      present: Object.prototype.hasOwnProperty.call(body, 'header'),
      type: jsonValueKind(body.header),
      ...(Array.isArray(body.header)
        ? {
            length: body.header.length,
            all_strings: body.header.every(column => typeof column === 'string'),
            unique: new Set(body.header).size === body.header.length
          }
        : {})
    },
    rows: {
      present: Object.prototype.hasOwnProperty.call(body, 'rows'),
      type: jsonValueKind(body.rows),
      ...(Array.isArray(body.rows) ? { length: body.rows.length, all_objects: body.rows.every(isRecord) } : {})
    }
  }
}

function invalidAnalyticsResponse (message: string, body: unknown): CliError {
  return new CliError('INVALID_API_RESPONSE', message, 5, {
    details: {
      expected: { total: 'non-negative integer', header: 'unique string[]', rows: 'object[]' },
      received_structure: analyticsResponseStructure(body)
    }
  })
}

function freshnessOutputColumn (query: Record<string, unknown>): string | undefined {
  if (query.from !== 'table_update_times' || !Array.isArray(query.select)) return undefined
  const statement = query.select.find(candidate => isRecord(candidate) && resolvedSelectOutputName({ field: candidate.field }) === 'last_updated_at' && candidate.aggregate === undefined && candidate.formula === undefined && candidate.function === undefined && candidate.constant === undefined)
  if (!isRecord(statement)) return undefined
  return resolvedSelectOutputName(statement)
}

const measureAggregationKinds = new Set<AggregationKind>([
  'additive_measure',
  'distinct_count',
  'repeated_measure',
  'row_ratio',
  'window_total'
])

const measureWarningCodes: Partial<Record<AggregationKind, string>> = {
  distinct_count: 'DISTINCT_COUNT_GRAIN',
  repeated_measure: 'REPEATED_MEASURE_GRAIN',
  row_ratio: 'ROW_RATIO_GRAIN',
  window_total: 'WINDOW_TOTAL_OVERLAP'
}

function resolveCatalogColumn (from: TableDefinition, reference: string): { table: TableDefinition, column: ColumnDefinition } | undefined {
  const separator = reference.indexOf('.')
  const table = separator === -1 ? from : findTable(reference.slice(0, separator))
  if (table === undefined) return undefined
  const field = separator === -1 ? reference : reference.slice(separator + 1)
  const column = table.columns.find(candidate => candidate.name === field)
  return column === undefined ? undefined : { table, column }
}

function resultInterpretation (query: Record<string, unknown>): Record<string, unknown> {
  const source = typeof query.from === 'string' ? findTable(query.from) : undefined
  // Execution reaches this helper only after structural, reference, and
  // semantic validation. Keep the fallback shape explicit nevertheless so a
  // future caller cannot accidentally turn missing catalog data into a crash.
  if (source === undefined) {
    return {
      source_contract: null,
      selected_measure_contracts: [],
      notes: [],
      warnings: []
    }
  }

  const selectedMeasureContracts: Array<Record<string, unknown>> = []
  const seen = new Set<string>()
  const addMeasure = (reference: string, output: string): void => {
    const resolved = resolveCatalogColumn(source, reference)
    if (resolved === undefined || !measureAggregationKinds.has(resolved.column.aggregation.kind)) return
    const key = `${output}\u0000${resolved.table.name}\u0000${resolved.column.name}`
    if (seen.has(key)) return
    seen.add(key)
    selectedMeasureContracts.push({
      output,
      source: { table: resolved.table.name, field: resolved.column.name },
      description: resolved.column.description,
      aggregation: resolved.column.aggregation
    })
  }

  if (Array.isArray(query.select)) {
    query.select.forEach((statement, index) => {
      if (typeof statement === 'string') {
        addMeasure(statement, statement.slice(statement.lastIndexOf('.') + 1))
        return
      }
      if (!isRecord(statement)) return
      const output = resolvedSelectOutputName(statement)
      if (output === undefined) return
      visitSelectExpression(statement, {
        field: (field, context) => {
          // Conditions constrain an output but do not contribute a selected
          // value. Weight and argMax value fields do contribute and remain.
          if (!context.inCondition) addMeasure(field, output)
        }
      }, { path: `select[${String(index)}]` })
    })
  }

  const notes: Array<{ code: string, message: string }> = []
  if (source.name === 'dbt_p4d_game_events_v2' || source.name === 'dbt_p4d_game_events_times_v2') {
    notes.push({
      code: 'GAME_EVENT_LIFECYCLE_NORMALIZATION',
      message: queryDescription.game_events.lifecycle_normalization
    })
  }
  if (source.name === 'dbt_p4d_game_events_funnel_v2') {
    notes.push({
      code: 'GAME_EVENT_FUNNEL_KEYS_ARE_OPAQUE',
      message: queryDescription.game_events.funnel_keys
    })
  }

  const warnings = selectedMeasureContracts.flatMap(contract => {
    const aggregation = contract.aggregation as ColumnDefinition['aggregation']
    const code = measureWarningCodes[aggregation.kind]
    return code === undefined
      ? []
      : [{
          code,
          output: contract.output,
          source: contract.source,
          message: aggregation.guidance,
          blocking: false
        }]
  })

  return {
    source_contract: {
      grain: source.grain,
      grain_fields: [...source.grain_fields],
      population: source.population
    },
    ...(source.field_terminology === undefined ? {} : { field_terminology: source.field_terminology }),
    selected_measure_contracts: selectedMeasureContracts,
    notes,
    warnings
  }
}

function normalizeDataResult (body: unknown, query: Record<string, unknown>, recipeName?: string): unknown {
  if (!isRecord(body)) throw invalidAnalyticsResponse('The analytics response was not an object.', body)
  if (typeof body.total !== 'number' || !Number.isInteger(body.total) || body.total < 0 || !Array.isArray(body.header) || body.header.some(column => typeof column !== 'string') || new Set(body.header).size !== body.header.length || !Array.isArray(body.rows) || body.rows.some(row => !isRecord(row))) {
    throw invalidAnalyticsResponse('The analytics response must contain total, header, and rows.', body)
  }

  const totalRows = body.total
  const header = body.header as string[]
  const rows = body.rows as Array<Record<string, unknown>>
  const normalizedRows = rows.map(row => Object.fromEntries(header.flatMap(column => Object.prototype.hasOwnProperty.call(row, column) ? [[column, row[column]]] : [])))
  const returnedRows = normalizedRows.length
  const limit = query.limit === undefined ? 10000 : Number(query.limit)
  const offset = query.offset === undefined ? 0 : Number(query.offset)
  // `total` is not always a count of result rows: for an ungrouped query whose
  // selects are formula or function wrappers rather than bare aggregates, the
  // backend's count query degrades to COUNT(*) over the source rows, so a
  // complete one-row aggregate reports a total in the thousands. The row query
  // is always LIMIT/OFFSET bounded, so a window that came back short of the
  // requested limit is exhausted by construction whatever the total claims;
  // only a full window can have more behind it.
  const hasMore = returnedRows >= limit && offset + returnedRows < totalRows
  const freshnessColumn = freshnessOutputColumn(query)
  const freshnessReturned = freshnessColumn !== undefined && header.includes(freshnessColumn) && normalizedRows.length > 0 && normalizedRows.every(row => typeof row[freshnessColumn] === 'string' && String(row[freshnessColumn]).trim() !== '')
  const warnings: Array<{ code: string, message: string, blocking: boolean }> = []
  if (!freshnessReturned) {
    warnings.push({
      code: 'FRESHNESS_NOT_CHECKED',
      message: 'This query result does not establish source freshness; run poki data freshness separately.',
      blocking: false
    })
  }
  return {
    total: totalRows,
    header: [...header],
    rows: normalizedRows,
    ...(body.included === undefined ? {} : { included: normalizeIncluded(body.included) }),
    meta: {
      evidence: {
        query,
        recipe: recipeName ?? null,
        source: query.from,
        requested: { limit, offset },
        returned: { rows: returnedRows, total_rows: totalRows },
        completeness: {
          // Completeness is "started at the beginning and nothing follows", not
          // "row count equals the reported total": the latter is false for
          // every aggregate whose total counts source rows.
          complete: offset === 0 && !hasMore,
          has_more: hasMore,
          omitted_before_offset: offset > 0
        },
        time_zone: ANALYTICS_TIME_ZONE,
        semantic_validation: { status: 'passed', contract_version: SEMANTIC_CONTRACT_VERSION },
        interpretation: resultInterpretation(query),
        freshness: freshnessReturned
          ? { status: 'returned_in_rows' }
          : { status: 'not_checked', command: 'poki data freshness' },
        warnings
      }
    }
  }
}

function requireResolvedQuery (query: Record<string, unknown>, recipeName?: string): void {
  // A recipe is checked against its own parameters; a user-authored query is
  // checked against every bundled parameter name so a piped, unfilled recipe
  // is still caught. Angle-bracket text that names no recipe parameter is an
  // ordinary string value such as a like pattern.
  const declared = recipeParameterNames(recipeName === undefined ? undefined : findRecipe(recipeName))
  const unresolved = recipePlaceholders(query).filter(name => declared.has(name))
  if (unresolved.length > 0) {
    const reference = recipeName === undefined ? 'poki data recipe NAME' : `poki data recipe ${recipeName}`
    throw inputError('The query contains unresolved recipe placeholders.', {
      unresolved_placeholders: unresolved
    }, `Run \`${reference}\` to see the recipe's parameters, then supply --team/--from-date/--to-date or --param NAME=VALUE.`)
  }
}

async function executeQuery (
  api: ApiClient,
  query: Record<string, unknown>,
  argv: Record<string, unknown>,
  recipeName?: string
): Promise<void> {
  validateDataQuery(query)
  requireResolvedQuery(query, recipeName)
  validateDataQuerySemantics(query)
  if (argv.validateOnly === true) {
    writeStructured({
      local_structure_valid: true,
      local_semantics_valid: true,
      api_validated: false,
      executable: 'unknown',
      query,
      meta: {
        contacted_api: false,
        validation_scope: 'local_structure_and_semantics',
        semantic_contract_version: SEMANTIC_CONTRACT_VERSION,
        provenance
      }
    }, structuredFormat(argv.format))
    return
  }

  const params = new URLSearchParams()
  if (argv.format === 'csv') params.set('csv', '')
  const response = await api.request({
    method: 'POST',
    path: '/_data',
    query: params,
    body: query,
    contentType: 'application/json',
    accept: argv.format === 'csv' ? 'text/csv;base64' : 'application/json',
    responseType: argv.format === 'csv' ? 'text' : 'json',
    timeoutMs: requestTimeout(argv),
    retrySafe: true
  })

  if (argv.format === 'csv') {
    const encoded = String(response.body).trim()
    // The endpoint answers text/csv;base64; anything else (a proxy error
    // page, plain CSV) would decode to binary garbage on stdout.
    if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
      throw new CliError('INVALID_API_RESPONSE', 'The analytics CSV response was not valid base64.', 5, {
        details: {
          expected: 'base64_text',
          received: { kind: 'string', length: encoded.length }
        }
      })
    }
    const csv = Buffer.from(encoded, 'base64').toString('utf8')
    // An empty, whitespace-only, or 204-style body carries no header row. It
    // would print as a successful zero-byte export, which an agent cannot tell
    // apart from a real result.
    if (csv.trim() === '') {
      throw new CliError('INVALID_API_RESPONSE', 'The analytics CSV response contained no header row.', 5, {
        details: {
          expected: 'base64_text decoding to at least a header row',
          received: { kind: 'string', length: encoded.length, decoded_length: csv.length }
        }
      })
    }
    process.stdout.write(csv.endsWith('\n') ? csv : `${csv}\n`)
    return
  }
  writeStructured(normalizeDataResult(response.body, query, recipeName), structuredFormat(argv.format))
}

// One calendar day in milliseconds; date arithmetic happens on UTC-noon
// anchors so DST shifts cannot move the calendar date.
function analyticsDate (daysAgo: number): string {
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: ANALYTICS_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' })
  const [year, month, day] = formatter.format(new Date()).split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day, 12) - daysAgo * 86400000).toISOString().slice(0, 10)
}

function withRecipeParameters (yargs: Argv, includeExecution: boolean): Argv {
  let command: Argv = yargs
    .option('team', { describe: 'TEAM_ID parameter', type: 'string' })
    .option('game', { describe: 'GAME_ID parameter; defaults to project game_id', type: 'string' })
    .option('from-date', { describe: 'FROM_DATE in YYYY-MM-DD Europe/Amsterdam calendar time', type: 'string' })
    .option('to-date', { describe: 'TO_DATE in YYYY-MM-DD Europe/Amsterdam calendar time', type: 'string' })
    .option('last-days', { describe: 'Fill the recipe date or datetime range with the N complete Europe/Amsterdam days ending yesterday', type: 'number' })
    .option('from-datetime', { describe: 'FROM_DATETIME in YYYY-MM-DD HH:mm:ss Europe/Amsterdam local time', type: 'string' })
    .option('to-datetime', { describe: 'TO_DATETIME in YYYY-MM-DD HH:mm:ss Europe/Amsterdam local time', type: 'string' })
    .option('param', { describe: 'Additional or overriding recipe parameter in NAME=VALUE form; repeatable', type: 'array', string: true })
    .check(argv => {
      if (argv.lastDays !== undefined) {
        if (!Number.isInteger(argv.lastDays) || Number(argv.lastDays) < 1) throw inputError('--last-days must be a positive integer.')
        if (argv.fromDate !== undefined || argv.toDate !== undefined || argv.fromDatetime !== undefined || argv.toDatetime !== undefined) {
          throw inputError('--last-days cannot be combined with explicit date or datetime range options.')
        }
      }
      return true
    })
  if (includeExecution) command = withDataRequestOptions(command)
  else command = withFormatOption(command)
  return command
}

function recipeParameters (
  argv: Record<string, unknown>,
  projectGameId: string | undefined,
  accepted: Record<string, string>
): Record<string, string> {
  const parameters: Record<string, string> = {}
  const mappings: Array<[string, string, string | undefined]> = [
    ['TEAM_ID', 'team', undefined],
    ['GAME_ID', 'game', projectGameId],
    ['FROM_DATE', 'fromDate', undefined],
    ['TO_DATE', 'toDate', undefined],
    ['FROM_DATETIME', 'fromDatetime', undefined],
    ['TO_DATETIME', 'toDatetime', undefined]
  ]
  for (const [name, field, fallback] of mappings) {
    const value = argv[field] ?? (accepted[name] === undefined ? undefined : fallback)
    if (typeof value === 'string') parameters[name] = value
  }
  if (argv.lastDays !== undefined) {
    const acceptsDates = accepted.FROM_DATE !== undefined && accepted.TO_DATE !== undefined
    const acceptsDateTimes = accepted.FROM_DATETIME !== undefined && accepted.TO_DATETIME !== undefined
    if (!acceptsDates && !acceptsDateTimes) {
      throw inputError('--last-days requires a recipe with a complete date or datetime range.', { accepted_parameters: Object.keys(accepted) })
    }
    const fromDate = analyticsDate(Number(argv.lastDays))
    const toDate = analyticsDate(1)
    if (acceptsDates) {
      parameters.FROM_DATE = fromDate
      parameters.TO_DATE = toDate
    }
    if (acceptsDateTimes) {
      parameters.FROM_DATETIME = `${fromDate} 00:00:00`
      parameters.TO_DATETIME = `${toDate} 23:59:59`
    }
  }
  for (const raw of Array.isArray(argv.param) ? argv.param.map(String) : []) {
    const separator = raw.indexOf('=')
    // An empty value is legal: some recipe parameters (e.g. LABEL) document
    // an empty string as a meaningful input.
    if (separator <= 0) throw inputError(`Invalid parameter '${raw}'. Use NAME=VALUE.`)
    const name = raw.slice(0, separator)
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw inputError(`Invalid parameter name '${name}'. Use uppercase recipe parameter names.`)
    parameters[name] = raw.slice(separator + 1)
  }
  for (const name of ['FROM_DATE', 'TO_DATE']) {
    if (parameters[name] !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(parameters[name])) throw inputError(`${name} must use YYYY-MM-DD.`)
  }
  for (const name of ['FROM_DATETIME', 'TO_DATETIME']) {
    if (parameters[name] !== undefined && !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(parameters[name])) throw inputError(`${name} must use YYYY-MM-DD HH:mm:ss.`)
  }
  // Both formats sort lexicographically, so string comparison detects an
  // inverted range that would otherwise silently return zero rows.
  for (const [from, to] of [['FROM_DATE', 'TO_DATE'], ['FROM_DATETIME', 'TO_DATETIME']]) {
    if (parameters[from] !== undefined && parameters[to] !== undefined && parameters[from] > parameters[to]) {
      throw inputError(`${from} must not be after ${to}.`, { [from.toLowerCase()]: parameters[from], [to.toLowerCase()]: parameters[to] })
    }
  }
  return parameters
}

function resolveRecipe (
  name: string,
  argv: Record<string, unknown>,
  projectGameId: string | undefined
): { recipe: DataRecipe, query: Record<string, unknown> } {
  const recipe = findRecipe(name)
  if (recipe === undefined) throw inputError(`Unknown data recipe '${name}'.`, { available_recipes: dataRecipes.map(recipe => recipe.name) })

  const supplied = recipeParameters(argv, projectGameId, recipe.parameters)
  const unknown = Object.keys(supplied).filter(parameter => recipe.parameters[parameter] === undefined)
  if (unknown.length > 0) {
    throw inputError('The recipe does not define one or more supplied parameters.', {
      unknown_parameters: unknown,
      accepted_parameters: Object.keys(recipe.parameters)
    })
  }

  return { recipe, query: fillRecipe(recipe.query, supplied) }
}

export function registerDataCommands (yargs: Argv, api: ApiClient): Argv {
  const projectGameId = getProjectGameId()

  return yargs.command('data', 'Discover, validate, and execute Poki for Developers analytics queries', data => data
    .command('query', 'Validate, execute, or export a complete structured query', query => withDataRequestOptions(query)
      .option('query', { describe: 'Query JSON or TOON object, @file, or - for stdin', type: 'string', nargs: 1, demandOption: true }), async argv => {
      await executeQuery(api, await readStructuredSource(argv.query, '--query'), argv)
    })
    .command('run <name>', 'Resolve typed parameters in a bundled recipe, then validate or execute it', run => withRecipeParameters(run, true)
      .positional('name', { describe: 'Recipe name returned by data recipes', type: 'string', demandOption: true })
      .option('limit', { describe: 'Override or set the query row limit', type: 'number' })
      .option('offset', { describe: 'Override or set the query row offset', type: 'number' })
      .check(argv => {
        if (argv.limit !== undefined && (!Number.isInteger(argv.limit) || Number(argv.limit) < 1)) throw inputError('--limit must be a positive integer.')
        if (argv.offset !== undefined && (!Number.isInteger(argv.offset) || Number(argv.offset) < 0)) throw inputError('--offset must be a non-negative integer.')
        return true
      }), async argv => {
      const { query } = resolveRecipe(String(argv.name), argv, projectGameId)
      if (argv.limit !== undefined) query.limit = Number(argv.limit)
      if (argv.offset !== undefined) query.offset = Number(argv.offset)
      await executeQuery(api, query, argv, String(argv.name))
    })
    .command('describe [topic]', 'Describe the analytics query grammar by topic', describe => withFormatOption(describe)
      .positional('topic', { describe: 'Grammar topic; omit for compact index', choices: queryTopics, type: 'string' }), argv => {
      writeStructured({ ...describeQueryTopic(argv.topic), provenance }, structuredFormat(argv.format))
    })
    .command('tables', 'List the existing bundled analytics table snapshot', tables => withFormatOption(tables)
      .option('full', { describe: 'Include column contracts, column counts, and recipe names', type: 'boolean', default: false }), argv => {
      writeStructured({
        data: tableCatalog.map(({ columns, ...table }) => argv.full
          ? { ...table, columns: columns.map(columnIndex), column_count: columns.length, recipes: recipeNamesForTable(table.name) }
          : table),
        meta: {
          total: tableCatalog.length,
          top_level: tableCatalog.filter(table => table.top_level).length,
          join_only: tableCatalog.filter(table => !table.top_level).length,
          join_policy: joinPolicy,
          date_time_zone: ANALYTICS_TIME_ZONE,
          semantic_contract_version: SEMANTIC_CONTRACT_VERSION,
          provenance
        }
      }, structuredFormat(argv.format))
    })
    .command('table <name>', 'Describe one existing analytics table and its compact column index', table => withFormatOption(table)
      .positional('name', { describe: 'Exact bundled table name', type: 'string', demandOption: true }), argv => {
      const found = findTable(argv.name)
      if (found === undefined) throw inputError(`Unknown bundled table '${argv.name}'.`, { available_tables: tableCatalog.map(table => table.name) })
      writeStructured({ data: { ...found, columns: found.columns.map(columnIndex), examples: recipeNamesForTable(found.name) }, meta: { total: found.columns.length, date_time_zone: ANALYTICS_TIME_ZONE, provenance } }, structuredFormat(argv.format))
    })
    .command('column <table> <column>', 'Describe one bundled analytics column', column => withFormatOption(column)
      .positional('table', { describe: 'Exact bundled table name', type: 'string', demandOption: true })
      .positional('column', { describe: 'Exact column name', type: 'string', demandOption: true }), argv => {
      const found = findTable(argv.table)
      if (found === undefined) throw inputError(`Unknown bundled table '${argv.table}'.`, { available_tables: tableCatalog.map(table => table.name) })
      const foundColumn = found.columns.find(column => column.name === argv.column)
      if (foundColumn === undefined) throw inputError(`Unknown column '${argv.column}' on table '${argv.table}'.`, { available_columns: found.columns.map(column => column.name) })
      writeStructured({
        data: { table: found.name, table_description: found.description, top_level: found.top_level, ...(found.join_on === undefined ? {} : { join_on: found.join_on }), ...(found.field_terminology === undefined ? {} : { field_terminology: found.field_terminology }), column: columnIndex(foundColumn), recipes: recipeNamesForTable(found.name) },
        meta: { date_time_zone: ANALYTICS_TIME_ZONE, provenance }
      }, structuredFormat(argv.format))
    })
    .command('metrics', 'List dashboard metric semantics and curated compatible source tables', metrics => withFormatOption(metrics)
      .option('full', { describe: 'Include complete formula objects and table grain recommendations', type: 'boolean', default: false }), argv => {
      writeStructured({
        data: dataMetrics.map(({ formula, ...metric }) => argv.full
          ? { ...metric, formula, table_recommendations: metricTableRecommendations(metric.supported_tables, metric.required_dimensions) }
          : metric),
        meta: { total: dataMetrics.length, provenance }
      }, structuredFormat(argv.format))
    })
    .command('metric <name>', 'Return one complete dashboard metric formula and interpretation', metric => withFormatOption(metric)
      .positional('name', { describe: 'Metric name returned by data metrics', type: 'string', demandOption: true }), argv => {
      const found = findMetric(String(argv.name))
      if (found === undefined) throw inputError(`Unknown data metric '${String(argv.name)}'.`, { available_metrics: dataMetrics.map(metric => metric.name) })
      writeStructured({ data: { ...found, table_recommendations: metricTableRecommendations(found.supported_tables, found.required_dimensions) }, meta: { provenance } }, structuredFormat(argv.format))
    })
    .command('recipes', 'List bundled analytics recipes and typed parameter requirements', recipes => withFormatOption(recipes), argv => {
      writeStructured({ data: dataRecipes.map(({ query, ...recipe }) => ({ ...recipe, placeholders: recipePlaceholders(query) })), meta: { total: dataRecipes.length, date_time_zone: ANALYTICS_TIME_ZONE, provenance } }, structuredFormat(argv.format))
    })
    .command('recipe <name>', 'Return one bundled recipe, optionally with typed parameters filled', recipe => withRecipeParameters(recipe, false)
      .positional('name', { describe: 'Recipe name returned by data recipes', type: 'string', demandOption: true })
      .option('query-only', { describe: 'Emit only the query object', type: 'boolean', default: false }), argv => {
      const { recipe: found, query } = resolveRecipe(String(argv.name), argv, projectGameId)
      writeStructured(argv.queryOnly
        ? query
        : { data: { ...found, query }, meta: { unresolved_placeholders: recipePlaceholders(query), date_time_zone: ANALYTICS_TIME_ZONE, provenance } }, structuredFormat(argv.format))
    })
    .command('freshness', 'Query the existing table_update_times table for source freshness', freshness => withDataRequestOptions(freshness), async argv => {
      await executeQuery(api, {
        from: 'table_update_times',
        select: [{ field: 'table_name' }, { field: 'last_updated_at' }],
        order: [{ field: 'last_updated_at', direction: 'asc' }],
        limit: 10000
        // No recipe name: freshness is a synthesized command query, and
        // meta.evidence.recipe must never name a recipe that cannot be read
        // back with `poki data recipe`.
      }, argv)
    })
    .command('provenance', 'Return bundled analytics snapshot metadata and discovery commands', source => withFormatOption(source), argv => {
      writeStructured({ data: provenance, meta: {} }, structuredFormat(argv.format))
    })
    .demandCommand(1, 'Choose data query, run, describe, tables, table, column, metrics, metric, recipes, recipe, freshness, or provenance.'), () => {})
}
