import { resolvedSelectOutputName, visitSelectExpression } from './select-expression'
import { isRecord } from '../json'

export interface ColumnDefinition {
  name: string
  type: string
  description: string
}

export interface TableDefinition {
  name: string
  description: string
  grain: string
  population: string
  top_level: boolean
  join_on?: string
  columns: ColumnDefinition[]
}

const c = (name: string, type: string, description: string): ColumnDefinition => ({
  name,
  type,
  description
})

const standardDimensions = (): ColumnDefinition[] => [
  c('date', 'Date', 'Europe/Amsterdam calendar date on which the metrics were recorded.'),
  c('device_category', 'Nullable(String)', 'Audience device category derived from the user agent: desktop, mobile, or tablet; null means unavailable.'),
  c('country_id', 'Nullable(String)', 'Two-letter audience country code; null means the country was unavailable.'),
  c('context', 'String', 'Runtime context in which the game ran: playground is the Poki for Developers playtesting environment that the bundled recipes filter on, preview is the pre-release preview context, and other values may exist.'),
  c('p4d_game_id', 'String', 'Stable Poki for Developers game ID.'),
  c('p4d_game_version_id', 'Nullable(String)', 'Poki for Developers version ID observed for the metric; null means it could not be attributed.'),
  c('team_id', 'String', 'ID of the Poki for Developers team that owns the game.')
]

const earnings = (): ColumnDefinition[] => [
  c('developer_earnings_eur', 'Float64', 'Attributed developer earnings in euros.'),
  c('developer_earnings_usd', 'Float64', 'Attributed developer earnings converted to US dollars using the reporting-date rate.')
]

const eventDimensions = (): ColumnDefinition[] => [
  c('date', 'Date', 'Europe/Amsterdam calendar date on which the game events occurred.'),
  c('p4d_game_id', 'String', 'Stable Poki for Developers game ID that emitted the event.'),
  c('p4d_version_id', 'Nullable(String)', 'Poki for Developers version ID that emitted the event; null means it could not be attributed.'),
  c('team_id', 'String', 'ID of the Poki for Developers team that owns the game.'),
  c('category', 'String', 'First measure() argument: the broad event group, such as level, tutorial, button, or difficulty.'),
  c('action', 'String', 'Legacy column name for the second measure() argument named what in the SDK: the specific level, feature, or item.'),
  c('label', 'String', 'Third measure() argument named action in the SDK for custom actions; empty for start, complete, fail, visible, and interact because those lifecycle values are represented by counters.'),
  c('user_new', 'UInt8', '1 when the event came from a user considered new to the game, otherwise 0.'),
  c('device_category', 'String', 'Audience device category recorded for the event: desktop, mobile, or tablet.')
]

const adEarnings = (prefix: string, label: string): ColumnDefinition[] => [
  c(`${prefix}_developer_earnings_eur`, 'Float64', `Developer earnings in euros attributed to ${label}.`),
  c(`${prefix}_developer_earnings_usd`, 'Float64', `Developer earnings in US dollars attributed to ${label}.`)
]

const quickStatsEarnings = (period: string, description: string): ColumnDefinition[] => [
  c(`${period}_developer_earnings_eur`, 'Float64', `Developer earnings in euros for ${description}.`),
  c(`${period}_developer_earnings_usd`, 'Float64', `Developer earnings in US dollars for ${description}.`)
]

export const tableCatalog: TableDefinition[] = [
  {
    name: 'dbt_p4d_gameplays',
    description: 'Daily gameplay counts by game, version, and audience dimensions. Gameplay boundaries come from Poki SDK gameplay events. Optional public SDK background: https://sdk.poki.com/sdk-documentation.',
    grain: 'One row per date, game, version, device category, country, context, and team.',
    population: 'Gameplay sessions observed through Poki SDK gameplay events.',
    top_level: true,
    columns: [
      ...standardDimensions(),
      c('gameplays', 'UInt64', 'Number of gameplay sessions in the dimension row.')
    ]
  },
  {
    name: 'dbt_p4d_users',
    description: 'Daily distinct-user counts for visiting, loading, and playing a game. Loading and gameplay semantics are described by the bundled columns and metrics. Optional public SDK background: https://sdk.poki.com/sdk-documentation.',
    grain: 'One row per date, game, version, device category, country, context, and team.',
    population: 'Distinct daily users observed on a game page, with playing and loading subsets.',
    top_level: true,
    columns: [
      ...standardDimensions(),
      c('daily_active_users', 'UInt64', 'Distinct users who were active on the game page during the date.'),
      c('daily_playing_users', 'UInt64', 'Distinct active users who reached gameplay during the date.'),
      c('daily_not_playing_users', 'UInt64', 'Active users who did not reach gameplay; calculated as daily_active_users minus daily_playing_users.'),
      c('daily_loading_users', 'UInt64', 'Distinct users observed in the loading flow.'),
      c('daily_finished_loading_users', 'UInt64', 'Distinct users for whom game loading finished was observed.')
    ]
  },
  {
    name: 'dbt_p4d_engagement_per_gameplay',
    description: 'Gameplay-based engagement totals from completed gameplay records, excluding detected outliers. Raw time fields are milliseconds; divide by 1000 for seconds. Bundled engagement recipes perform that conversion. Optional public SDK background: https://sdk.poki.com/sdk-documentation.',
    grain: 'One row per date, game, version, device category, country, context, and team.',
    population: 'Completed gameplay records after detected engagement outliers are excluded.',
    top_level: true,
    columns: [
      ...standardDimensions(),
      c('gameplays', 'UInt64', 'Number of non-outlier gameplay records represented by the row.'),
      c('video_ad_visible_time', 'Float64', 'Total milliseconds a video advertisement was visible during represented gameplays; divide by 1000 for seconds.'),
      c('play_time', 'Float64', 'Total milliseconds spent in active gameplay; divide by 1000 for seconds.'),
      c('pre_play_time', 'Float64', 'Total milliseconds between page arrival and the first gameplay start; divide by 1000 for seconds.')
    ]
  },
  {
    name: 'dbt_p4d_netlib_overview',
    description: 'Hourly Netlib lobby and connection event totals for developer-owned games.',
    grain: 'One row per Europe/Amsterdam local hour, game, and team.',
    population: 'Netlib analytics events attributed to Poki for Developers games.',
    top_level: true,
    columns: [
      c('hour', 'DateTime', 'Europe/Amsterdam local hour in which the Netlib events occurred; this follows CET/CEST daylight saving.'),
      c('p4d_game_id', 'String', 'Stable Poki for Developers game ID.'),
      c('team_id', 'String', 'ID of the Poki for Developers team that owns the game.'),
      c('lobbies_created', 'UInt64', 'Number of lobby-created events during the hour.'),
      c('lobbies_joined', 'UInt64', 'Number of lobby-joined events during the hour.'),
      c('lobbies_updated', 'UInt64', 'Number of lobby-updated events during the hour.'),
      c('client_connected', 'UInt64', 'Number of client-connected events during the hour.'),
      c('peer_connections', 'UInt64', 'Distinct connected peer identifiers observed during the hour. A peer-to-peer connection is represented by both peers, so divide the summed value by 2 for connected peer pairs.')
    ]
  },
  {
    name: 'dbt_p4d_monetization',
    description: 'Daily audience, playtime, ad-impression, and per-format developer-earnings totals. Ad field semantics are bundled with the table. Optional public SDK background: https://sdk.poki.com/sdk-documentation.',
    grain: 'One row per date, game, device category, country, context, and team.',
    population: 'Daily users, playtime, ad impressions, and attributed earnings in the monetization model.',
    top_level: true,
    columns: [
      ...standardDimensions().filter(column => column.name !== 'p4d_game_version_id'),
      c('platform_display_impressions', 'UInt64', 'Revenue-share-eligible display-ad impressions served by the Poki platform outside the game canvas.'),
      c('preroll_video_impressions', 'UInt64', 'Video-ad impressions shown before gameplay.'),
      c('gamebar_display_impressions', 'UInt64', 'Display-ad impressions served in the Poki game bar.'),
      c('ingame_display_impressions', 'UInt64', 'Display-ad impressions served inside the game experience.'),
      c('midroll_video_impressions', 'UInt64', 'Commercial-break video impressions shown at natural gameplay interruptions.'),
      c('rewarded_video_impressions', 'UInt64', 'Rewarded video impressions initiated by player choice.'),
      c('daily_active_users', 'UInt64', 'Distinct users active on the game page during the date.'),
      c('daily_playing_users', 'UInt64', 'Distinct active users who reached gameplay during the date.'),
      c('total_play_time', 'Float64', 'Total active gameplay time in seconds.'),
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
    population: 'Developer earnings attributed to the represented game and audience dimensions.',
    top_level: true,
    columns: [
      ...standardDimensions().filter(column => column.name !== 'p4d_game_version_id'),
      ...earnings(),
      c('developer_earnings_shared_eur', 'Float64', 'Server-calculated shared developer earnings in euros.'),
      c('developer_earnings_shared_usd', 'Float64', 'Server-calculated shared developer earnings in US dollars.')
    ]
  },
  {
    name: 'dbt_p4d_game_errors_per_gameplay',
    description: 'Hourly JavaScript error occurrences grouped by gameplay and execution environment. Each row identifies one error within one gameplay.',
    grain: 'One row per hour, game, version, environment, error fingerprint, and gameplay.',
    population: 'Gameplays that emitted a captured JavaScript error; rows are error/gameplay combinations.',
    top_level: true,
    columns: [
      c('date_hour', 'DateTime', 'Europe/Amsterdam local hour in which the error occurred; this follows CET/CEST daylight saving.'),
      c('p4d_game_id', 'String', 'Stable Poki for Developers game ID.'),
      c('p4d_game_version_id', 'String', 'Poki for Developers version ID that emitted the error.'),
      c('team_id', 'String', 'ID of the Poki for Developers team that owns the game.'),
      c('engine', 'String', 'Game engine recorded for the game.'),
      c('engine_version', 'String', 'Game engine version reported with the error.'),
      c('browser_name', 'String', 'Parsed browser name.'),
      c('browser_version', 'String', 'Parsed browser version.'),
      c('device_category', 'String', 'Recorded device category: desktop, mobile, or tablet.'),
      c('error_name', 'String', 'JavaScript error name or class.'),
      c('error_message', 'String', 'Normalized error message with skipped-error throttling suffixes removed.'),
      c('sum_skipped', 'UInt64', 'Number of additional occurrences reported as skipped by server-side error throttling.'),
      c('error_id', 'String', 'Stable error fingerprint used to group equivalent errors.'),
      c('error_stack', 'String', 'Most common stack trace for the grouped row.'),
      c('stack_line', 'String', 'Most common primary stack line for the grouped row.'),
      c('errors', 'UInt64', 'Observed occurrence count for this error in this gameplay row.'),
      c('gameplay_id', 'UInt64', 'Numeric gameplay identifier parsed from the error report\'s user identifier.'),
      c('same_engine_games', 'UInt64', 'Number of other games using the same engine that emitted the same error name and message in the modeled period.')
    ]
  },
  {
    name: 'dbt_p4d_game_errors_gameplays',
    description: 'Hourly gameplay totals by game version and environment, intended as denominators for error-impact calculations.',
    grain: 'One row per hour, game, version, engine, browser, device category, and team.',
    population: 'Gameplay sessions represented by the error-impact denominator model.',
    top_level: true,
    columns: [
      c('date_hour', 'DateTime', 'Europe/Amsterdam local hour containing the gameplay sessions; this follows CET/CEST daylight saving.'),
      c('p4d_game_id', 'String', 'Stable Poki for Developers game ID.'),
      c('p4d_game_version_id', 'String', 'Poki for Developers version ID.'),
      c('team_id', 'String', 'ID of the Poki for Developers team that owns the game.'),
      c('engine', 'String', 'Game engine recorded for the game.'),
      c('browser_name', 'String', 'Parsed browser name.'),
      c('browser_version', 'String', 'Parsed browser version.'),
      c('device_category', 'String', 'Recorded device category: desktop, mobile, or tablet.'),
      c('gameplays', 'UInt64', 'Distinct gameplay sessions in the environment row.')
    ]
  },
  {
    name: 'dbt_p4d_game_new_high_impact_errors',
    description: 'Errors not seen for the same game in the prior seven days that affect at least 10% of at least 500 daily gameplays.',
    grain: 'One row per date, game, and new high-impact error fingerprint.',
    population: 'Newly observed errors meeting the modeled daily gameplay-count and impact thresholds.',
    top_level: true,
    columns: [
      c('date', 'Date', 'Europe/Amsterdam calendar date on which the new high-impact error was detected.'),
      c('p4d_game_id', 'String', 'Stable Poki for Developers game ID.'),
      c('team_id', 'String', 'ID of the Poki for Developers team that owns the game.'),
      c('error_id', 'String', 'Stable error fingerprint.'),
      c('error_name', 'String', 'Representative JavaScript error name or class.'),
      c('error_message', 'String', 'Representative normalized error message.'),
      c('error_stack', 'String', 'Most common stack trace for the error.'),
      c('stack_line', 'String', 'Most common primary stack line for the error.'),
      c('affected_gameplays', 'UInt64', 'Distinct gameplays in which the error occurred.'),
      c('total_gameplays', 'UInt64', 'Total modeled gameplays for the game on the date.'),
      c('gameplay_percentage', 'Float64', 'Approximate affected_gameplays divided by total_gameplays, capped at 1.0.')
    ]
  },
  {
    name: 'dbt_p4d_game_events_v2',
    description: 'Aggregated custom measure() events by game, version, audience, and event key. Rows are aggregates, not raw events. Naming semantics are bundled with the columns. Optional public integration guide: https://sdk.poki.com/game-events.',
    grain: 'One row per date, game, version, audience dimensions, and normalized event key.',
    population: 'Gameplays containing or emitting the represented custom event; one gameplay can contribute to many event rows.',
    top_level: true,
    columns: [
      ...eventDimensions(),
      c('gameplays', 'UInt64', 'Number of gameplays containing this category/what/action combination.'),
      c('starts', 'UInt64', 'Gameplays containing at least one start event for this category and what value.'),
      c('completes', 'UInt64', 'Gameplays containing at least one complete event for this category and what value.'),
      c('fails', 'UInt64', 'Gameplays containing at least one fail event for this category and what value.'),
      c('seen', 'UInt64', 'Gameplays containing at least one visible event for this category and what value.'),
      c('interacted', 'UInt64', 'Gameplays containing at least one interact event for this category and what value.'),
      c('lefts', 'UInt64', 'Gameplays containing a start event for this category and what value at the maximum retained event timestamp for that gameplay. A retained event with a later timestamp in any category or what prevents the count; an event at the same timestamp does not. This is inferred from the absence of later events, not an explicit leave signal.'),
      c('total_starts', 'UInt64', 'Total start event occurrences, including repeated starts within one gameplay.'),
      c('total_completes', 'UInt64', 'Total complete event occurrences, including repeats within one gameplay.'),
      c('total_fails', 'UInt64', 'Total fail event occurrences, including repeats within one gameplay.'),
      c('total_seen', 'UInt64', 'Total visible event occurrences, including repeats within one gameplay.'),
      c('total_interacted', 'UInt64', 'Total interact event occurrences, including repeats within one gameplay.'),
      c('total_events', 'UInt64', 'Total occurrences of all action values for this category/what/action grouping.')
    ]
  },
  {
    name: 'dbt_p4d_game_events_times_v2',
    description: 'Dynamic 1-, 5-, or 10-second buckets for custom-event arrival and start-to-outcome timing below one hour. Timing semantics are bundled with the columns. Optional public integration guide: https://sdk.poki.com/game-events.',
    grain: 'One row per date, game, version, audience dimensions, event key, timing type, and time bucket.',
    population: 'Gameplays with a selected custom-event timing; one gameplay can contribute to multiple event/timing groups.',
    top_level: true,
    columns: [
      ...eventDimensions(),
      c('time_type', 'String', 'Timing being bucketed: event for first arrival, complete or fail since the preceding start, or interact since the preceding visible event.'),
      c('time_bucket', 'UInt64', 'Inclusive lower bound of the bucket in seconds; modeled values are non-negative and below 3600.'),
      c('time_granularity', 'UInt64', 'Bucket width in seconds: 1, 5, or 10, selected to keep the distribution below roughly 100 buckets.'),
      c('gameplays', 'UInt64', 'Number of gameplays whose selected timing falls in this bucket.')
    ]
  },
  {
    name: 'dbt_p4d_game_events_funnel_v2',
    description: 'Ordered custom-event prefixes for funnel traversal. The model keeps at most the first 200 events per gameplay and omits a date/game with more than 5000 distinct event keys. Funnel hashes are signed 64-bit identifiers that may exceed JavaScript safe-integer precision: select event_hash through toString, and use prefix_hashes only as a has_any_int64 filter with exact decimal strings. Funnel semantics are bundled with the columns. Optional public integration guide: https://sdk.poki.com/game-events.',
    grain: 'One row per date, game, version, audience dimensions, event, and ordered prefix position/hash.',
    population: 'Sampled eligible gameplay event sequences; one gameplay contributes to multiple retained prefix rows.',
    top_level: true,
    columns: [
      c('date', 'Date', 'Europe/Amsterdam calendar date on which the event sequence occurred.'),
      c('p4d_game_id', 'String', 'Stable Poki for Developers game ID.'),
      c('p4d_version_id', 'String', 'Poki for Developers version ID that emitted the sequence.'),
      c('team_id', 'String', 'ID of the Poki for Developers team that owns the game.'),
      c('user_new', 'UInt8', '1 when the sequence came from a user considered new to the game, otherwise 0.'),
      c('device_category', 'String', 'Audience device category recorded for the sequence: desktop, mobile, or tablet.'),
      c('prefix_len', 'UInt64', 'Zero-based position of this event in the retained gameplay sequence.'),
      c('event', 'String', "Canonical funnel event key encoded as category^what^action, with '^' reserved as the separator. Special action values are lowercased. Pass this value verbatim to game-event-funnels --event."),
      c('event_hash', 'Int64', 'Signed 64-bit hash of the ordered sequence prefix ending at this event. It may exceed JavaScript safe-integer precision. Select one hash with {alias: "event_hash", function: {name: "toString", args: [{field: "event_hash"}]}}; for distinct hashes, aggregate the same toString function with groupUniqArray. The CLI rejects direct numeric output and numeric comparisons. Never consume this identifier as a JavaScript number.'),
      c('prefix_hashes', 'Array(Int64)', 'Eligible prior-prefix hashes used for skip-tolerant traversal, bounded to the recent lookback window. This is filter-only in the CLI: use ["prefix_hashes", "has_any_int64", ["-8340446448795919230"]] with exact base-10 decimal strings, never JavaScript numbers. Direct output, scalar has, and other operators are rejected.'),
      c('gameplay_sample_percentage', 'Float64', 'Percentage of eligible gameplay sequences represented by the row; currently emitted as 100.'),
      c('gameplays', 'UInt64', 'Number of gameplays represented by this event and prefix combination.')
    ]
  },
  {
    name: 'dbt_p4d_player_feedback',
    description: 'Player feedback joined with available browser, device, gameplay, error, and screenshot diagnostics.',
    grain: 'One row per player feedback submission.',
    population: 'Submitted thumbs-up, thumbs-down, and bug-report feedback with available diagnostics.',
    top_level: true,
    columns: [
      c('timestamp', 'DateTime', 'Europe/Amsterdam local timestamp at which the feedback was submitted; this follows CET/CEST daylight saving.'),
      c('type', 'String', 'Feedback kind: thumbs_up, thumbs_down, or bugreport; this value set is enforced at ingestion.'),
      c('message', 'String', 'Original player feedback message.'),
      c('english_message', 'String', 'English translation when one was captured; otherwise an empty string.'),
      c('screenshot_url', 'String', 'URL of an attached screenshot when available.'),
      c('p4d_game_id', 'String', 'Stable Poki for Developers game ID.'),
      c('team_id', 'String', 'ID of the Poki for Developers team that owns the game.'),
      c('country', 'String', 'Human-readable country name.'),
      c('country_code', 'String', 'Uppercase two-letter country code.'),
      c('browser_name', 'Nullable(String)', 'Parsed browser name; null for feedback sources without diagnostics.'),
      c('browser_version', 'Nullable(String)', 'Parsed browser version; null when unavailable.'),
      c('os_name', 'Nullable(String)', 'Parsed operating-system name; null when unavailable.'),
      c('os_version', 'Nullable(String)', 'Parsed operating-system version; null when unavailable.'),
      c('device_category', 'Nullable(String)', 'Recorded device category: desktop, mobile, or tablet; null when unavailable.'),
      c('p4d_version_id', 'Nullable(String)', 'Poki for Developers version ID active for the feedback; null when unavailable.'),
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
    population: 'Daily game traffic and attributed engagement, monetization, and earnings represented by the overview model.',
    top_level: true,
    columns: [
      c('date', 'Date', 'Europe/Amsterdam metric date.'),
      c('release_date', 'Date', 'Europe/Amsterdam calendar date on which the current release phase began.'),
      c('release_status', 'String', 'Game release status on the metric date: one of not-released, no-link-release, technical-test, soft-release, limited-release, full-release, or 10k-test, each also occurring with a -with-content-restrictions suffix.'),
      c('release_status_changed_at', 'DateTime', 'Europe/Amsterdam local timestamp at which the release status last changed; this follows CET/CEST daylight saving.'),
      c('p4d_game_id', 'String', 'Stable Poki for Developers game ID.'),
      c('team_id', 'String', 'ID of the Poki for Developers team that owns the game.'),
      c('device_category', 'String', 'Audience device category: desktop, mobile, or tablet.'),
      c('country_id', 'String', 'Two-letter audience country code.'),
      c('num_domains_live', 'UInt64', 'Number of distinct sites or domains on which the game was live.'),
      c('gameplays', 'UInt64', 'Number of gameplay sessions.'),
      ...earnings(),
      c('daily_active_users', 'UInt64', 'Distinct users active on the game page.'),
      c('daily_playing_users', 'UInt64', 'Distinct active users who reached gameplay.'),
      c('play_time', 'Float64', 'Total active gameplay time in seconds.'),
      c('pre_play_time', 'Float64', 'Total seconds between page arrival and first gameplay.'),
      c('video_ad_visible_time', 'Float64', 'Total seconds video advertisements were visible.'),
      c('ingame_display_impressions', 'UInt64', 'In-game display-ad impression count.'),
      c('gamebar_display_impressions', 'UInt64', 'Game-bar display-ad impression count.'),
      c('platform_display_impressions', 'UInt64', 'Platform display-ad impression count.'),
      c('preroll_video_impressions', 'UInt64', 'Pre-roll video-ad impression count.'),
      c('midroll_video_impressions', 'UInt64', 'Mid-roll commercial-break impression count.'),
      c('rewarded_video_impressions', 'UInt64', 'Rewarded video-ad impression count.'),
      c('video_ad_visible_time_dpu', 'Float64', 'Total video-ad-visible seconds attributed to DPU (daily playing users); divide by daily_playing_users for a per-playing-user value.'),
      c('play_time_dpu', 'Float64', 'Total active gameplay seconds attributed to DPU; divide by daily_playing_users for a per-playing-user value.'),
      c('pre_play_time_dpu', 'Float64', 'Total pre-play seconds attributed to DPU; divide by daily_playing_users for a per-playing-user value.')
    ]
  },
  {
    name: 'dbt_p4d_quick_stats',
    description: 'Precomputed team developer-earnings totals for common reporting windows. Rolling windows end yesterday; all-time also excludes today.',
    grain: 'One row per team.',
    population: 'Developer earnings for the represented team across fixed reporting windows.',
    top_level: true,
    columns: [
      c('team_id', 'String', 'ID of the Poki for Developers team.'),
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
    population: 'Current game metadata available to the analytics join.',
    top_level: false,
    join_on: 'p4d_game_id',
    columns: [
      c('id', 'String', 'Stable Poki for Developers game ID.'),
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
    population: 'Current release and distribution metadata available to the analytics join.',
    top_level: false,
    join_on: 'p4d_game_id',
    columns: [
      c('p4d_game_id', 'String', 'Stable Poki for Developers game ID.'),
      c('release_status', 'String', 'Current game release status: one of not-released, no-link-release, technical-test, soft-release, limited-release, full-release, or 10k-test, each also occurring with a -with-content-restrictions suffix.'),
      c('release_status_changed_at', 'DateTime', 'Europe/Amsterdam local timestamp at which the release status last changed; this follows CET/CEST daylight saving.'),
      c('release_date', 'Date', 'Europe/Amsterdam calendar date on which the current release phase began.'),
      c('num_domains_live', 'UInt64', 'Number of distinct sites or domains on which the game is live.')
    ]
  }
]

export function findTable (name: string): TableDefinition | undefined {
  return tableCatalog.find(table => table.name === name)
}

function hasColumn (table: TableDefinition, name: string): boolean {
  return table.columns.some(column => column.name === name)
}

// Advisory cross-check of a locally validated query against the bundled
// snapshot. Unknown names produce warnings, never rejections: the deployed API
// remains authoritative and may know newer tables and columns.
export function snapshotWarnings (query: Record<string, unknown>): string[] {
  if (typeof query.from !== 'string') return []
  const warnings = new Set<string>()
  const missingTable = (name: string): void => {
    warnings.add(`table '${name}' is not in the bundled snapshot; the API may reject it`)
  }
  const from = findTable(query.from)
  if (from === undefined) {
    missingTable(query.from)
    return [...warnings]
  }

  const select = Array.isArray(query.select) ? query.select.filter(isRecord) : []
  const outputNames = new Set<string>()
  for (const statement of select) {
    const outputName = resolvedSelectOutputName(statement)
    if (outputName !== undefined) outputNames.add(outputName)
  }

  const checkField = (name: unknown, allowOutputName = false): void => {
    if (typeof name !== 'string' || (allowOutputName && outputNames.has(name))) return
    const separator = name.indexOf('.')
    const table = separator === -1 ? from : findTable(name.slice(0, separator))
    if (table === undefined) {
      missingTable(name.slice(0, separator))
      return
    }
    const column = separator === -1 ? name : name.slice(separator + 1)
    if (!hasColumn(table, column)) {
      warnings.add(`field '${column}' is not a bundled column of table '${table.name}'; the API may reject it`)
    }
  }

  select.forEach((statement, index) => {
    visitSelectExpression(statement, {
      field: field => checkField(field)
    }, { path: `select[${index}]` })
  })
  if (Array.isArray(query.group)) query.group.forEach(field => checkField(field, true))
  if (Array.isArray(query.order)) query.order.filter(isRecord).forEach(order => checkField(order.field, true))
  if (isRecord(query.include)) Object.keys(query.include).forEach(field => checkField(field, true))
  if (query.where !== undefined) {
    // A condition may reference a select output column, so where resolves names
    // through the same output-name rule as group, order, and include instead of
    // reporting a user-defined alias as a missing bundled column.
    visitSelectExpression(query.where, {
      field: field => checkField(field, true)
    }, { root: 'condition', path: 'where' })
  }

  return [...warnings]
}
