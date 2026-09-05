import type { Argv } from 'yargs'

import { ApiClient } from '../api'
import { gamesDocumentation } from '../docs/resources'
import { CliError, inputError } from '../errors'
import { characterCount, containsZeroWidthCharacter, requireChanges } from '../input'
import { jsonApiDocument, unreadableFields, unreadableFieldsReport } from '../jsonapi'
import { listCapabilities } from '../list-capabilities'
import { getProjectGameId, projectConfigError } from '../project'
import { gameReadiness } from '../readiness'
import { registerResourceDiscovery } from './resource-docs'
import {
  asStrings,
  ExpectedJsonApiResourceResult,
  gamePath,
  getResource,
  listResources,
  MutationInputFields,
  mutationInputFields,
  render,
  renderList,
  renderMutation,
  requestTimeout,
  requireExpectedJsonApiResource,
  resolveMutationInput,
  withDataOption,
  withListOptions,
  withMutationOptions,
  withOutputOptions,
  withRequestOptions
} from './common'

const createInput = mutationInputFields({
  title: 'title',
  team: 'team_id',
  engine: 'annotations',
  privacyPolicyUrl: 'privacy_policy_url',
  suggestedDescription: 'suggested_description',
  suggestedCategory: 'suggested_categories'
})

// Update accepts the same field flags - a flag still conflicts with --data on
// both commands - but cannot retitle a game or move it between teams.
const updateInput: MutationInputFields = {
  flags: createInput.flags,
  fields: createInput.fields.filter(field => field !== 'title' && field !== 'team_id')
}

function validateAnnotations (value: unknown): void {
  if (value === undefined) return
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw inputError('annotations must be an object containing only engine.')
  const annotations = value as Record<string, unknown>
  const unsupported = Object.keys(annotations).filter(key => key !== 'engine')
  if (unsupported.length > 0) {
    throw inputError('Developer game mutations support only the engine annotation.', {
      unsupported_annotations: unsupported,
      allowed_annotations: ['engine']
    }, 'Use the dedicated game workflow for metadata that is not developer-editable.')
  }
  if (typeof annotations.engine !== 'string' || !/^[a-z0-9-]{2,32}$/.test(annotations.engine)) {
    throw inputError('annotations.engine must contain 2 through 32 lowercase letters, digits, or hyphens.')
  }
}

function validateGameMutationData (data: Record<string, unknown>): void {
  for (const field of ['suggested_description', 'suggested_categories'] as const) {
    if (data[field] !== undefined && typeof data[field] !== 'string') throw inputError(`${field} must be a string.`)
  }
  if (data.title !== undefined) {
    if (typeof data.title !== 'string') throw inputError('title must be a string.')
    const length = characterCount(data.title)
    if (length < 3 || length > 128) throw inputError('title must contain 3 through 128 characters.')
    if (data.title.trim() !== data.title) throw inputError('title must not have leading or trailing whitespace.')
    if (containsZeroWidthCharacter(data.title)) throw inputError('title must not contain zero-width characters.')
  }

  if (data.privacy_policy_url !== undefined) {
    if (typeof data.privacy_policy_url !== 'string') throw inputError('privacy_policy_url must be a string.')
    if (characterCount(data.privacy_policy_url) > 255) throw inputError('privacy_policy_url must contain at most 255 characters.')
    if (data.privacy_policy_url !== '' && !URL.canParse(data.privacy_policy_url)) throw inputError('privacy_policy_url must be an absolute URL.')
  }
}

// Readiness reads absence as negative state, so every field it derives an
// operation status from must be readable. A field normalization dropped, or one
// hidden by a resource collapsed to its identity, is unknown: reporting it as
// `blocked` would state a condition the CLI never observed.
const readinessStateFields: Readonly<Record<string, readonly string[]>> = {
  games: ['team_id', 'team', 'uploader_id', 'uploader', 'tracks', 'versions', 'playtest_requests'],
  users: ['team_id', 'team'],
  game_versions: ['state', 'cached_latest_review_status'],
  playtest_requests: ['version_id', 'version']
}

function readinessStateFieldsFor (type: string): readonly string[] {
  return Object.prototype.hasOwnProperty.call(readinessStateFields, type) ? readinessStateFields[type] : []
}

function unreadableReadinessFields (resource: ExpectedJsonApiResourceResult, type: string): string[] {
  const unreadable = new Set(unreadableFields(resource.raw, resource.normalized, readinessStateFieldsFor(type))
    .map(field => `${type}.${field}`))
  // Expanded versions and requests carry state too, so a dropped field on one
  // of them is just as unusable as a dropped field on the game itself.
  for (const entry of unreadableFieldsReport(resource.document)) {
    for (const field of entry.fields) {
      if (readinessStateFieldsFor(entry.type).includes(field)) unreadable.add(`${entry.type}.${field}`)
    }
  }
  return [...unreadable]
}

function gameFlags (argv: Record<string, unknown>): Record<string, unknown> {
  const data: Record<string, unknown> = {}
  const mappings: Array<[string, string]> = [
    ['title', 'title'],
    ['team', 'team_id'],
    ['privacyPolicyUrl', 'privacy_policy_url'],
    ['suggestedDescription', 'suggested_description']
  ]
  for (const [flag, field] of mappings) {
    if (argv[flag] !== undefined) data[field] = argv[flag]
  }

  if (argv.suggestedCategory !== undefined) {
    data.suggested_categories = asStrings(argv.suggestedCategory)?.join(',')
  }

  if (argv.engine !== undefined) data.annotations = { engine: String(argv.engine) }
  return data
}

async function mutationData (
  argv: Record<string, unknown>,
  input: MutationInputFields
): Promise<Record<string, unknown>> {
  const data = await resolveMutationInput(argv, input, () => gameFlags(argv))
  validateAnnotations(data.annotations)
  validateGameMutationData(data)
  return data
}

function withGameFieldOptions (yargs: Argv, create: boolean): Argv {
  let command = withDataOption(withMutationOptions(withOutputOptions(yargs)), 'JSON or TOON object, @file, or - for stdin; mutually exclusive with field flags')
    .option('engine', {
      describe: 'Developer-editable engine annotation: 2-32 lowercase letters, digits, or hyphens; the server preserves every other annotation',
      type: 'string'
    })
    .option('privacy-policy-url', {
      describe: 'Public privacy-policy URL',
      type: 'string'
    })
    .option('suggested-description', {
      describe: 'Developer-suggested public game description',
      type: 'string'
    })
    .option('suggested-category', {
      describe: 'Suggested Poki content-category name; repeat for multiple names (use audiences list to discover names)',
      type: 'array',
      string: true
    })

  if (create) {
    command = command
      .option('title', {
        describe: 'Game title (required without --data)',
        type: 'string'
      })
      .option('team', {
        describe: 'Owning team ID (required without --data)',
        type: 'string'
      })
  }
  return command
}

export function registerGameCommands (yargs: Argv, api: ApiClient): Argv {
  const projectGameId = getProjectGameId()
  const selectedGame = (argv: Record<string, unknown>): string => {
    const positional = typeof argv.gameId === 'string' && argv.gameId !== '' ? argv.gameId : undefined
    const flag = typeof argv.game === 'string' && argv.game !== '' ? argv.game : undefined
    if (positional !== undefined && flag !== undefined && positional !== flag) {
      throw inputError(`The positional game ID '${positional}' conflicts with --game '${flag}'.`)
    }
    const selected = positional ?? flag ?? projectGameId
    if (selected !== undefined) return selected
    const configError = projectConfigError()
    if (configError !== undefined) throw configError
    throw inputError('A game ID is required. Pass it positionally, pass --game, or configure game_id in poki.json or package.json.', {
      accepted_inputs: ['poki games get GAME_ID', '--game GAME_ID', 'project game_id']
    })
  }
  const gameFlag = (yargs: Argv): Argv => yargs.option('game', {
    describe: 'Game ID; alternative to the positional game-id',
    type: 'string'
  })

  return yargs.command('games', 'List, inspect, assess readiness, create, and update Poki for Developers games', games => registerResourceDiscovery(games, gamesDocumentation)
    .command('list', 'List games for --team or the authenticated user\'s first team', list => withListOptions(list, listCapabilities.games, 'games')
      .option('team', {
        describe: 'Only return games owned by this team ID',
        type: 'string'
      }), async argv => {
      const result = await listResources(api, '/games', argv, listCapabilities.games, [], argv.team === undefined ? [] : [['team_id', argv.team]])
      renderList(result, argv, 'games')
    })
    .command('get [game-id]', 'Get one game; defaults to the configured project game', get => gameFlag(withOutputOptions(get))
      .positional('game-id', { describe: 'Poki for Developers game ID; defaults to project game_id', type: 'string' }), async argv => {
      const gameID = selectedGame(argv)
      render(await getResource(api, gamePath(gameID), argv, { type: 'games', id: gameID }, 'game read'), argv)
    })
    .command('readiness [game-id]', 'Report visible CLI and backend readiness for version activation, Playtests, and Player Fit', readiness => gameFlag(withRequestOptions(readiness))
      .positional('game-id', { describe: 'Poki for Developers game ID; defaults to project game_id', type: 'string' }), async argv => {
      const gameID = selectedGame(argv)
      // Both reads are issued before either is validated: readiness documents
      // that it reads /users/@me, and that must not depend on the game response.
      const gameResponse = await api.request({ path: gamePath(gameID), timeoutMs: requestTimeout(argv) })
      const userResponse = await api.request({ path: '/users/@me', timeoutMs: requestTimeout(argv) })
      const gameResource = requireExpectedJsonApiResource(gameResponse.body, { type: 'games', id: gameID }, 'game readiness read')
      const userResource = requireExpectedJsonApiResource(userResponse.body, { type: 'users' }, 'current-user readiness read')
      const unreadable = [
        ...unreadableReadinessFields(gameResource, 'games'),
        ...unreadableReadinessFields(userResource, 'users')
      ]
      if (unreadable.length > 0) {
        throw new CliError('INVALID_API_RESPONSE', 'Readiness cannot be derived from responses whose documented state fields could not be read.', 5, {
          details: { unreadable_fields: unreadable },
          retryable: false,
          hint: `Inspect the responses with \`poki games get ${gameID} --raw\`. An unreadable field is never reported as a blocking condition.`
        })
      }
      const game = gameResource.normalized
      const user = userResource.normalized
      if (game.id === undefined || user.id === undefined) {
        throw new CliError('INVALID_API_RESPONSE', 'Readiness requires one game resource and one current-user resource.', 5)
      }
      render({
        data: gameReadiness(game, user, userResource.document.meta.permissions),
        meta: {
          scope: 'CLI-required inputs and backend-enforced mutation conditions represented by the current game and permission responses.',
          excluded: 'Dashboard-only eligibility rules are intentionally not applied.',
          point_in_time: true,
          backend_authoritative: true,
          limitations: [
            'The backend rechecks permissions, review history, version ownership, active requests, and version state when a mutation is sent.',
            'Hidden active Playtest requests and complete review history may not be represented in the game response.'
          ],
          requests: [`GET /games/${gameID}`, 'GET /users/@me']
        }
      }, argv)
    })
    .command('create', 'Create a game for a team', create => withGameFieldOptions(create, true), async argv => {
      const data = await mutationData(argv, createInput)
      if (typeof data.title !== 'string' || data.title === '') throw inputError('title is required.')
      if (typeof data.team_id !== 'string' || data.team_id === '') throw inputError('team_id is required.')

      const teamID = data.team_id
      const attributes = { ...data }
      delete attributes.team_id
      const body = jsonApiDocument('games', attributes, undefined, {
        team: { type: 'teams', id: teamID }
      })
      await renderMutation(api, argv, { method: 'POST', path: '/games', body, expected: { type: 'games' }, behavior: { sideEffects: ['Creates a game and may trigger stage, audit, watch, and notification workflows.'] } })
    })
    .command('update [game-id]', 'Update editable game settings; defaults to the configured project game', update => gameFlag(withGameFieldOptions(update, false))
      .positional('game-id', { describe: 'Poki for Developers game ID; defaults to project game_id', type: 'string' }), async argv => {
      const data = await mutationData(argv, updateInput)
      const gameID = selectedGame(argv)
      requireChanges(data)
      const path = gamePath(gameID)
      const body = jsonApiDocument('games', data, gameID)
      await renderMutation(api, argv, { method: 'PATCH', path, body, expected: { type: 'games', id: gameID }, behavior: { sideEffects: ['May create audit or notification activity.'] } })
    })
    .demandCommand(1, 'Choose games list, games get, games readiness, games create, or games update.'), () => {})
}
