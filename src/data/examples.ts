import { isRecord } from '../json'
export interface DataRecipe {
  name: string
  description: string
  parameters: Record<string, string>
  tables: string[]
  query: Record<string, unknown>
}

const teamParameter = { TEAM_ID: 'Authenticated user\'s exact Poki for Developers team ID.' }
const gameParameter = { GAME_ID: 'Poki for Developers game ID.' }
const dateParameters = {
  FROM_DATE: 'Inclusive Europe/Amsterdam calendar date in YYYY-MM-DD format.',
  TO_DATE: 'Inclusive Europe/Amsterdam calendar date in YYYY-MM-DD format.'
}
const dateTimeParameters = {
  FROM_DATETIME: 'Inclusive Europe/Amsterdam local timestamp in YYYY-MM-DD HH:mm:ss format; use CET or CEST according to the date.',
  TO_DATETIME: 'Inclusive Europe/Amsterdam local timestamp in YYYY-MM-DD HH:mm:ss format; use CET or CEST according to the date.'
}
const gameDateParameters = { ...teamParameter, ...gameParameter, ...dateParameters }

const gameDateExpressions = [
  ['team_id', '==', '<TEAM_ID>'],
  ['p4d_game_id', '==', '<GAME_ID>'],
  ['date', '>=', '<FROM_DATE>'],
  ['date', '<=', '<TO_DATE>']
]

const noLifecycleExpressions = [
  ['dbt_p4d_game_events_v2.starts', '==', 0],
  ['dbt_p4d_game_events_v2.completes', '==', 0],
  ['dbt_p4d_game_events_v2.fails', '==', 0],
  ['dbt_p4d_game_events_v2.seen', '==', 0],
  ['dbt_p4d_game_events_v2.interacted', '==', 0],
  ['dbt_p4d_game_events_v2.category', '!=', 'funnel']
]

function dailyQuery (from: string, select: Array<Record<string, unknown>>): Record<string, unknown> {
  return {
    from,
    select: [...select, { field: 'date' }],
    where: { expressions: gameDateExpressions },
    group: ['date'],
    order: [{ field: 'date', direction: 'asc' }]
  }
}

function dailyDeviceQuery (
  from: string,
  select: Array<Record<string, unknown>>,
  expressions: unknown[] = gameDateExpressions
): Record<string, unknown> {
  return {
    from,
    select: [...select, { field: 'date' }, { field: 'device_category' }],
    where: { expressions },
    group: ['date', 'device_category'],
    order: [{ field: 'date', direction: 'asc' }]
  }
}

// Progress-style and interaction-style event exports differ only in which
// lifecycle counters they sum and which must be non-zero.
function lifecycleEventsQuery (sums: string[], nonZero: string[]): Record<string, unknown> {
  return {
    from: 'dbt_p4d_game_events_v2',
    select: [
      { field: 'category' }, { field: 'action' },
      ...sums.map(field => ({ field, aggregate: 'sum' }))
    ],
    where: {
      expressions: [
        ...gameDateExpressions,
        ['label', '==', ''],
        {
          operator: 'or',
          expressions: nonZero.map(field => [`dbt_p4d_game_events_v2.${field}`, '>', 0])
        }
      ]
    },
    group: ['category', 'action'],
    order: [{ field: 'gameplays', direction: 'desc' }],
    offset: 0,
    limit: 10000
  }
}

// The paginated variant differs from the export only in its page size.
const plainEventTotalsQuery = {
  from: 'dbt_p4d_game_events_v2',
  select: [{ field: 'category' }, { field: 'action' }, { field: 'label' }, { field: 'gameplays', aggregate: 'sum' }],
  where: { expressions: [...gameDateExpressions, ...noLifecycleExpressions] },
  group: ['category', 'action', 'label'],
  order: [{ field: 'gameplays', direction: 'desc' }],
  offset: 0,
  limit: 10000
}

export const dataRecipes: DataRecipe[] = [
  {
    name: 'team-gameplays',
    description: 'Daily gameplay totals for a team, split by device category.',
    parameters: { ...teamParameter, ...dateParameters },
    tables: ['dbt_p4d_gameplays'],
    query: dailyDeviceQuery('dbt_p4d_gameplays', [{ field: 'gameplays', aggregate: 'sum' }], [
      ['team_id', '==', '<TEAM_ID>'],
      ['date', '>=', '<FROM_DATE>'],
      ['date', '<=', '<TO_DATE>']
    ])
  },
  {
    name: 'game-earnings',
    description: 'Daily direct and shared developer earnings for one game in EUR and USD, split by device category.',
    parameters: gameDateParameters,
    tables: ['dbt_p4d_developer_earnings'],
    query: dailyDeviceQuery('dbt_p4d_developer_earnings', [
      'developer_earnings_eur',
      'developer_earnings_usd',
      'developer_earnings_shared_eur',
      'developer_earnings_shared_usd'
    ].map(field => ({ field, aggregate: 'sum' })))
  },
  {
    name: 'game-errors',
    description: 'Highest-impact errors for a game, including representative stacks and affected gameplay counts.',
    parameters: { ...teamParameter, ...gameParameter, ...dateTimeParameters },
    tables: ['dbt_p4d_game_errors_per_gameplay'],
    query: {
      from: 'dbt_p4d_game_errors_per_gameplay',
      select: [
        { field: 'errors', aggregate: 'sum', alias: 'total_errors' },
        { field: 'gameplay_id', aggregate: 'count', distinct: true, alias: 'gameplays' },
        { field: 'error_name' },
        { field: 'error_message' },
        { field: 'error_stack', aggregate: 'topKWeighted', weight: 'errors' },
        { field: 'stack_line', aggregate: 'topKWeighted', weight: 'errors' },
        { field: 'error_id' },
        { field: 'same_engine_games', aggregate: 'max' }
      ],
      where: {
        expressions: [
          ['team_id', '==', '<TEAM_ID>'],
          ['p4d_game_id', '==', '<GAME_ID>'],
          ['date_hour', '>=', '<FROM_DATETIME>'],
          ['date_hour', '<=', '<TO_DATETIME>']
        ]
      },
      group: ['error_name', 'error_message', 'error_id'],
      order: [{ field: 'total_errors', direction: 'desc' }],
      offset: 0,
      limit: 100
    }
  },
  {
    name: 'all-game-events',
    description: 'All custom event Category, What, and Action combinations for a game, ordered by gameplay reach. Result fields use backend names category, action, and label respectively.',
    parameters: gameDateParameters,
    tables: ['dbt_p4d_game_events_v2'],
    query: {
      from: 'dbt_p4d_game_events_v2',
      select: [
        { field: 'category' },
        { field: 'action' },
        { field: 'label' },
        { field: 'gameplays', aggregate: 'sum' }
      ],
      where: { expressions: gameDateExpressions },
      group: ['category', 'action', 'label'],
      order: [{ field: 'gameplays', direction: 'desc' }],
      limit: 10000
    }
  },
  {
    name: 'game-event-starts-export',
    description: 'Start, complete, failure, exit, and raw occurrence totals for progress-style events, ready for CSV export.',
    parameters: gameDateParameters,
    tables: ['dbt_p4d_game_events_v2'],
    query: lifecycleEventsQuery(
      ['gameplays', 'starts', 'completes', 'fails', 'lefts', 'total_starts', 'total_completes', 'total_fails'],
      ['starts', 'completes', 'fails']
    )
  },
  {
    name: 'game-event-visibility-export',
    description: 'Visible and interacted lifecycle totals for interaction-style events, ready for CSV export.',
    parameters: gameDateParameters,
    tables: ['dbt_p4d_game_events_v2'],
    query: lifecycleEventsQuery(
      ['gameplays', 'seen', 'interacted', 'total_seen', 'total_interacted'],
      ['seen', 'interacted']
    )
  },
  {
    name: 'game-events-export',
    description: 'Plain non-lifecycle, non-funnel event totals by frontend Category, What, and Action, ready for CSV export. Result fields use backend names category, action, and label respectively.',
    parameters: gameDateParameters,
    tables: ['dbt_p4d_game_events_v2'],
    query: plainEventTotalsQuery
  },
  {
    name: 'game-events',
    description: 'Paginated plain non-lifecycle, non-funnel event totals in pages of 100; adjust offset, limit, and order to browse additional rows.',
    parameters: gameDateParameters,
    tables: ['dbt_p4d_game_events_v2'],
    query: { ...plainEventTotalsQuery, limit: 100 }
  },
  {
    name: 'game-event-time-buckets',
    description: 'Dynamic timing histogram for one event and timing type; buckets are measured in seconds.',
    parameters: {
      ...gameDateParameters,
      TIME_TYPE: 'One of event, complete, fail, or interact.',
      CATEGORY: 'Exact frontend Category; applied to backend field category.',
      ACTION: 'Exact frontend What; applied to legacy backend field action.',
      LABEL: 'Exact frontend Action; applied to legacy backend field label. Use an empty string for normalized lifecycle Actions when applicable.'
    },
    tables: ['dbt_p4d_game_events_times_v2'],
    query: {
      from: 'dbt_p4d_game_events_times_v2',
      select: [
        { field: 'time_bucket' },
        { field: 'time_granularity', aggregate: 'max', alias: 'time_granularity' },
        { field: 'gameplays', aggregate: 'sum' }
      ],
      where: {
        expressions: [
          ...gameDateExpressions,
          ['time_type', '==', '<TIME_TYPE>'],
          ['category', '==', '<CATEGORY>'],
          ['action', '==', '<ACTION>'],
          ['label', '==', '<LABEL>']
        ]
      },
      group: ['time_bucket'],
      order: [{ field: 'time_bucket', direction: 'asc' }]
    }
  },
  {
    name: 'player-feedback',
    description: 'Recent player feedback with browser and gameplay diagnostics, plus normalized included game versions.',
    parameters: { ...teamParameter, ...gameParameter, ...dateTimeParameters },
    tables: ['dbt_p4d_player_feedback'],
    query: {
      from: 'dbt_p4d_player_feedback',
      select: ['timestamp', 'type', 'country', 'country_code', 'message', 'english_message', 'browser_name', 'browser_version', 'os_name', 'os_version', 'device_category', 'p4d_version_id', 'has_adblock', 'game_resolution', 'was_fullscreen_this_gameplay', 'loading_finished', 'gametime_seconds', 'errors', 'webgl_renderer', 'device_pixel_ratio', 'screenshot_url'].map(field => ({ field })),
      where: {
        expressions: [
          ['team_id', '==', '<TEAM_ID>'],
          ['p4d_game_id', '==', '<GAME_ID>'],
          ['timestamp', '>=', '<FROM_DATETIME>'],
          ['timestamp', '<=', '<TO_DATETIME>']
        ]
      },
      order: [{ field: 'timestamp', direction: 'desc' }],
      offset: 0,
      limit: 100,
      include: { p4d_version_id: { type: 'game_versions' } }
    }
  },
  {
    name: 'monetization',
    description: 'Daily audience, ad-impression, and total play-time values for one game.',
    parameters: gameDateParameters,
    tables: ['dbt_p4d_monetization'],
    query: dailyQuery('dbt_p4d_monetization', ['daily_active_users', 'ingame_display_impressions', 'gamebar_display_impressions', 'platform_display_impressions', 'preroll_video_impressions', 'midroll_video_impressions', 'rewarded_video_impressions', 'total_play_time'].map(field => ({ field, aggregate: 'sum' })))
  },
  {
    name: 'game-gameplays',
    description: 'Daily gameplay totals for one game, split by device category.',
    parameters: gameDateParameters,
    tables: ['dbt_p4d_gameplays'],
    query: dailyDeviceQuery('dbt_p4d_gameplays', [{ field: 'gameplays', aggregate: 'sum' }])
  },
  {
    name: 'game-users',
    description: 'Daily active, playing, non-playing, loading, and finished-loading user totals for one game. For external gameplay outside Poki, loading users fall back to active users; context is playground for gameplay on Poki and external otherwise.',
    parameters: gameDateParameters,
    tables: ['dbt_p4d_users'],
    query: dailyQuery('dbt_p4d_users', [
      { field: 'daily_playing_users', aggregate: 'sum' },
      { field: 'daily_not_playing_users', aggregate: 'sum' },
      { field: 'daily_active_users', aggregate: 'sum' },
      {
        alias: 'daily_loading_users',
        aggregate: 'sum',
        function: {
          name: 'if',
          args: [
            ['context', '==', 'playground'],
            { field: 'daily_loading_users' },
            { field: 'daily_active_users' }
          ]
        }
      },
      { field: 'daily_finished_loading_users', aggregate: 'sum' }
    ])
  },
  {
    name: 'conversion-to-play',
    description: 'Daily ratio of playing users to active users for one game.',
    parameters: gameDateParameters,
    tables: ['dbt_p4d_users'],
    query: dailyQuery('dbt_p4d_users', [{
      alias: 'conversion_to_play',
      formula: {
        operator: '/',
        terms: [
          { field: 'daily_playing_users', aggregate: 'sum' },
          { field: 'daily_active_users', aggregate: 'sum' }
        ]
      }
    }])
  },
  {
    name: 'total-time-spent',
    description: 'Gameplay-based total pre-play, play, and video-ad-visible seconds for one game and date range, plus the represented gameplay count. Raw source milliseconds are divided by 1000.',
    parameters: gameDateParameters,
    tables: ['dbt_p4d_engagement_per_gameplay'],
    query: {
      from: 'dbt_p4d_engagement_per_gameplay',
      select: [
        { field: 'gameplays', aggregate: 'sum' },
        ...['video_ad_visible_time', 'play_time', 'pre_play_time'].map(field => ({
          alias: `${field}_seconds`,
          formula: { operator: '/', terms: [{ field, aggregate: 'sum' }, { constant: 1000 }] }
        }))
      ],
      where: { expressions: gameDateExpressions }
    }
  },
  {
    name: 'engagement-per-gameplay',
    description: 'Daily gameplay-based engagement seconds per gameplay. The recipe sums compatible raw millisecond time and gameplay counts, converts the summed time to seconds once, then divides by summed gameplays.',
    parameters: gameDateParameters,
    tables: ['dbt_p4d_engagement_per_gameplay'],
    query: dailyQuery('dbt_p4d_engagement_per_gameplay', [
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
      }
    ])
  },
  {
    name: 'netlib-hourly',
    description: 'Hourly Netlib lobby events and connected peer pairs for one game. peers_connected divides the two-sided peer identifier count by 2.',
    parameters: gameDateParameters,
    tables: ['dbt_p4d_netlib_overview'],
    query: {
      from: 'dbt_p4d_netlib_overview',
      select: [
        { field: 'hour' },
        { field: 'lobbies_created', aggregate: 'sum' },
        { field: 'lobbies_joined', aggregate: 'sum' },
        { field: 'lobbies_updated', aggregate: 'sum' },
        {
          alias: 'peers_connected',
          formula: { operator: '/', terms: [{ field: 'peer_connections', aggregate: 'sum' }, { constant: 2 }] }
        }
      ],
      where: {
        expressions: [
          ['team_id', '==', '<TEAM_ID>'],
          ['p4d_game_id', '==', '<GAME_ID>'],
          [{ function: { name: 'toDate', args: [{ field: 'hour' }] } }, '>=', '<FROM_DATE>'],
          [{ function: { name: 'toDate', args: [{ field: 'hour' }] } }, '<=', '<TO_DATE>']
        ]
      },
      group: ['hour'],
      order: [{ field: 'hour', direction: 'asc' }]
    }
  }
]

export function findRecipe (name: string): DataRecipe | undefined {
  return dataRecipes.find(recipe => recipe.name === name)
}

export function recipeNamesForTable (tableName: string): string[] {
  return dataRecipes
    .filter(recipe => recipe.tables.includes(tableName))
    .map(recipe => recipe.name)
}

// Bundled recipes mark their inputs with <UPPERCASE> tokens. Only names a
// recipe actually declares are placeholders, so an ordinary query string that
// happens to contain angle brackets stays a literal value.
export function recipeParameterNames (recipe?: DataRecipe): Set<string> {
  const source = recipe === undefined ? dataRecipes : [recipe]
  return new Set(source.flatMap(entry => Object.keys(entry.parameters)))
}

export function recipePlaceholders (value: unknown): string[] {
  const found = new Set<string>()
  const visit = (node: unknown): void => {
    if (typeof node === 'string') {
      for (const match of node.matchAll(/<([A-Z][A-Z0-9_]*)>/g)) found.add(match[1])
      return
    }
    if (Array.isArray(node)) return node.forEach(visit)
    if (isRecord(node)) Object.values(node).forEach(visit)
  }
  visit(value)
  return [...found].sort()
}

export function fillRecipe (query: Record<string, unknown>, parameters: Record<string, string>): Record<string, unknown> {
  const replace = (value: unknown): unknown => {
    if (typeof value === 'string') {
      return value.replace(/<([A-Z][A-Z0-9_]*)>/g, (placeholder, name: string) => parameters[name] ?? placeholder)
    }
    if (Array.isArray(value)) return value.map(replace)
    if (isRecord(value)) {
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, replace(child)]))
    }
    return value
  }
  return replace(query) as Record<string, unknown>
}
