import type { CommandSpecBuilder } from './types'

export function addRealtimeCommandSpecs ({ apiAction, example, gameOption, group, option, requestOptions }: CommandSpecBuilder): void {
  group('realtime', 'Live metrics.', [
    'Uses the realtime service with the saved developer OAuth bearer credentials.',
    'Each command reads one snapshot. retry_in_seconds is the service polling recommendation; the CLI does not poll automatically.'
  ])
  const output = {
    default_format: 'toon',
    formats: ['toon', 'json'],
    shape: { metrics: 'Object keyed by requested game or version IDs.', retry_in_seconds: 'Optional service polling recommendation in seconds.' }
  }
  const behavior = [
    'Returns only requested IDs and the service polling recommendation. Missing or malformed metrics fail with INVALID_API_RESPONSE.',
    'Uses the realtime service, with no historical date filters or analytics query grammar.'
  ]
  apiAction(['realtime', 'users'], 'Read the rolling Playground user estimate for one game.', { method: 'GET', path: 'https://realtime.poki.com/metrics/playground/:gameID', contacts_api: true }, ['can_read_owned_games'], {
    options: [gameOption, ...requestOptions],
    output: { ...output, metrics: 'Each game ID maps to an estimated distinct-user count over the rolling ten-minute window.' },
    behavior,
    examples: [example('poki realtime users --game GAME_ID', 'Read the Playground user estimate.'), example('poki realtime users --format json', 'Use the project game and JSON output.')]
  })
  apiAction(['realtime', 'errors'], 'Read per-minute error counts for one or more versions.', { method: 'POST', path: 'https://realtime.poki.com/metrics/errors', contacts_api: true }, ['can_read_owned_versions'], {
    options: [option('--version', 'string', 'Version ID; repeat for multiple versions. IDs are deduplicated and sorted before the request.', { required: true, repeatable: true }), ...requestOptions],
    scope: 'explicit --version IDs belonging to the developer or team',
    risk: 'read_only',
    retry_safe: true,
    output: { ...output, metrics: 'Each version ID maps to 1440 per-minute estimated counts of distinct (error key, user) pairs, oldest to newest, including the current incomplete minute. This is neither raw error occurrences nor distinct affected users.' },
    behavior: [...behavior, 'Sends a sorted JSON array of version IDs. Find version IDs with poki versions list.'],
    examples: [example('poki realtime errors --version VERSION_ID', 'Read one version’s error counts.'), example('poki realtime errors --version VERSION_ID_1 --version VERSION_ID_2 --format json', 'Read two versions in one batch.')],
    missing_input: '--version'
  })
  apiAction(['realtime', 'c2p'], 'Read per-minute pageview and converted-pageview counts for one game.', { method: 'POST', path: 'https://realtime.poki.com/metrics/c2p', contacts_api: true }, ['can_read_owned_games'], {
    options: [gameOption, ...requestOptions],
    risk: 'read_only',
    retry_safe: true,
    output: { ...output, metrics: 'Each game ID maps to 1440 minute buckets, oldest to newest. Each bucket is null or {pageviews, gameplays}; gameplays counts pageviews that converted to gameplay, not all gameplay sessions.' },
    behavior: [...behavior, 'Sends a JSON array containing the selected game ID.', 'Null buckets mean no pageviews or unavailable history; they are preserved as null. Recent counts are provisional and the current minute is incomplete. The service supplies no bucket timestamps; the CLI does not invent them.'],
    examples: [example('poki realtime c2p --game GAME_ID', 'Read the game’s pageview conversion counts.'), example('poki realtime c2p --format json', 'Use the project game and JSON output.')]
  })
}
