import { visitSelectExpression } from './select-expression'

export interface DataMetric {
  name: string
  description: string
  unit: string
  population: string
  aggregation_kind: 'sum' | 'ratio_of_sums' | 'row_level'
  aggregation_guidance: string
  required_dimensions: string[]
  supported_tables: string[]
  formula: Record<string, unknown>
  required_fields: string[]
  notes?: string[]
}

const sum = (field: string): Record<string, unknown> => ({ aggregate: 'sum', field })
const constant = (value: number): Record<string, unknown> => ({ constant: value })
const formula = (operator: '+' | '/', terms: Array<Record<string, unknown>>): Record<string, unknown> => ({ operator, terms })

const timeSpent = formula('+', [sum('pre_play_time'), sum('play_time'), sum('video_ad_visible_time')])
const engagementTimeSpentSeconds = formula('/', [{ formula: timeSpent }, constant(1000)])
const timeSpentDpu = formula('+', [sum('pre_play_time_dpu'), sum('play_time_dpu'), sum('video_ad_visible_time_dpu')])
const ads = formula('+', [
  sum('ingame_display_impressions'),
  sum('gamebar_display_impressions'),
  sum('platform_display_impressions'),
  sum('preroll_video_impressions'),
  sum('midroll_video_impressions'),
  sum('rewarded_video_impressions')
])
// The alias satisfies the grammar's count-alias requirement so the formula is
// directly usable inside a select statement, as `data metric` documents.
const days = { aggregate: 'count', distinct: true, field: 'date', alias: 'days' }

type MetricDefinition = Omit<DataMetric, 'required_fields' | 'required_dimensions'> & { required_dimensions?: string[] }

const metricDefinitions: MetricDefinition[] = [
  {
    name: 'conversion_to_play',
    description: 'Share of daily active users who reached gameplay.',
    unit: 'ratio',
    population: 'Daily active users, with daily playing users as the numerator subset.',
    aggregation_kind: 'ratio_of_sums',
    aggregation_guidance: 'Use a ratio of sums over compatible rows; do not average row-level conversion ratios.',
    required_dimensions: ['date', 'p4d_game_id'],
    supported_tables: ['dbt_p4d_users', 'dbt_p4d_monetization', 'dbt_p4d_games_overview'],
    formula: formula('/', [sum('daily_playing_users'), sum('daily_active_users')])
  },
  {
    name: 'time_spent',
    description: 'Total pre-play, active-play, and visible-video-ad time.',
    unit: 'seconds',
    population: 'Time represented by game-overview traffic.',
    aggregation_kind: 'sum',
    aggregation_guidance: 'The three overview components are stored in seconds and additive over compatible rows.',
    supported_tables: ['dbt_p4d_games_overview'],
    formula: timeSpent
  },
  {
    name: 'engagement_time_spent',
    description: 'Total pre-play, active-play, and visible-video-ad time from completed non-outlier gameplays, normalized from raw milliseconds to seconds.',
    unit: 'seconds',
    population: 'Completed gameplay records after detected engagement outliers are excluded.',
    aggregation_kind: 'sum',
    aggregation_guidance: 'Sum the three raw millisecond components, then divide once by 1000. Do not label the unconverted source fields as seconds.',
    supported_tables: ['dbt_p4d_engagement_per_gameplay'],
    formula: engagementTimeSpentSeconds,
    notes: ['The source table stores time in milliseconds; this formula returns seconds.']
  },
  {
    name: 'time_spent_dpu',
    description: 'Total pre-play, active-play, and visible-video-ad time attributed to DPU (daily playing users).',
    unit: 'seconds',
    population: 'Time attributed to daily playing users in the game overview model.',
    aggregation_kind: 'sum',
    aggregation_guidance: 'The three DPU-attributed components are additive over compatible overview rows.',
    supported_tables: ['dbt_p4d_games_overview'],
    formula: timeSpentDpu
  },
  {
    name: 'ads',
    description: 'Total display, preroll, midroll, and rewarded ad impressions.',
    unit: 'impressions',
    population: 'Ad impressions represented by the selected game and audience dimensions.',
    aggregation_kind: 'sum',
    aggregation_guidance: 'The six format counts are additive over compatible rows within one supported table.',
    supported_tables: ['dbt_p4d_monetization', 'dbt_p4d_games_overview'],
    formula: ads
  },
  {
    name: 'time_spent_per_dau',
    description: 'Total time spent divided by daily active users.',
    unit: 'seconds per daily active user',
    population: 'Daily active users and all represented time in the game overview model.',
    aggregation_kind: 'ratio_of_sums',
    aggregation_guidance: 'Use a ratio of summed time to summed daily active users; do not average per-row ratios.',
    required_dimensions: ['date', 'p4d_game_id'],
    supported_tables: ['dbt_p4d_games_overview'],
    formula: formula('/', [{ formula: timeSpent }, sum('daily_active_users')])
  },
  {
    name: 'time_spent_per_gameplay',
    description: 'DPU-attributed time spent divided by gameplays.',
    unit: 'seconds per gameplay',
    population: 'Overview gameplays and DPU-attributed time at the same daily game/audience grain.',
    aggregation_kind: 'ratio_of_sums',
    aggregation_guidance: 'Use a ratio of summed DPU-attributed time to summed gameplays; do not average per-row ratios.',
    supported_tables: ['dbt_p4d_games_overview'],
    formula: formula('/', [{ formula: timeSpentDpu }, sum('gameplays')])
  },
  {
    name: 'ads_per_dau',
    description: 'Total ad impressions divided by daily active users.',
    unit: 'impressions per daily active user',
    population: 'Daily active users and ad impressions represented by the selected monetization or game-overview rows.',
    aggregation_kind: 'ratio_of_sums',
    aggregation_guidance: 'Use a ratio of summed impressions to summed daily active users; do not average per-row ratios.',
    required_dimensions: ['date', 'p4d_game_id'],
    supported_tables: ['dbt_p4d_monetization', 'dbt_p4d_games_overview'],
    formula: formula('/', [{ formula: ads }, sum('daily_active_users')])
  },
  {
    name: 'ads_per_playtime_hour',
    description: 'Total ad impressions divided by active play time in hours.',
    unit: 'impressions per playtime hour',
    population: 'Ad impressions and active play time in the game overview model.',
    aggregation_kind: 'ratio_of_sums',
    aggregation_guidance: 'Use summed impressions divided by summed play time converted to hours; guard a zero play-time denominator.',
    supported_tables: ['dbt_p4d_games_overview'],
    formula: formula('/', [{ formula: ads }, { formula: formula('/', [sum('play_time'), constant(3600)]) }]),
    notes: ['Consumers should guard division by zero; the division produces NaN or infinity when play time is zero, so map those to a safe value in the consumer.']
  },
  {
    name: 'gameplays_per_day',
    description: 'Total gameplays divided by distinct metric dates.',
    unit: 'gameplays per day',
    population: 'Unique gameplay counts from daily gameplay or game-overview aggregates, not event, timing, funnel, or error rows.',
    aggregation_kind: 'ratio_of_sums',
    aggregation_guidance: 'Sum gameplays and divide by distinct dates. Event-grain tables are incompatible because one gameplay can occur in many rows.',
    supported_tables: ['dbt_p4d_gameplays', 'dbt_p4d_games_overview'],
    formula: formula('/', [sum('gameplays'), days])
  },
  {
    name: 'netlib_connected_peer_pairs',
    description: 'Connected Netlib peer pairs derived from the two peer identifiers observed for each connection.',
    unit: 'connected peer pairs',
    population: 'Distinct connected Netlib peer identifiers represented by the selected hourly rows.',
    aggregation_kind: 'sum',
    aggregation_guidance: 'Within one visible or exactly filtered hour and game, sum compatible audience rows and divide once by 2 because each peer-to-peer connection is represented by both peers.',
    required_dimensions: ['hour', 'p4d_game_id'],
    supported_tables: ['dbt_p4d_netlib_overview'],
    formula: formula('/', [sum('peer_connections'), constant(2)])
  },
  {
    name: 'gameplay_sample_fraction',
    description: 'Gameplay sample percentage represented as a fraction.',
    unit: 'ratio',
    population: 'Eligible gameplay sequences represented by one custom-event funnel row.',
    aggregation_kind: 'row_level',
    aggregation_guidance: 'Evaluate at the funnel row grain; do not sum prefix rows as unique gameplays.',
    required_dimensions: ['prefix_len'],
    supported_tables: ['dbt_p4d_game_events_funnel_v2'],
    formula: formula('/', [{ field: 'gameplay_sample_percentage' }, constant(100)])
  },
  {
    name: 'estimated_gameplays_from_sample',
    description: 'Observed sampled gameplays divided by the sample fraction.',
    unit: 'estimated gameplays',
    population: 'Eligible gameplay sequences represented by one custom-event funnel row.',
    aggregation_kind: 'row_level',
    aggregation_guidance: 'Estimate at a compatible funnel grouping; do not sum overlapping prefix rows as unique gameplay totals.',
    required_dimensions: ['prefix_len'],
    supported_tables: ['dbt_p4d_game_events_funnel_v2'],
    formula: formula('/', [{ field: 'gameplays' }, { formula: formula('/', [{ field: 'gameplay_sample_percentage' }, constant(100)]) }])
  },
  {
    name: 'developer_earnings_eur_per_day',
    description: 'EUR developer earnings divided by distinct metric dates.',
    unit: 'EUR per day',
    population: 'Developer earnings attributed to selected game and audience dimensions.',
    aggregation_kind: 'ratio_of_sums',
    aggregation_guidance: 'Sum EUR earnings and divide by distinct dates; do not average row-level daily rates.',
    supported_tables: ['dbt_p4d_developer_earnings', 'dbt_p4d_games_overview'],
    formula: formula('/', [sum('developer_earnings_eur'), days])
  },
  {
    name: 'developer_earnings_usd_per_day',
    description: 'USD developer earnings divided by distinct metric dates.',
    unit: 'USD per day',
    population: 'Developer earnings attributed to selected game and audience dimensions.',
    aggregation_kind: 'ratio_of_sums',
    aggregation_guidance: 'Sum USD earnings and divide by distinct dates; do not average row-level daily rates.',
    supported_tables: ['dbt_p4d_developer_earnings', 'dbt_p4d_games_overview'],
    formula: formula('/', [sum('developer_earnings_usd'), days])
  }
]

export const dataMetrics: DataMetric[] = metricDefinitions.map(definition => {
  const requiredFields = new Set<string>()
  visitSelectExpression({ formula: definition.formula }, {
    field: field => requiredFields.add(field)
  })
  return {
    ...definition,
    required_dimensions: definition.required_dimensions ?? [],
    required_fields: [...requiredFields]
  }
})

export function findMetric (name: string): DataMetric | undefined {
  return dataMetrics.find(metric => metric.name === name)
}
