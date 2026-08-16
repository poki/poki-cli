import { listCapabilities } from '../../list-capabilities'
import type { CommandSpecBuilder } from './types'

export function addGameCommandSpecs ({ add, apiAction, argument, categoryNameDiscovery, dataOption, example, gameOption, group, listOptionsFor, mutationOptions, option, outputOptions, requestOptions }: CommandSpecBuilder): void {
  group('games', 'List, inspect, assess readiness, create, and update games.')
  const gameFieldOptions = [
    option('--engine', 'string', 'Developer-editable engine annotation: 2-32 lowercase letters, digits, or hyphens; the server preserves every other annotation.'),
    option('--privacy-policy-url', 'string', 'Public privacy-policy URL.'),
    option('--suggested-description', 'string', 'Developer-suggested public game description.'),
    option('--suggested-category', 'string', `Suggested Poki content-category name; repeatable. ${categoryNameDiscovery}`, { repeatable: true })
  ]
  const gameDataShapeBehavior = '--data is a flat attribute object, not a JSON:API envelope, and replaces all field flags. Run poki games fields for the editable field reference.'
  apiAction(['games', 'list'], 'List games for one team with bounded pagination.', { method: 'GET', path: '/games', contacts_api: true }, ['can_read_owned_games'], { options: [option('--team', 'string', 'Select an exact team ID; without it the API uses the authenticated user\'s first team.'), ...listOptionsFor(listCapabilities.games)], scope: '--team or the authenticated user\'s first team', behavior: ['This endpoint supports --team, sorting, and pagination. It does not support the generic --filter option or combine all of a user\'s teams.'], examples: [example('poki games list --team TEAM_ID --page 2 --page-size 50', 'Read one bounded page; meta.has_next reports whether more pages exist.'), example('poki games list --all --fields id,title,public_version --format csv', 'Select three developer-visible fields and export the complete list as CSV; a single page is refused unless it proves it is the last one.')] })
  apiAction(['games', 'get'], 'Get one game; positional ID defaults to project game_id.', { method: 'GET', path: '/games/:gameID', contacts_api: true }, ['can_read_owned_games'], { arguments: [argument('game-id', 'Game ID; defaults to project game_id.', false)], options: [option('--game', 'string', 'Game ID; alternative to the positional game-id.'), ...outputOptions] })
  add({
    path: ['games', 'readiness'],
    summary: 'Report visible CLI and backend readiness for activation, Playtest requests, and Player Fit tests.',
    arguments: [argument('game-id', 'Game ID; defaults to project game_id.', false)],
    options: [option('--game', 'string', 'Game ID; alternative to the positional game-id.'), ...requestOptions],
    permission_codes: ['can_read_self', 'can_read_owned_games'],
    permission_logic: 'can_read_self AND can_read_owned_games for this developer-owned game',
    scope: 'project game_id, positional game ID, or --game',
    behavior: [
      'Uses the current game, current user, and meta.permissions to report candidates and blockers for versions activate, playtest-requests create, and player-fit-tests create.',
      'Only CLI-required inputs and backend-enforced conditions represented by those responses are applied. Dashboard-only eligibility is intentionally excluded.',
      'Each operation status is ready, blocked, or backend_check_required. ready is true, false, or null respectively; backend_checks explains any state the responses cannot prove.',
      'The report is point-in-time and advisory: hidden active requests or complete review history may not be visible, and the backend rechecks every mutation.'
    ],
    side_effects: ['GET /users/@me updates last_seen for a non-impersonated user.'],
    network: { method: 'MULTIPLE', path: ['GET /games/:gameID', 'GET /users/@me'], contacts_api: true },
    risk: 'read_only',
    retry_safe: true,
    output: { default_format: 'toon', formats: ['toon', 'json'], shape: '{data: {type: game_readiness, game, operations}, meta: {scope, excluded, point_in_time, backend_authoritative, limitations, requests}}' },
    examples: [example('poki games readiness --format json', 'Discover backend-compatible version candidates and machine-readable blockers for the project game.')]
  })
  apiAction(['games', 'create'], 'Create a game for a team.', { method: 'POST', path: '/games', contacts_api: true }, ['can_create_owned_games'], { options: [option('--title', 'string', 'Required unless supplied by --data.', { required: 'unless --data' }), option('--team', 'string', 'Required owner team ID unless supplied by --data.', { required: 'unless --data' }), ...gameFieldOptions, dataOption, ...mutationOptions], scope: '--team or team_id in --data; see poki whoami for your team ID', behavior: ['annotations accepts only the developer-editable engine key; the server rejects every other annotation key.', 'A thumbnail cannot be set during game creation; create the game first, then use game-change-requests create.', gameDataShapeBehavior], side_effects: ['Creates a game and triggers normal server workflows.'], missing_input: 'game fields or --data', examples: [example('poki games create --title "My Game" --team TEAM_ID --dry-run', 'Validate and inspect the create request before sending it.')] })
  apiAction(
    ['games', 'update'],
    'Update developer-editable game fields; positional ID defaults to project game_id.',
    { method: 'PATCH', path: '/games/:gameID', contacts_api: true },
    ['can_edit_game_selected_fields'],
    {
      arguments: [argument('game-id', 'Game ID; defaults to project game_id.', false)],
      options: [option('--game', 'string', 'Game ID; alternative to the positional game-id.'), ...gameFieldOptions, dataOption, ...mutationOptions],
      behavior: [
        'Title and thumbnail are not developer-editable here; use game-change-requests create.',
        '--engine sends only annotations.engine in the PATCH; the server preserves every other annotation key.',
        gameDataShapeBehavior
      ],
      side_effects: ['May create audit or notification activity.'],
      missing_input: 'changed fields',
      examples: [
        example('poki games update --privacy-policy-url https://example.com/privacy --dry-run', 'Update one field on the project game and inspect the PATCH.'),
        example('poki games update --data @game-update.toon --dry-run', 'Use the project game and inspect the exact PATCH document.')
      ]
    }
  )
}
