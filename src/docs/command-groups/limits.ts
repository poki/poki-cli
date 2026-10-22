import type { CommandSpecBuilder } from './types'

export function addLimitCommandSpecs ({ apiAction, example, group, option, outputOptions }: CommandSpecBuilder): void {
  group('limits', 'Testing limits and usage.')
  apiAction(['limits', 'get'], 'Read testing limits and usage without reserving capacity.', {
    method: 'GET', path: ['/games/:gameID/@quota', '/teams/:teamID/@quota', '/users/@me'], contacts_api: true
  }, [], {
    options: [option('--game', 'string', 'Game ID; defaults to the configured project game unless --team is supplied.', { conflicts: ['--team'] }), option('--team', 'string', 'Team ID; falls back to the authenticated team when there is no project game.', { conflicts: ['--game'] }), ...outputOptions],
    scope: 'Selected game or team; backend ownership and read permissions apply.',
    behavior: [
      'Game reads return player_fit_game_limit/used, player_fit_team_limit/used, playtest_game_limit/used, playtest_team_limit/used, and webfit_limit/active. Team reads omit the game counters.',
      'used includes completed and reserved capacity. Remaining capacity is max(0, limit - used); for Web Fit subtract active from limit. resets_at is the next daily reset.',
      'Daily quotas reset at midnight UTC. Running/completed Player Fit tests and full active playtest recording targets count on the request day; closed playtests retain completed recordings after pending work settles. Web Fit has no timed reset.',
      'Admins and verified teams are exempt from quotas. Historical recordings with unknown request targets are included in the usage estimate.',
      'This is an advisory snapshot calculated from existing tests, requests, and recordings. Create requests recheck usage; simultaneous requests can exceed the allowance. TEST_QUOTA_EXCEEDED means the request was rejected; inspect details and do not automatically retry, split requests, or cancel work to regain quota.'
    ],
    examples: [example('poki limits get --format json', 'Read limits for the project game or current team.'), example('poki limits get --team TEAM_ID --format json', 'Read team-wide usage.')]
  })
}
