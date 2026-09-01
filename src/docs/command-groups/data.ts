import { queryTopics } from '../../data/grammar'
import { ANALYTICS_TIME_ZONE } from '../../timezones'
import type { HelpArgument, HelpOption } from '../commands'
import type { CommandSpecBuilder } from './types'

export function addDataCommandSpecs ({ add, apiAction, argument, example, formatOption, group, option, timeoutOption }: CommandSpecBuilder): void {
  group('data', 'Discover, validate, and execute analytics through the bundled catalog.', [
    'A recipe is a bundled, parameterized query: poki data recipes lists them, poki data recipe NAME shows its typed parameters, and poki data run NAME executes it. Start with recipes before writing raw queries.',
    'poki data describe documents the query grammar topic by topic; poki data tables, table, column, metrics, and metric document the bundled vocabulary offline.',
    'Every bundled field has a machine-readable aggregation contract. Unknown references and incompatible rollups fail locally before any API request; inspect poki data column TABLE COLUMN and poki data describe aggregation when correcting a query.',
    'For Game Events, communicate with users using frontend Category, What, and Action, but query backend fields category, action, and label respectively. Run poki data describe game-events for the mapping and examples.',
    'dbt_p4d_game_events_funnel_v2 hashes are signed Int64 identifiers that may exceed JavaScript safe-integer precision. Select them with toString(event_hash), aggregate them with groupUniqArray(toString(event_hash)), and pass exact decimal strings to has_any_int64; never use JavaScript numbers. The CLI rejects unsafe direct output, numeric comparisons, scalar has, and derived hash conditions other than the canonical length(prefix_hashes) == 0 empty-prefix predicate before contacting the API.',
    'The end-to-end reporting flow is documented at poki help workflows.',
    `Analytics dates use ${ANALYTICS_TIME_ZONE} calendar time.`
  ])
  const dataRequestOptions = [option('--validate-only', 'boolean', 'Validate local structure and bundled aggregation semantics without API access; output explicitly sets api_validated false and executable unknown.', { default: false }), option('--format', 'enum', 'Structured output encoding.', { default: 'toon', values: ['toon', 'json', 'csv'] }), timeoutOption]
  const dataOutput = {
    analytics_time_zone: ANALYTICS_TIME_ZONE,
    formats: ['toon', 'json', 'csv'],
    structured_shape: { total: 'integer', header: 'string[]', rows: 'object[]', included: 'optional normalized resource map', meta: { evidence: 'query, source, requested and returned rows, completeness, timezone, semantic validation, interpretation, freshness, warnings' } },
    csv_note: 'CSV contains only server columns. Run JSON or TOON first to inspect meta.evidence.',
    normalization: 'The CLI creates a fresh envelope from total, a unique header, rows, optional normalized included resources, and CLI evidence. Row keys absent from header and all backend document metadata or extra top-level fields are omitted; values of selected header columns remain intact. Qualified unaliased fields resolve to their final segment, matching the server and the include and freshness contracts.',
    signed_int64_hashes: 'For dbt_p4d_game_events_funnel_v2, select event_hash through toString and aggregate through groupUniqArray(toString(event_hash)); filter prefix_hashes with has_any_int64 and exact base-10 decimal strings, never JavaScript numbers. Unsafe direct hash output, numeric hash comparisons, scalar has, and derived hash conditions other than length(prefix_hashes) == 0 fail locally without API access.'
  }
  const recipeParameterOptions = [
    option('--team', 'string', 'TEAM_ID parameter; discover it with poki whoami.'),
    option('--game', 'string', 'GAME_ID parameter; defaults to project game_id.'),
    option('--from-date', 'date', `FROM_DATE in ${ANALYTICS_TIME_ZONE}.`),
    option('--to-date', 'date', `TO_DATE in ${ANALYTICS_TIME_ZONE}.`),
    option('--last-days', 'positive integer', `Fill the recipe's FROM_DATE/TO_DATE or FROM_DATETIME/TO_DATETIME pair with the N complete ${ANALYTICS_TIME_ZONE} days ending yesterday. Datetime ranges run from 00:00:00 through 23:59:59.`, { conflicts: ['--from-date', '--to-date', '--from-datetime', '--to-datetime'] }),
    option('--from-datetime', 'datetime', `FROM_DATETIME in ${ANALYTICS_TIME_ZONE}.`),
    option('--to-datetime', 'datetime', `TO_DATETIME in ${ANALYTICS_TIME_ZONE}.`),
    option('--param', 'NAME=VALUE', 'Additional parameter; repeatable. An empty value (NAME=) is allowed where a recipe documents it.', { repeatable: true })
  ]
  const analyticsReadBehavior = [
    'POST /_data executes a read-only analytics query; it changes no remote state and is safe to retry.',
    '--validate-only checks local structure, bundled references, and aggregation semantics and skips the API call. It reports api_validated: false and executable: unknown; only execution establishes deployed-API acceptance.',
    'UNKNOWN_DATA_REFERENCE and INCOMPATIBLE_GRAIN are local exit-2 failures and send no request. There is no semantic override.',
    'Structured execution emits a fresh allowlisted total/header/rows/included envelope and adds meta.evidence with the exact query, result completeness, source grain and population, applicable terminology and notes, and selected measure contracts with non-blocking interpretation warnings. The header must contain unique names. Rows retain only keys named by header; backend metadata and extra document fields are omitted. CSV cannot carry that evidence.',
    'Freshness is reported as returned_in_rows only when a table_update_times query actually returns a selected last_updated_at timestamp column; querying that source without timestamps does not prove freshness.',
    'Signed funnel hashes can exceed JavaScript safe-integer precision. Use toString(event_hash), groupUniqArray(toString(event_hash)), and exact decimal-string has_any_int64 operands; never use JavaScript numbers. Derived hash conditions fail locally except for the canonical length(prefix_hashes) == 0 empty-prefix predicate.'
  ]
  apiAction(['data', 'query'], 'Validate, execute, or export a complete structured query.', { method: 'POST', path: '/_data', contacts_api: true }, ['can_query_clickhouse'], { options: [option('--query', 'string', 'JSON or TOON query, @file, or stdin. JSON input is always accepted; see poki help formats.', { required: true }), ...dataRequestOptions], scope: 'team conditions enforced by backend', risk: 'read_only', retry_safe: true, behavior: analyticsReadBehavior, missing_input: '--query', output: dataOutput, examples: [example('poki data query --query @query.toon --validate-only', 'Validate locally without contacting the API.'), example('poki data query --query @query.toon', 'Execute the structured query.'), example('poki data query --query -', 'Execute a query piped to stdin, for example from poki data recipe NAME --query-only.')] })
  apiAction(['data', 'run'], 'Fill typed recipe parameters, then validate or execute the structured query.', { method: 'POST', path: '/_data', contacts_api: true }, ['can_query_clickhouse'], { arguments: [argument('name', 'Recipe name.')], options: [...recipeParameterOptions, option('--limit', 'positive integer', 'Override or set the query row limit.'), option('--offset', 'non-negative integer', 'Override or set the query row offset.'), ...dataRequestOptions], scope: 'recipe parameters and backend team enforcement', risk: 'read_only', retry_safe: true, behavior: [...analyticsReadBehavior, 'FROM/TO parameters are validated as an ordered range before any API access.'], missing_input: 'a recipe name', output: dataOutput, examples: [example('poki data run game-users --team TEAM_ID --from-date 2026-07-01 --to-date 2026-07-31 --validate-only', 'Resolve and validate a recipe without contacting the API.'), example('poki data run game-users --team TEAM_ID --last-days 7', 'Report on the seven complete days ending yesterday.'), example('poki data run game-earnings --team TEAM_ID --last-days 30 --format csv', 'Export a 30-day report as shape-stable CSV.'), example('poki data run game-errors --team TEAM_ID --last-days 8', 'Report errors across the eight complete local calendar days ending yesterday, resolving datetime boundaries automatically.')] })
  const offlineDataMissingInput: Record<string, string> = {
    table: 'a table name',
    column: 'a table and column name',
    metric: 'a metric name'
  }
  for (const [name, summary, args, extraOptions] of [
    ['describe', 'Describe the query grammar.', [argument('topic', 'Optional grammar topic.', false, [...queryTopics])], []],
    ['tables', 'List the existing bundled table snapshot with row grain and population.', [], [option('--full', 'boolean', 'Also include machine-readable column contracts, column counts, and recipe names.', { default: false })]],
    ['table', 'Describe one table.', [argument('name', 'Table name.')], []],
    ['column', 'Describe one table column.', [argument('table', 'Table name.'), argument('column', 'Column name.')], []],
    ['metrics', 'List bundled dashboard metric semantics and curated compatible tables.', [], [option('--full', 'boolean', 'Include complete formula objects and table grain recommendations.', { default: false })]],
    ['metric', 'Return one complete metric formula with curated table grain recommendations.', [argument('name', 'Metric name.')], []],
    ['recipes', 'List bundled typed query recipes.', [], []],
    ['provenance', 'Return bundled snapshot metadata and discovery commands.', [], []]
  ] as Array<[string, string, HelpArgument[], HelpOption[]]>) {
    add({ path: ['data', name], summary, arguments: args.length === 0 ? undefined : args, options: [...extraOptions, formatOption], network: { method: 'none', path: 'bundled analytics snapshot', contacts_api: false }, risk: 'offline', missing_input: offlineDataMissingInput[name] ?? (args.some(item => item.required) ? args.map(item => item.name).join(' and ') : undefined), output: { analytics_time_zone: ANALYTICS_TIME_ZONE } })
  }
  add({ path: ['data', 'recipe'], summary: 'Return one bundled recipe, optionally with typed parameters filled.', arguments: [argument('name', 'Recipe name.')], options: [...recipeParameterOptions, option('--query-only', 'boolean', 'Emit only the resolved query object, ready for poki data query.', { default: false }), formatOption], behavior: ['--query-only prints the bare query object with no data/meta envelope — the only command with that top-level shape — so it can be piped straight into poki data query --query -.'], network: { method: 'none', path: 'bundled analytics snapshot', contacts_api: false }, risk: 'offline', missing_input: 'a recipe name', output: { analytics_time_zone: ANALYTICS_TIME_ZONE }, examples: [example('poki data recipe game-users', 'Inspect the recipe and its typed parameters.'), example('poki data recipe game-users --team TEAM_ID --from-date 2026-07-01 --to-date 2026-07-31 --query-only', 'Fill the parameters offline and emit only the query object.')] })
  apiAction(['data', 'freshness'], 'Query the existing table_update_times source.', { method: 'POST', path: '/_data', contacts_api: true }, ['can_query_clickhouse'], { options: dataRequestOptions, scope: 'backend analytics permission', risk: 'read_only', retry_safe: true, behavior: analyticsReadBehavior, output: dataOutput, examples: [example('poki data freshness --validate-only', 'Inspect the structured source-freshness query offline.')] })
}
