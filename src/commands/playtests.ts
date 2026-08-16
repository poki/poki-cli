import type { Argv } from 'yargs'

import { ApiClient } from '../api'
import { playtestsDocumentation } from '../docs/resources'
import { inputError } from '../errors'
import { readStructuredSource, requireAllowedFields, requireChanges } from '../input'
import { isRecord } from '../json'
import { jsonApiDocument } from '../jsonapi'
import { listCapabilities } from '../list-capabilities'
import { getProjectGameId } from '../project'
import { registerResourceDiscovery } from './resource-docs'
import {
  applyAudienceInputDefaults,
  audienceInputFromFlags,
  audienceOrientations,
  deviceCategories,
  validateAudienceInput
} from './audience-input'
import {
  asStrings,
  ensureDataExclusive,
  gamePath,
  getFromCollection,
  listResources,
  mutationInputFields,
  mutationPreview,
  mutateResource,
  readExpectedResource,
  render,
  renderList,
  renderMutation,
  requireConfirmation,
  resolveMutationInput,
  withDataOption,
  withDefaultGameOption,
  withGameActionOptions,
  withGameMutationOptions,
  withListOptions,
  withOutputOptions
} from './common'

// playtest-requests replace edits exactly the fields create accepts, so both
// commands share one declaration rather than keeping a second copy in step.
export const playtestRequestInput = mutationInputFields({
  recordings: 'recordings',
  deviceCategory: 'device_category',
  category: 'categories',
  orientation: 'orientation',
  newUsersOnly: 'new_users_only',
  normalTile: 'normal_tile'
})

export function validatePlaytestRequestData (data: Record<string, unknown>): void {
  if (typeof data.recordings !== 'number' || !Number.isInteger(data.recordings) || data.recordings < 1 || data.recordings > 10) {
    throw inputError('recordings must be an integer from 1 through 10.')
  }
  validateAudienceInput(data)
  for (const field of ['new_users_only', 'normal_tile']) {
    if (data[field] !== undefined && typeof data[field] !== 'boolean') throw inputError(`${field} must be a boolean.`)
  }
}

async function buildPlaytestRequestData (argv: Record<string, unknown>): Promise<Record<string, unknown>> {
  const data = await resolveMutationInput(argv, playtestRequestInput, () => ({
    recordings: argv.recordings ?? 10,
    ...audienceInputFromFlags(argv, { defaults: true }),
    new_users_only: argv.newUsersOnly ?? false,
    normal_tile: argv.normalTile ?? false
  }))
  data.recordings ??= 10
  applyAudienceInputDefaults(data)
  data.new_users_only ??= false
  data.normal_tile ??= false
  validatePlaytestRequestData(data)
  return data
}

export function withPlaytestRequestOptions (
  yargs: Argv,
  projectGameId: string | undefined,
  requireVersion = true,
  behavior: { nonAtomic?: boolean } = {}
): Argv {
  return withGameMutationOptions(withDataOption(yargs, 'JSON or TOON request-settings object, @file, or - for stdin; version remains a flag'), projectGameId, 'Game ID that owns the requested version', behavior)
    .option('version', {
      describe: requireVersion ? 'Version ID to record' : 'Replacement version ID; omit to keep the current version',
      type: 'string',
      demandOption: requireVersion
    })
    .option('recordings', { describe: 'Number of recordings to request (1-10, default 10)', type: 'number' })
    .option('device-category', { describe: 'Device audience', choices: deviceCategories })
    .option('orientation', { describe: 'Required screen orientation', choices: audienceOrientations })
    .option('category', { describe: 'Numeric audience category ID; repeat for multiple categories', type: 'array', string: true })
    .option('new-users-only', { describe: 'Only recruit new users', type: 'boolean' })
    .option('normal-tile', { describe: 'Recruit through the normal game tile; requires a game thumbnail', type: 'boolean' })
}

export async function createPlaytestRequest (
  api: ApiClient,
  argv: Record<string, unknown>
): Promise<unknown> {
  if (typeof argv.game !== 'string' || typeof argv.version !== 'string') {
    throw inputError('--game and --version are required.')
  }
  const data = await buildPlaytestRequestData(argv)
  // The thumbnail check needs a live GET, so --dry-run defers it to execution
  // and stays offline.
  if (data.normal_tile === true && argv.dryRun !== true) {
    const preflight = await readExpectedResource(api, gamePath(argv.game), argv, { type: 'games', id: argv.game }, 'game preflight')
    const game = preflight.normalized as {
      thumbnail?: string
      thumbnail_url?: string
    }
    if ((game.thumbnail_url ?? game.thumbnail ?? '') === '') {
      throw inputError('--normal-tile requires the game to have a thumbnail.')
    }
  }

  const attributes = { ...data, game_id: argv.game, version_id: argv.version }
  const body = jsonApiDocument('playtest_requests', attributes)
  const path = gamePath(argv.game, 'playtest-requests')
  if (mutationPreview('POST', path, body, argv, {
    sideEffects: [
      'Creates a playtest request and may advance the game self-service stage.',
      ...(data.normal_tile === true ? ['Execution first verifies with one GET that the game has a thumbnail (--normal-tile).'] : [])
    ]
  })) return undefined
  return await mutateResource(api, 'POST', path, body, argv, { type: 'playtest_requests' })
}

function recordingPath (game: unknown, recording: unknown, suffix = ''): string {
  return `${gamePath(game, 'playtest-recordings', recording)}${suffix}`
}

function recordingUrls (id: string): Record<'video_url' | 'metadata_json_url', string> {
  const encodedId = encodeURIComponent(id)
  return {
    video_url: `https://storage.googleapis.com/poki-playtest-recordings/${encodedId}.webm`,
    metadata_json_url: `https://storage.googleapis.com/poki-playtest-recordings/${encodedId}.json`
  }
}

function decorateRecordingResource (resource: unknown, raw: boolean): unknown {
  if (!isRecord(resource) || resource.type !== 'playtest_recordings' || typeof resource.id !== 'string' || resource.id.trim() === '') return resource
  const urls = recordingUrls(resource.id)
  if (!raw) return { ...resource, ...urls }

  // Raw Playtest reads deliberately keep the backend JSON:API resource shape
  // while ensuring these essential CLI-derived attributes exist. A malformed
  // attributes container has no preservable JSON:API fields, so replace it.
  return {
    ...resource,
    attributes: {
      ...(isRecord(resource.attributes) ? resource.attributes : {}),
      ...urls
    }
  }
}

function decorateRecordingDocument (document: unknown, raw: boolean): unknown {
  if (!isRecord(document) || !Object.prototype.hasOwnProperty.call(document, 'data')) return document
  const data = Array.isArray(document.data)
    ? document.data.map(resource => decorateRecordingResource(resource, raw))
    : decorateRecordingResource(document.data, raw)
  return { ...document, data }
}

export function registerPlaytestCommands (yargs: Argv, api: ApiClient): Argv {
  const projectGameId = getProjectGameId()

  return yargs.command('playtest-recordings', 'List, inspect, assess, archive, and mark recorded playtests watched', recordings => registerResourceDiscovery(recordings, playtestsDocumentation)
    .command('list', 'List recordings for a game', list => withDefaultGameOption(withListOptions(list, listCapabilities.playtests, 'playtests'), projectGameId, 'Game whose recordings to read')
      .option('version', { describe: 'Only return recordings for this version ID', type: 'string' })
      .option('archived', { describe: 'Select active, archived, or all recordings', choices: ['active', 'archived', 'all'] as const, default: 'active' }), async argv => {
      const extra: Array<[string, string]> = []
      if (argv.version !== undefined) extra.push(['version_id', argv.version])
      if (argv.archived === 'active') extra.push(['archived_at', 'null'])
      if (argv.archived === 'archived') extra.push(['archived_at', 'not:null'])
      const response = await listResources(api, gamePath(argv.game, 'playtest-recordings'), argv, listCapabilities.playtests, extra)
      renderList(decorateRecordingDocument(response, argv.raw === true), argv, 'playtests')
    })
    .command('get <recording-id>', 'Get one recording with stable video and metadata URLs', get => withDefaultGameOption(withOutputOptions(get), projectGameId, 'Game that owns the recording')
      .positional('recording-id', { describe: 'Playtest recording ID', type: 'string', demandOption: true }), async argv => {
      const response = await getFromCollection(api, gamePath(argv.game, 'playtest-recordings'), argv, listCapabilities.playtests, 'playtest_recordings.id', { type: 'playtest_recordings', id: String(argv.recordingId) }, {
        label: 'playtest recording',
        hint: 'Run `poki playtest-recordings list` to see visible recording IDs.'
      })
      render(decorateRecordingDocument(response, argv.raw === true), argv)
    })
    .command('update <recording-id>', 'Replace the editable tag list on a recording', update => withGameMutationOptions(withDataOption(update, 'JSON or TOON object containing only tags, inline, from @file, or stdin'), projectGameId, 'Game that owns the recording')
      .positional('recording-id', { describe: 'Playtest recording ID', type: 'string', demandOption: true })
      .option('tag', { describe: 'Tag name; repeat to set multiple tags', type: 'array', string: true })
      .option('clear-tags', { describe: 'Replace the tag list with an empty list', type: 'boolean', default: false }), async argv => {
      ensureDataExclusive(argv, ['tag'])
      if (argv.clearTags && (argv.data !== undefined || argv.tag !== undefined)) {
        throw inputError('--clear-tags cannot be combined with --tag or --data.')
      }
      if (argv.data === undefined && argv.tag === undefined && !argv.clearTags) {
        throw inputError('Provide --tag (repeatable) to set tags, --clear-tags to remove every tag, or --data.', {
          accepted_inputs: ['--tag NAME', '--clear-tags', '--data @tags.json']
        })
      }
      // yargs parses a valueless --tag (an unset shell variable, or a --tag
      // immediately followed by another flag) as an empty array. Clearing the
      // complete tag list stays an explicit --clear-tags decision.
      if (Array.isArray(argv.tag) && argv.tag.length === 0) {
        throw inputError('--tag requires a tag name; use --clear-tags to remove every tag.', {
          accepted_inputs: ['--tag NAME', '--clear-tags']
        })
      }
      const data = argv.data !== undefined
        ? await readStructuredSource(String(argv.data))
        : { tags: argv.clearTags ? [] : asStrings(argv.tag) ?? [] }
      requireAllowedFields(data, ['tags'])
      requireChanges(data)
      if (!Array.isArray(data.tags) || data.tags.some(tag => typeof tag !== 'string' || tag.trim() === '')) {
        throw inputError('tags must be an array of non-empty strings.')
      }
      const id = String(argv.recordingId)
      const body = jsonApiDocument('playtest_recordings', data, id)
      await renderMutation(api, argv, { method: 'PATCH', path: recordingPath(argv.game, id), body, expected: { type: 'playtest_recordings', id }, behavior: { sideEffects: ['Replaces the recording tag list.'] }, action: { result: { id, tags: data.tags }, preferResponse: true } })
    })
    .command('skip-assessment <recording-id>', 'Clear assessment tags and mark a recording assessment skipped', skip => withGameMutationOptions(skip, projectGameId, 'Game that owns the recording', { destructive: true })
      .positional('recording-id', { describe: 'Playtest recording ID', type: 'string', demandOption: true }), async argv => {
      requireConfirmation(argv, 'Skipping a playtest recording assessment')
      const id = String(argv.recordingId)
      const attributes = { tags: [], skipped_assessment: true }
      const body = jsonApiDocument('playtest_recordings', attributes, id)
      await renderMutation(api, argv, { method: 'PATCH', path: recordingPath(argv.game, id), body, expected: { type: 'playtest_recordings', id }, behavior: { destructive: true, sideEffects: ['Clears assessment tags and permanently records that assessment was skipped.'] }, action: { result: { id, ...attributes }, preferResponse: true } })
    })
    .command('archive <recording-id>', 'Archive a recording', archive => withGameActionOptions(archive, projectGameId, 'Game that owns the recording')
      .positional('recording-id', { describe: 'Playtest recording ID', type: 'string', demandOption: true }), async argv => {
      const id = String(argv.recordingId)
      await renderMutation(api, argv, { method: 'POST', path: recordingPath(argv.game, id, '/@archive'), expected: { type: 'playtest_recordings', id }, behavior: { sideEffects: ['Moves the recording out of active lists.'] }, action: { result: { id, archived: true } } })
    })
    .command('unarchive <recording-id>', 'Restore an archived recording', unarchive => withGameActionOptions(unarchive, projectGameId, 'Game that owns the recording')
      .positional('recording-id', { describe: 'Playtest recording ID', type: 'string', demandOption: true }), async argv => {
      const id = String(argv.recordingId)
      await renderMutation(api, argv, { method: 'POST', path: recordingPath(argv.game, id, '/@unarchive'), expected: { type: 'playtest_recordings', id }, behavior: { sideEffects: ['Returns the recording to active lists.'] }, action: { result: { id, archived: false } } })
    })
    .command('watch <recording-id>', 'Mark a recording watched for the authenticated user', watch => withGameActionOptions(watch, projectGameId, 'Game that owns the recording')
      .positional('recording-id', { describe: 'Playtest recording ID', type: 'string', demandOption: true }), async argv => {
      const id = String(argv.recordingId)
      await renderMutation(api, argv, { method: 'POST', path: recordingPath(argv.game, id, '/@watch'), expected: { type: 'playtest_recordings', id }, behavior: { sideEffects: ['Marks the recording watched for the current user.'] }, action: { result: { id, watched: true } } })
    })
    .demandCommand(1, 'Choose playtest-recordings list, get, update, skip-assessment, archive, unarchive, or watch.'), () => {})
}
