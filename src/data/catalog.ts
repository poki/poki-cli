export const SEMANTIC_CONTRACT_VERSION = 1

export type DataAggregate = 'avg' | 'count' | 'sum' | 'min' | 'max' | 'topKWeighted' | 'argMax' | 'quantileTDigest' | 'groupUniqArray'

export type AggregationKind =
  | 'dimension'
  | 'identifier'
  | 'additive_measure'
  | 'distinct_count'
  | 'repeated_measure'
  | 'row_ratio'
  | 'window_total'

export interface RequiredDimensions {
  all_of?: string[]
  one_of?: string[][]
}

export interface ColumnAggregation {
  kind: AggregationKind
  unit: string
  allowed_aggregates: DataAggregate[]
  guidance: string
  required_dimensions?: RequiredDimensions
  incompatible_addition_group?: string
}

export interface ColumnDefinition {
  name: string
  type: string
  description: string
  aggregation: ColumnAggregation
  enum_values?: string[]
  frontend_name?: string
}

export interface FieldTerminology {
  instruction: string
  mappings: Array<{
    frontend_name: string
    backend_field: string
  }>
}

export interface TableDefinition {
  name: string
  description: string
  grain: string
  grain_fields: string[]
  population: string
  top_level: boolean
  join_on?: string
  field_terminology?: FieldTerminology
  columns: ColumnDefinition[]
}

const dimensionAggregation = (): ColumnAggregation => ({
  kind: 'dimension',
  unit: 'dimension value',
  allowed_aggregates: ['count', 'min', 'max', 'topKWeighted', 'argMax', 'groupUniqArray'],
  guidance: 'Use as a grouping or filter dimension. Aggregation describes source rows or representative values, not an additive metric.'
})

const identifierAggregation = (): ColumnAggregation => ({
  kind: 'identifier',
  unit: 'identifier',
  allowed_aggregates: ['count', 'min', 'max', 'argMax', 'groupUniqArray'],
  guidance: 'Treat as an opaque identifier. Count distinct identifiers when measuring entities; never sum or average identifier values.'
})

const additiveAggregation = (unit: string, guidance?: string): ColumnAggregation => ({
  kind: 'additive_measure',
  unit,
  allowed_aggregates: ['sum'],
  guidance: guidance ?? `Sum ${unit} over compatible rows; do not average pre-aggregated totals.`
})

const distinctAggregation = (
  unit: string,
  required: RequiredDimensions,
  guidance: string
): ColumnAggregation => ({
  kind: 'distinct_count',
  unit,
  allowed_aggregates: ['sum'],
  required_dimensions: required,
  guidance
})

const repeatedAggregation = (
  unit: string,
  required: RequiredDimensions,
  guidance: string
): ColumnAggregation => ({
  kind: 'repeated_measure',
  unit,
  allowed_aggregates: ['max'],
  required_dimensions: required,
  guidance
})

const rowRatioAggregation = (unit: string, guidance: string): ColumnAggregation => ({
  kind: 'row_ratio',
  unit,
  allowed_aggregates: [],
  guidance
})

const windowAggregation = (unit: string, incompatibleAdditionGroup: string): ColumnAggregation => ({
  kind: 'window_total',
  unit,
  allowed_aggregates: ['max'],
  required_dimensions: { all_of: ['team_id'] },
  incompatible_addition_group: incompatibleAdditionGroup,
  guidance: 'This is a complete precomputed reporting window. Select windows separately; do not add overlapping windows together.'
})

const c = (
  name: string,
  type: string,
  description: string,
  aggregation: ColumnAggregation = dimensionAggregation()
): ColumnDefinition => ({
  name,
  type,
  description,
  aggregation
})

const id = (name: string, type: string, description: string): ColumnDefinition =>
  c(name, type, description, identifierAggregation())

const additive = (name: string, type: string, description: string, unit: string, guidance?: string): ColumnDefinition =>
  c(name, type, description, additiveAggregation(unit, guidance))

const distinct = (name: string, type: string, description: string, unit: string, required: RequiredDimensions, guidance: string): ColumnDefinition =>
  c(name, type, description, distinctAggregation(unit, required, guidance))

const repeated = (name: string, type: string, description: string, unit: string, required: RequiredDimensions, guidance: string): ColumnDefinition =>
  c(name, type, description, repeatedAggregation(unit, required, guidance))

const rowRatio = (name: string, type: string, description: string, unit: string, guidance: string): ColumnDefinition =>
  c(name, type, description, rowRatioAggregation(unit, guidance))

const gameEventFieldTerminology: FieldTerminology = {
  instruction: 'Communicate with users using the Poki for Developers frontend terms Category, What, and Action. Use the mapped backend field names in analytics queries and API payloads.',
  mappings: [
    { frontend_name: 'Category', backend_field: 'category' },
    { frontend_name: 'What', backend_field: 'action' },
    { frontend_name: 'Action', backend_field: 'label' }
  ]
}

const eventDimension = (name: string, frontendName: string, description: string): ColumnDefinition => ({
  ...c(name, 'String', description),
  frontend_name: frontendName
})

const standardDimensions = (): ColumnDefinition[] => [
  c('date', 'Date', 'Europe/Amsterdam calendar date on which the metrics were recorded.'),
  c('device_category', 'Nullable(String)', 'Audience device category derived from the user agent: desktop, mobile, or tablet; null means unavailable.'),
  c('country_id', 'Nullable(String)', 'Two-letter audience country code; null means the country was unavailable.'),
  {
    ...c('context', 'String', 'Gameplay context with exactly two values: playground when the gameplay occurred on Poki; external otherwise.'),
    enum_values: ['playground', 'external']
  },
  id('p4d_game_id', 'String', 'Stable Poki for Developers game ID.'),
  id('p4d_game_version_id', 'Nullable(String)', 'Poki for Developers version ID observed for the metric; null means it could not be attributed.'),
  id('team_id', 'String', 'ID of the Poki for Developers team that owns the game.')
]

const earnings = (): ColumnDefinition[] => [
  additive('developer_earnings_eur', 'Float64', 'Attributed developer earnings in euros.', 'EUR'),
  additive('developer_earnings_usd', 'Float64', 'Attributed developer earnings converted to US dollars using the reporting-date rate.', 'USD')
]

const eventDimensions = (): ColumnDefinition[] => [
  c('date', 'Date', 'Europe/Amsterdam calendar date on which the game events occurred.'),
  id('p4d_game_id', 'String', 'Stable Poki for Developers game ID that emitted the event.'),
  id('p4d_version_id', 'Nullable(String)', 'Poki for Developers version ID that emitted the event; null means it could not be attributed.'),
  id('team_id', 'String', 'ID of the Poki for Developers team that owns the game.'),
  eventDimension('category', 'Category', 'Frontend term: Category. Backend analytics field: category. This is the first measure(category, what, action) argument: the broad event group, such as level, tutorial, button, or difficulty.'),
  eventDimension('action', 'What', 'Frontend term: What. Backend analytics field: action. This legacy field stores the second measure(category, what, action) argument: the specific level, feature, or item.'),
  eventDimension('label', 'Action', 'Frontend term: Action. Backend analytics field: label. This legacy field stores the third measure(category, what, action) argument; it is empty for start, complete, fail, visible, and interact because those lifecycle actions are represented by counters.'),
  c('user_new', 'UInt8', '1 when the event came from a user considered new to the game, otherwise 0.'),
  c('device_category', 'String', 'Audience device category recorded for the event: desktop, mobile, or tablet.')
]

const adEarnings = (prefix: string, label: string): ColumnDefinition[] => [
  additive(`${prefix}_developer_earnings_eur`, 'Float64', `Developer earnings in euros attributed to ${label}.`, 'EUR'),
  additive(`${prefix}_developer_earnings_usd`, 'Float64', `Developer earnings in US dollars attributed to ${label}.`, 'USD')
]

const quickStatsEarnings = (period: string, description: string): ColumnDefinition[] => [
  c(`${period}_developer_earnings_eur`, 'Float64', `Developer earnings in euros for ${description}.`, windowAggregation('EUR', 'quick_stats_earnings_eur_windows')),
  c(`${period}_developer_earnings_usd`, 'Float64', `Developer earnings in US dollars for ${description}.`, windowAggregation('USD', 'quick_stats_earnings_usd_windows'))
]

export const tableCatalog: TableDefinition[] = [
  {
    name: 'dbt_p4d_gameplays',
    description: 'Daily gameplay counts by game, version, and audience dimensions. Gameplay boundaries come from Poki SDK gameplay events. Optional public SDK background: https://sdk.poki.com/sdk-documentation.',
    grain: 'One row per date, game, version, device category, country, context, and team.',
    grain_fields: ['date', 'p4d_game_id', 'p4d_game_version_id', 'device_category', 'country_id', 'context', 'team_id'],
    population: 'Gameplay sessions observed through Poki SDK gameplay events.',
    top_level: true,
    columns: [
      ...standardDimensions(),
      additive('gameplays', 'UInt64', 'Number of gameplay sessions in the dimension row.', 'gameplay sessions')
    ]
  },
  {
    name: 'dbt_p4d_users',
    description: 'Daily distinct-user counts for visiting, loading, and playing a game. Loading and gameplay semantics are described by the bundled columns and metrics. Optional public SDK background: https://sdk.poki.com/sdk-documentation.',
    grain: 'One row per date, game, version, device category, country, context, and team.',
    grain_fields: ['date', 'p4d_game_id', 'p4d_game_version_id', 'device_category', 'country_id', 'context', 'team_id'],
    population: 'Distinct daily users observed on a game page, with playing and loading subsets.',
    top_level: true,
    columns: [
      ...standardDimensions(),
      distinct('daily_active_users', 'UInt64', 'Distinct users who were active on the game page during the date.', 'users', { all_of: ['date', 'p4d_game_id'] }, 'Sum only within one visible or exactly filtered date and game; otherwise the same user can be counted on multiple days or games.'),
      distinct('daily_playing_users', 'UInt64', 'Distinct active users who reached gameplay during the date.', 'users', { all_of: ['date', 'p4d_game_id'] }, 'Sum only within one visible or exactly filtered date and game; otherwise the same user can be counted on multiple days or games.'),
      distinct('daily_not_playing_users', 'UInt64', 'Active users who did not reach gameplay; calculated as daily_active_users minus daily_playing_users.', 'users', { all_of: ['date', 'p4d_game_id'] }, 'Sum only within one visible or exactly filtered date and game; otherwise the same user can be counted on multiple days or games.'),
      distinct('daily_loading_users', 'UInt64', 'Distinct users observed in the loading flow.', 'users', { all_of: ['date', 'p4d_game_id'] }, 'Sum only within one visible or exactly filtered date and game; otherwise the same user can be counted on multiple days or games.'),
      distinct('daily_finished_loading_users', 'UInt64', 'Distinct users for whom game loading finished was observed.', 'users', { all_of: ['date', 'p4d_game_id'] }, 'Sum only within one visible or exactly filtered date and game; otherwise the same user can be counted on multiple days or games.')
    ]
  },
  {
    name: 'dbt_p4d_engagement_per_gameplay',
    description: 'Gameplay-based engagement totals from completed gameplay records, excluding detected outliers. Raw time fields are milliseconds; divide by 1000 for seconds. Bundled engagement recipes perform that conversion. Optional public SDK background: https://sdk.poki.com/sdk-documentation.',
    grain: 'One row per date, game, version, device category, country, context, and team.',
    grain_fields: ['date', 'p4d_game_id', 'p4d_game_version_id', 'device_category', 'country_id', 'context', 'team_id'],
    population: 'Completed gameplay records after detected engagement outliers are excluded.',
    top_level: true,
    columns: [
      ...standardDimensions(),
      additive('gameplays', 'UInt64', 'Number of non-outlier gameplay records represented by the row.', 'gameplay sessions'),
      additive('video_ad_visible_time', 'Float64', 'Total milliseconds a video advertisement was visible during represented gameplays; divide by 1000 for seconds.', 'milliseconds'),
      additive('play_time', 'Float64', 'Total milliseconds spent in active gameplay; divide by 1000 for seconds.', 'milliseconds'),
      additive('pre_play_time', 'Float64', 'Total milliseconds between page arrival and the first gameplay start; divide by 1000 for seconds.', 'milliseconds')
    ]
  },
  {
    name: 'dbt_p4d_netlib_overview',
    description: 'Hourly Netlib lobby and connection event totals for developer-owned games.',
    grain: 'One row per Europe/Amsterdam local hour, game, and team.',
    grain_fields: ['hour', 'p4d_game_id', 'team_id'],
    population: 'Netlib analytics events attributed to Poki for Developers games.',
    top_level: true,
    columns: [
      c('hour', 'DateTime', 'Europe/Amsterdam local hour in which the Netlib events occurred; this follows CET/CEST daylight saving.'),
      id('p4d_game_id', 'String', 'Stable Poki for Developers game ID.'),
      id('team_id', 'String', 'ID of the Poki for Developers team that owns the game.'),
      additive('lobbies_created', 'UInt64', 'Number of lobby-created events during the hour.', 'lobby-created events'),
      additive('lobbies_joined', 'UInt64', 'Number of lobby-joined events during the hour.', 'lobby-joined events'),
      additive('lobbies_updated', 'UInt64', 'Number of lobby-updated events during the hour.', 'lobby-updated events'),
      additive('client_connected', 'UInt64', 'Number of client-connected events during the hour.', 'client-connected events'),
      distinct('peer_connections', 'UInt64', 'Distinct connected peer identifiers observed during the hour. A peer-to-peer connection is represented by both peers, so divide the summed value by 2 for connected peer pairs.', 'peer identifiers', { all_of: ['hour', 'p4d_game_id'] }, 'Keep the hour and game visible or exactly filtered. Summing multiple hours or games can count the same peer repeatedly.')
    ]
  },
  {
    name: 'dbt_p4d_monetization',
    description: 'Daily audience, playtime, ad-impression, and per-format developer-earnings totals. Ad field semantics are bundled with the table. Optional public SDK background: https://sdk.poki.com/sdk-documentation.',
    grain: 'One row per date, game, device category, country, context, and team.',
    grain_fields: ['date', 'p4d_game_id', 'device_category', 'country_id', 'context', 'team_id'],
    population: 'Daily users, playtime, ad impressions, and attributed earnings in the monetization model.',
    top_level: true,
    columns: [
      ...standardDimensions().filter(column => column.name !== 'p4d_game_version_id'),
      additive('platform_display_impressions', 'UInt64', 'Revenue-share-eligible display-ad impressions served by the Poki platform outside the game canvas.', 'impressions'),
      additive('preroll_video_impressions', 'UInt64', 'Video-ad impressions shown before gameplay.', 'impressions'),
      additive('gamebar_display_impressions', 'UInt64', 'Display-ad impressions served in the Poki game bar.', 'impressions'),
      additive('ingame_display_impressions', 'UInt64', 'Display-ad impressions served inside the game experience.', 'impressions'),
      additive('midroll_video_impressions', 'UInt64', 'Commercial-break video impressions shown at natural gameplay interruptions.', 'impressions'),
      additive('rewarded_video_impressions', 'UInt64', 'Rewarded video impressions initiated by player choice.', 'impressions'),
      distinct('daily_active_users', 'UInt64', 'Distinct users active on the game page during the date.', 'users', { all_of: ['date', 'p4d_game_id'] }, 'Sum only within one visible or exactly filtered date and game; otherwise the same user can be counted on multiple days or games.'),
      distinct('daily_playing_users', 'UInt64', 'Distinct active users who reached gameplay during the date.', 'users', { all_of: ['date', 'p4d_game_id'] }, 'Sum only within one visible or exactly filtered date and game; otherwise the same user can be counted on multiple days or games.'),
      additive('total_play_time', 'Float64', 'Total active gameplay time in seconds.', 'seconds'),
      ...adEarnings('ingame_display', 'in-game display advertisements'),
      ...adEarnings('gamebar_display', 'game-bar display advertisements'),
      ...adEarnings('platform_display', 'platform display advertisements'),
      ...adEarnings('preroll_video', 'pre-roll video advertisements'),
      ...adEarnings('midroll_video', 'mid-roll commercial-break advertisements'),
      ...adEarnings('rewarded_video', 'rewarded video advertisements')
    ]
  },
  {
    name: 'dbt_p4d_developer_earnings',
    description: 'Daily developer earnings by game and audience dimensions, including the server-calculated shared portion.',
    grain: 'One row per date, game, device category, country, context, and team.',
    grain_fields: ['date', 'p4d_game_id', 'device_category', 'country_id', 'context', 'team_id'],
    population: 'Developer earnings attributed to the represented game and audience dimensions.',
    top_level: true,
    columns: [
      ...standardDimensions().filter(column => column.name !== 'p4d_game_version_id'),
      ...earnings(),
      additive('developer_earnings_shared_eur', 'Float64', 'Server-calculated shared developer earnings in euros.', 'EUR'),
      additive('developer_earnings_shared_usd', 'Float64', 'Server-calculated shared developer earnings in US dollars.', 'USD')
    ]
  },
  {
    name: 'dbt_p4d_game_errors_per_gameplay',
    description: 'Hourly JavaScript error occurrences grouped by gameplay and execution environment. Each row identifies one error within one gameplay.',
    grain: 'One row per hour, game, version, environment, error fingerprint, and gameplay.',
    grain_fields: ['date_hour', 'p4d_game_id', 'p4d_game_version_id', 'team_id', 'engine', 'engine_version', 'browser_name', 'browser_version', 'device_category', 'error_name', 'error_message', 'error_id', 'gameplay_id'],
    population: 'Gameplays that emitted a captured JavaScript error; rows are error/gameplay combinations.',
    top_level: true,
    columns: [
      c('date_hour', 'DateTime', 'Europe/Amsterdam local hour in which the error occurred; this follows CET/CEST daylight saving.'),
      id('p4d_game_id', 'String', 'Stable Poki for Developers game ID.'),
      id('p4d_game_version_id', 'String', 'Poki for Developers version ID that emitted the error.'),
      id('team_id', 'String', 'ID of the Poki for Developers team that owns the game.'),
      c('engine', 'String', 'Game engine recorded for the game.'),
      c('engine_version', 'String', 'Game engine version reported with the error.'),
      c('browser_name', 'String', 'Parsed browser name.'),
      c('browser_version', 'String', 'Parsed browser version.'),
      c('device_category', 'String', 'Recorded device category: desktop, mobile, or tablet.'),
      c('error_name', 'String', 'JavaScript error name or class.'),
      c('error_message', 'String', 'Normalized error message with skipped-error throttling suffixes removed.'),
      additive('sum_skipped', 'UInt64', 'Number of additional occurrences reported as skipped by server-side error throttling.', 'error occurrences'),
      id('error_id', 'String', 'Stable error fingerprint used to group equivalent errors.'),
      c('error_stack', 'String', 'Most common stack trace for the grouped row.'),
      c('stack_line', 'String', 'Most common primary stack line for the grouped row.'),
      additive('errors', 'UInt64', 'Observed occurrence count for this error in this gameplay row.', 'error occurrences'),
      id('gameplay_id', 'UInt64', 'Numeric gameplay identifier parsed from the error report\'s user identifier.'),
      repeated('same_engine_games', 'UInt64', 'Number of other games using the same engine that emitted the same error name and message in the modeled period.', 'games', { one_of: [['error_id'], ['engine', 'error_name', 'error_message']] }, 'This value repeats on every gameplay row for an error fingerprint. Collapse it with max only while retaining the fingerprint or complete error signature.')
    ]
  },
  {
    name: 'dbt_p4d_game_errors_gameplays',
    description: 'Hourly gameplay totals by game version and environment, intended as denominators for error-impact calculations.',
    grain: 'One row per hour, game, version, engine, browser, device category, and team.',
    grain_fields: ['date_hour', 'p4d_game_id', 'p4d_game_version_id', 'team_id', 'engine', 'browser_name', 'browser_version', 'device_category'],
    population: 'Gameplay sessions represented by the error-impact denominator model.',
    top_level: true,
    columns: [
      c('date_hour', 'DateTime', 'Europe/Amsterdam local hour containing the gameplay sessions; this follows CET/CEST daylight saving.'),
      id('p4d_game_id', 'String', 'Stable Poki for Developers game ID.'),
      id('p4d_game_version_id', 'String', 'Poki for Developers version ID.'),
      id('team_id', 'String', 'ID of the Poki for Developers team that owns the game.'),
      c('engine', 'String', 'Game engine recorded for the game.'),
      c('browser_name', 'String', 'Parsed browser name.'),
      c('browser_version', 'String', 'Parsed browser version.'),
      c('device_category', 'String', 'Recorded device category: desktop, mobile, or tablet.'),
      additive('gameplays', 'UInt64', 'Distinct gameplay sessions in the environment row.', 'gameplay sessions')
    ]
  },
  {
    name: 'dbt_p4d_game_new_high_impact_errors',
    description: 'Errors not seen for the same game in the prior seven days that affect at least 10% of at least 500 daily gameplays.',
    grain: 'One row per date, game, and new high-impact error fingerprint.',
    grain_fields: ['date', 'p4d_game_id', 'team_id', 'error_id'],
    population: 'Newly observed errors meeting the modeled daily gameplay-count and impact thresholds.',
    top_level: true,
    columns: [
      c('date', 'Date', 'Europe/Amsterdam calendar date on which the new high-impact error was detected.'),
      id('p4d_game_id', 'String', 'Stable Poki for Developers game ID.'),
      id('team_id', 'String', 'ID of the Poki for Developers team that owns the game.'),
      id('error_id', 'String', 'Stable error fingerprint.'),
      c('error_name', 'String', 'Representative JavaScript error name or class.'),
      c('error_message', 'String', 'Representative normalized error message.'),
      c('error_stack', 'String', 'Most common stack trace for the error.'),
      c('stack_line', 'String', 'Most common primary stack line for the error.'),
      distinct('affected_gameplays', 'UInt64', 'Distinct gameplays in which the error occurred.', 'gameplay sessions', { all_of: ['error_id'] }, 'Keep the error fingerprint visible or exactly filtered. A gameplay affected by multiple errors appears in multiple rows and cannot be uniquely recovered after rolling errors together.'),
      repeated('total_gameplays', 'UInt64', 'Total modeled gameplays for the game on the date.', 'gameplay sessions', { all_of: ['date', 'p4d_game_id'] }, 'This game/day denominator repeats on every error row. Use max only while retaining or exactly filtering the date and game.'),
      rowRatio('gameplay_percentage', 'Float64', 'Approximate affected_gameplays divided by total_gameplays, capped at 1.0.', 'ratio', 'Use only at the complete date, game, and error row grain. Do not sum or average row-level impact percentages.')
    ]
  },
  {
    name: 'dbt_p4d_game_events_v2',
    description: 'Aggregated custom measure() events by game, version, audience, and event key. Rows are aggregates, not raw events. Communicate event dimensions as frontend Category, What, and Action, while querying backend fields category, action, and label respectively. Optional public integration guide: https://sdk.poki.com/game-events.',
    grain: 'One row per date, game, version, audience dimensions, and normalized event key.',
    grain_fields: ['date', 'p4d_game_id', 'p4d_version_id', 'team_id', 'category', 'action', 'label', 'user_new', 'device_category'],
    population: 'Gameplays containing or emitting the represented custom event; one gameplay can contribute to many event rows.',
    top_level: true,
    field_terminology: gameEventFieldTerminology,
    columns: [
      ...eventDimensions(),
      distinct('gameplays', 'UInt64', 'Number of gameplays containing this frontend Category/What/Action event key.', 'gameplay sessions', { all_of: ['category', 'action', 'label'] }, 'A gameplay can contribute to multiple event keys. Keep frontend Category (backend category), What (backend action), and Action (backend label) visible or exactly filtered; a unique cross-key total is unavailable from this table.'),
      distinct('starts', 'UInt64', 'Gameplays containing at least one start lifecycle action for this Category and What value.', 'gameplay sessions', { all_of: ['category', 'action', 'label'] }, 'A gameplay can start multiple event keys. Keep frontend Category (backend category), What (backend action), and the empty lifecycle Action (backend label) visible or exactly filtered.'),
      distinct('completes', 'UInt64', 'Gameplays containing at least one complete lifecycle action for this Category and What value.', 'gameplay sessions', { all_of: ['category', 'action', 'label'] }, 'A gameplay can complete multiple event keys. Keep frontend Category (backend category), What (backend action), and the empty lifecycle Action (backend label) visible or exactly filtered.'),
      distinct('fails', 'UInt64', 'Gameplays containing at least one fail lifecycle action for this Category and What value.', 'gameplay sessions', { all_of: ['category', 'action', 'label'] }, 'A gameplay can fail multiple event keys. Keep frontend Category (backend category), What (backend action), and the empty lifecycle Action (backend label) visible or exactly filtered.'),
      distinct('seen', 'UInt64', 'Gameplays containing at least one visible lifecycle action for this Category and What value.', 'gameplay sessions', { all_of: ['category', 'action', 'label'] }, 'A gameplay can see multiple event keys. Keep frontend Category (backend category), What (backend action), and the empty lifecycle Action (backend label) visible or exactly filtered.'),
      distinct('interacted', 'UInt64', 'Gameplays containing at least one interact lifecycle action for this Category and What value.', 'gameplay sessions', { all_of: ['category', 'action', 'label'] }, 'A gameplay can interact with multiple event keys. Keep frontend Category (backend category), What (backend action), and the empty lifecycle Action (backend label) visible or exactly filtered.'),
      distinct('lefts', 'UInt64', 'Gameplays containing a start lifecycle action for this Category and What value at the maximum retained event timestamp for that gameplay. A retained event with a later timestamp in any Category or What prevents the count; an event at the same timestamp does not. This is inferred from the absence of later events, not an explicit leave signal.', 'gameplay sessions', { all_of: ['category', 'action', 'label'] }, 'Keep frontend Category (backend category), What (backend action), and the empty lifecycle Action (backend label) visible or exactly filtered; do not treat event-key rows as disjoint gameplays.'),
      additive('total_starts', 'UInt64', 'Total start event occurrences, including repeated starts within one gameplay.', 'event occurrences'),
      additive('total_completes', 'UInt64', 'Total complete event occurrences, including repeats within one gameplay.', 'event occurrences'),
      additive('total_fails', 'UInt64', 'Total fail event occurrences, including repeats within one gameplay.', 'event occurrences'),
      additive('total_seen', 'UInt64', 'Total visible event occurrences, including repeats within one gameplay.', 'event occurrences'),
      additive('total_interacted', 'UInt64', 'Total interact event occurrences, including repeats within one gameplay.', 'event occurrences'),
      additive('total_events', 'UInt64', 'Total occurrences for this frontend Category/What/Action event key.', 'event occurrences')
    ]
  },
  {
    name: 'dbt_p4d_game_events_times_v2',
    description: 'Dynamic 1-, 5-, or 10-second buckets for custom-event arrival and start-to-outcome timing below one hour. Communicate event dimensions as frontend Category, What, and Action, while querying backend fields category, action, and label respectively. Optional public integration guide: https://sdk.poki.com/game-events.',
    grain: 'One row per date, game, version, audience dimensions, event key, timing type, and time bucket.',
    grain_fields: ['date', 'p4d_game_id', 'p4d_version_id', 'team_id', 'category', 'action', 'label', 'user_new', 'device_category', 'time_type', 'time_bucket', 'time_granularity'],
    population: 'Gameplays with a selected custom-event timing; one gameplay can contribute to multiple event/timing groups.',
    top_level: true,
    field_terminology: gameEventFieldTerminology,
    columns: [
      ...eventDimensions(),
      c('time_type', 'String', 'Timing being bucketed: event for first arrival, complete or fail since the preceding start, or interact since the preceding visible event.'),
      c('time_bucket', 'UInt64', 'Inclusive lower bound of the bucket in seconds; modeled values are non-negative and below 3600.'),
      repeated('time_granularity', 'UInt64', 'Bucket width in seconds: 1, 5, or 10, selected to keep the distribution below roughly 100 buckets.', 'seconds', { all_of: ['category', 'action', 'label', 'time_type'] }, 'Bucket width repeats across histogram rows. Use max only for one visible or exactly filtered frontend Category/What/Action event key and timing type.'),
      distinct('gameplays', 'UInt64', 'Number of gameplays whose selected timing falls in this bucket.', 'gameplay sessions', { all_of: ['category', 'action', 'label', 'time_type'] }, 'Time buckets partition gameplays only within one event key and timing type. Keep or exactly filter frontend Category (backend category), What (backend action), Action (backend label), and time_type before summing buckets.')
    ]
  },
  {
    name: 'dbt_p4d_game_events_funnel_v2',
    description: 'Ordered custom-event prefixes for funnel traversal. The model keeps at most the first 200 events per gameplay and omits a date/game with more than 5000 distinct event keys. Funnel hashes are signed 64-bit identifiers that may exceed JavaScript safe-integer precision: select event_hash through toString, and use prefix_hashes only as a has_any_int64 filter with exact decimal strings. Funnel semantics are bundled with the columns. Optional public integration guide: https://sdk.poki.com/game-events.',
    grain: 'One row per date, game, version, audience dimensions, event, and ordered prefix position/hash.',
    grain_fields: ['date', 'p4d_game_id', 'p4d_version_id', 'team_id', 'user_new', 'device_category', 'prefix_len', 'event', 'event_hash', 'prefix_hashes'],
    population: 'Sampled eligible gameplay event sequences; one gameplay contributes to multiple retained prefix rows.',
    top_level: true,
    columns: [
      c('date', 'Date', 'Europe/Amsterdam calendar date on which the event sequence occurred.'),
      id('p4d_game_id', 'String', 'Stable Poki for Developers game ID.'),
      id('p4d_version_id', 'String', 'Poki for Developers version ID that emitted the sequence.'),
      id('team_id', 'String', 'ID of the Poki for Developers team that owns the game.'),
      c('user_new', 'UInt8', '1 when the sequence came from a user considered new to the game, otherwise 0.'),
      c('device_category', 'String', 'Audience device category recorded for the sequence: desktop, mobile, or tablet.'),
      c('prefix_len', 'UInt64', 'Zero-based position of this event in the retained gameplay sequence.'),
      c('event', 'String', "Canonical funnel event key encoded in frontend terms as Category^What^Action, sourced from backend fields category^action^label. The '^' character is reserved as the separator, special Action values are lowercased, and the final separator remains when Action is empty. Pass this value verbatim to game-event-funnels --event."),
      id('event_hash', 'Int64', 'Signed 64-bit hash of the ordered sequence prefix ending at this event. It may exceed JavaScript safe-integer precision. Select one hash with {alias: "event_hash", function: {name: "toString", args: [{field: "event_hash"}]}}; for distinct hashes, aggregate the same toString function with groupUniqArray. The CLI rejects direct numeric output and numeric comparisons. Never consume this identifier as a JavaScript number.'),
      id('prefix_hashes', 'Array(Int64)', 'Eligible prior-prefix hashes used for skip-tolerant traversal, bounded to the recent lookback window. This is filter-only in the CLI: use ["prefix_hashes", "has_any_int64", ["-8340446448795919230"]] with exact base-10 decimal strings, never JavaScript numbers. Direct output, scalar has, and other operators are rejected.'),
      rowRatio('gameplay_sample_percentage', 'Float64', 'Percentage of eligible gameplay sequences represented by the row; currently emitted as 100.', 'percent', 'Use only at a compatible funnel row grain. Do not sum or average sampling percentages across prefix rows.'),
      distinct('gameplays', 'UInt64', 'Number of gameplays represented by this event and prefix combination.', 'gameplay sessions', { all_of: ['prefix_len'] }, 'A gameplay contributes once at every retained prefix position. Keep prefix_len visible or exactly filtered before summing mutually exclusive event/path rows.')
    ]
  },
  {
    name: 'dbt_p4d_player_feedback',
    description: 'Player feedback joined with available browser, device, gameplay, error, and screenshot diagnostics.',
    grain: 'One row per player feedback submission.',
    grain_fields: ['timestamp', 'p4d_game_id', 'type', 'message'],
    population: 'Submitted thumbs-up, thumbs-down, and bug-report feedback with available diagnostics.',
    top_level: true,
    columns: [
      c('timestamp', 'DateTime', 'Europe/Amsterdam local timestamp at which the feedback was submitted; this follows CET/CEST daylight saving.'),
      c('type', 'String', 'Feedback kind: thumbs_up, thumbs_down, or bugreport; this value set is enforced at ingestion.'),
      c('message', 'String', 'Original player feedback message.'),
      c('english_message', 'String', 'English translation when one was captured; otherwise an empty string.'),
      c('screenshot_url', 'String', 'URL of an attached screenshot when available.'),
      id('p4d_game_id', 'String', 'Stable Poki for Developers game ID.'),
      id('team_id', 'String', 'ID of the Poki for Developers team that owns the game.'),
      c('country', 'String', 'Human-readable country name.'),
      c('country_code', 'String', 'Uppercase two-letter country code.'),
      c('browser_name', 'Nullable(String)', 'Parsed browser name; null for feedback sources without diagnostics.'),
      c('browser_version', 'Nullable(String)', 'Parsed browser version; null when unavailable.'),
      c('os_name', 'Nullable(String)', 'Parsed operating-system name; null when unavailable.'),
      c('os_version', 'Nullable(String)', 'Parsed operating-system version; null when unavailable.'),
      c('device_category', 'Nullable(String)', 'Recorded device category: desktop, mobile, or tablet; null when unavailable.'),
      id('p4d_version_id', 'Nullable(String)', 'Poki for Developers version ID active for the feedback; null when unavailable.'),
      c('has_adblock', 'Nullable(Bool)', 'Whether ad blocking was detected; null when unavailable.'),
      c('game_resolution', 'Nullable(String)', 'Reported game viewport resolution; null when unavailable.'),
      c('was_fullscreen_this_gameplay', 'Nullable(Bool)', 'Whether fullscreen was used during the gameplay; null when unavailable.'),
      c('loading_finished', 'Nullable(Bool)', 'Whether game loading finished before feedback; null when unavailable.'),
      c('gametime_seconds', 'Nullable(Float64)', 'Rounded seconds spent on the game page before feedback; null when unavailable.'),
      c('errors', 'Nullable(String)', 'JSON-encoded array of captured errors; null when no errors or diagnostics were supplied.'),
      c('webgl_renderer', 'Nullable(String)', 'Reported WebGL renderer or GPU description; null when unavailable.'),
      c('device_pixel_ratio', 'Nullable(Float64)', 'Browser device-pixel ratio; null when unavailable.'),
      c('probably_spammy', 'Nullable(Bool)', 'Model-derived indication that the feedback message is probably spam.')
    ]
  },
  {
    name: 'dbt_p4d_games_overview',
    description: 'Daily game-level release, audience, engagement, monetization, and earnings overview by country and device.',
    grain: 'One row per date, game, device category, and country.',
    grain_fields: ['date', 'p4d_game_id', 'team_id', 'device_category', 'country_id'],
    population: 'Daily game traffic and attributed engagement, monetization, and earnings represented by the overview model.',
    top_level: true,
    columns: [
      c('date', 'Date', 'Europe/Amsterdam metric date.'),
      c('release_date', 'Date', 'Europe/Amsterdam calendar date on which the current release phase began.'),
      c('release_status', 'String', 'Game release status on the metric date: one of not-released, no-link-release, technical-test, soft-release, limited-release, full-release, or 10k-test, each also occurring with a -with-content-restrictions suffix.'),
      c('release_status_changed_at', 'DateTime', 'Europe/Amsterdam local timestamp at which the release status last changed; this follows CET/CEST daylight saving.'),
      id('p4d_game_id', 'String', 'Stable Poki for Developers game ID.'),
      id('team_id', 'String', 'ID of the Poki for Developers team that owns the game.'),
      c('device_category', 'String', 'Audience device category: desktop, mobile, or tablet.'),
      c('country_id', 'String', 'Two-letter audience country code.'),
      repeated('num_domains_live', 'UInt64', 'Number of distinct sites or domains on which the game was live.', 'domains', { all_of: ['date', 'p4d_game_id'] }, 'This game/day value repeats across country and device rows. Use max only while retaining or exactly filtering date and game.'),
      additive('gameplays', 'UInt64', 'Number of gameplay sessions.', 'gameplay sessions'),
      ...earnings(),
      distinct('daily_active_users', 'UInt64', 'Distinct users active on the game page.', 'users', { all_of: ['date', 'p4d_game_id'] }, 'Sum only within one visible or exactly filtered date and game; otherwise the same user can be counted on multiple days or games.'),
      distinct('daily_playing_users', 'UInt64', 'Distinct active users who reached gameplay.', 'users', { all_of: ['date', 'p4d_game_id'] }, 'Sum only within one visible or exactly filtered date and game; otherwise the same user can be counted on multiple days or games.'),
      additive('play_time', 'Float64', 'Total active gameplay time in seconds.', 'seconds'),
      additive('pre_play_time', 'Float64', 'Total seconds between page arrival and first gameplay.', 'seconds'),
      additive('video_ad_visible_time', 'Float64', 'Total seconds video advertisements were visible.', 'seconds'),
      additive('ingame_display_impressions', 'UInt64', 'In-game display-ad impression count.', 'impressions'),
      additive('gamebar_display_impressions', 'UInt64', 'Game-bar display-ad impression count.', 'impressions'),
      additive('platform_display_impressions', 'UInt64', 'Platform display-ad impression count.', 'impressions'),
      additive('preroll_video_impressions', 'UInt64', 'Pre-roll video-ad impression count.', 'impressions'),
      additive('midroll_video_impressions', 'UInt64', 'Mid-roll commercial-break impression count.', 'impressions'),
      additive('rewarded_video_impressions', 'UInt64', 'Rewarded video-ad impression count.', 'impressions'),
      additive('video_ad_visible_time_dpu', 'Float64', 'Total video-ad-visible seconds attributed to DPU (daily playing users); divide by daily_playing_users for a per-playing-user value.', 'seconds'),
      additive('play_time_dpu', 'Float64', 'Total active gameplay seconds attributed to DPU; divide by daily_playing_users for a per-playing-user value.', 'seconds'),
      additive('pre_play_time_dpu', 'Float64', 'Total pre-play seconds attributed to DPU; divide by daily_playing_users for a per-playing-user value.', 'seconds')
    ]
  },
  {
    name: 'dbt_p4d_quick_stats',
    description: 'Precomputed team developer-earnings totals for common reporting windows. Rolling windows end yesterday; all-time also excludes today.',
    grain: 'One row per team.',
    grain_fields: ['team_id'],
    population: 'Developer earnings for the represented team across fixed reporting windows.',
    top_level: true,
    columns: [
      id('team_id', 'String', 'ID of the Poki for Developers team.'),
      ...quickStatsEarnings('yesterday', 'yesterday'),
      ...quickStatsEarnings('last_7_days', 'the seven-day window ending yesterday'),
      ...quickStatsEarnings('last_14_days', 'the fourteen-day window ending yesterday'),
      ...quickStatsEarnings('last_30_days', 'the thirty-day window ending yesterday'),
      ...quickStatsEarnings('current_month', 'the current calendar month through available data'),
      ...quickStatsEarnings('all_time', 'all reporting dates through yesterday')
    ]
  },
  {
    name: 'table_update_times',
    description: 'Latest successful refresh timestamp reported for each analytics table.',
    grain: 'One row per analytics table.',
    grain_fields: ['table_name'],
    population: 'Analytics tables that report a successful refresh timestamp.',
    top_level: true,
    columns: [
      c('table_name', 'String', 'Analytics table name.'),
      c('last_updated_at', 'DateTime', 'Europe/Amsterdam local timestamp of the table\'s latest successful refresh; this follows CET/CEST daylight saving.')
    ]
  },
  {
    name: 'pokifordevs_games',
    description: 'Join-only current game metadata. Qualify fields with pokifordevs_games and join through p4d_game_id.',
    grain: 'One row per Poki for Developers game.',
    grain_fields: ['id'],
    population: 'Current game metadata available to the analytics join.',
    top_level: false,
    join_on: 'p4d_game_id',
    columns: [
      id('id', 'String', 'Stable Poki for Developers game ID.'),
      c('title', 'String', 'Current game title.'),
      c('cached_has_revshare', 'Int8', '1 when cached game metadata indicates revenue sharing, otherwise 0.'),
      c('approved', 'Int8', '1 when the game is approved, otherwise 0.'),
      c('engine', 'String', 'Game engine recorded in the game annotations.')
    ]
  },
  {
    name: 'dbt_p4d_meta_game',
    description: 'Join-only release and distribution metadata. Qualify fields with dbt_p4d_meta_game and join through p4d_game_id.',
    grain: 'One row per Poki for Developers game.',
    grain_fields: ['p4d_game_id'],
    population: 'Current release and distribution metadata available to the analytics join.',
    top_level: false,
    join_on: 'p4d_game_id',
    columns: [
      id('p4d_game_id', 'String', 'Stable Poki for Developers game ID.'),
      c('release_status', 'String', 'Current game release status: one of not-released, no-link-release, technical-test, soft-release, limited-release, full-release, or 10k-test, each also occurring with a -with-content-restrictions suffix.'),
      c('release_status_changed_at', 'DateTime', 'Europe/Amsterdam local timestamp at which the release status last changed; this follows CET/CEST daylight saving.'),
      c('release_date', 'Date', 'Europe/Amsterdam calendar date on which the current release phase began.'),
      repeated('num_domains_live', 'UInt64', 'Number of distinct sites or domains on which the game is live.', 'domains', { all_of: ['p4d_game_id'] }, 'This current game value repeats across joined analytics rows. Use max only while retaining or exactly filtering the game.')
    ]
  }
]

export function findTable (name: string): TableDefinition | undefined {
  return tableCatalog.find(table => table.name === name)
}
