import type { Argv } from 'yargs'

import { ApiClient } from '../api'
import { gameEventFunnelsDocumentation, gameEventsDocumentation } from '../docs/resources'
import { inputError } from '../errors'
import { characterCount, containsZeroWidthCharacter, requireChanges } from '../input'
import { jsonApiDocument } from '../jsonapi'
import { listCapabilities } from '../list-capabilities'
import { getProjectGameId } from '../project'
import { registerResourceDiscovery } from './resource-docs'
import {
  asStrings,
  gamePath,
  listResources,
  MutationInputFields,
  mutationInputFields,
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
  withOutputOptions,
  getResource
} from './common'

const eventFlags = ['category', 'action', 'label', 'description', 'enabled', 'includeInFunnel'] as const
const eventUpdateInput: MutationInputFields = { flags: eventFlags, fields: ['category', 'action', 'label', 'enabled', 'description', 'include_in_funnel'] }
// Create omits the two configuration fields: the server always enables a new
// event and includes it in funnels.
const eventCreateInput: MutationInputFields = { flags: eventFlags, fields: ['category', 'action', 'label', 'description'] }
const funnelInput = mutationInputFields({ title: 'title', event: 'events' })

function scopedPath (game: unknown, resource: 'game_events' | 'game_event_funnels', id?: unknown): string {
  return gamePath(game, resource, ...(id === undefined ? [] : [id]))
}

async function eventData (argv: Record<string, unknown>, create: boolean): Promise<Record<string, unknown>> {
  const data = await resolveMutationInput(argv, create ? eventCreateInput : eventUpdateInput, () => ({
    ...(argv.category === undefined ? {} : { category: argv.category }),
    ...(argv.action === undefined ? {} : { action: argv.action }),
    ...(argv.label === undefined ? {} : { label: argv.label }),
    ...(argv.description === undefined ? {} : { description: argv.description }),
    ...(argv.enabled === undefined ? {} : { enabled: argv.enabled }),
    ...(argv.includeInFunnel === undefined ? {} : { include_in_funnel: argv.includeInFunnel })
  }))
  requireChanges(data)
  for (const field of ['category', 'action'] as const) {
    if (data[field] === undefined && !create) continue
    if (typeof data[field] !== 'string' || data[field].trim() === '') throw inputError(`${field} must be a non-empty string.`)
    if (characterCount(data[field]) > 64 || data[field].includes('/') || data[field].includes('^')) throw inputError(`${field} must contain 1 through 64 characters and must not contain '/' or '^'.`)
    if (containsZeroWidthCharacter(data[field])) throw inputError(`${field} must not contain zero-width characters.`)
  }
  if (data.label !== undefined && (typeof data.label !== 'string' || characterCount(data.label) > 64 || data.label.includes('/') || data.label.includes('^'))) throw inputError("label must contain at most 64 characters and must not contain '/' or '^'.")
  if (typeof data.label === 'string' && containsZeroWidthCharacter(data.label)) throw inputError('label must not contain zero-width characters.')
  if (data.description !== undefined && (typeof data.description !== 'string' || characterCount(data.description) > 10000)) throw inputError('description must contain at most 10000 characters.')
  if (typeof data.description === 'string' && containsZeroWidthCharacter(data.description)) throw inputError('description must not contain zero-width characters.')
  if (create && (typeof data.description !== 'string' || data.description.trim() === '')) throw inputError('description is required.')
  for (const field of ['enabled', 'include_in_funnel'] as const) {
    if (data[field] !== undefined && typeof data[field] !== 'boolean') throw inputError(`${field} must be a boolean.`)
  }
  return data
}

function withEventMutation (yargs: Argv, projectGameId: string | undefined, create: boolean): Argv {
  let command = withGameMutationOptions(withDataOption(yargs, create
    ? 'JSON or TOON category, action, label, and description fields; the server always enables new events and includes them in funnels'
    : 'JSON or TOON event fields inline, from @file, or stdin'), projectGameId, 'Game that owns the event')
    .option('category', { describe: "SDK measure category; 1-64 characters and no '/' or '^'", type: 'string' })
    .option('action', { describe: "SDK measure what value (legacy API field name); 1-64 characters and no '/' or '^'", type: 'string' })
    .option('label', { describe: "SDK measure action value (legacy API field name); 0-64 characters and no '/' or '^'", type: 'string' })
    .option('description', { describe: create ? 'Required human-readable purpose' : 'Human-readable purpose', type: 'string' })
  if (!create) {
    command = command
      .option('enabled', { describe: 'Whether analytics should expose the event', type: 'boolean' })
      .option('include-in-funnel', { describe: 'Whether the event may be selected in funnels', type: 'boolean' })
  }
  return command
}

async function funnelData (argv: Record<string, unknown>, create: boolean): Promise<Record<string, unknown>> {
  const data = await resolveMutationInput(argv, funnelInput, () => ({
    ...(argv.title === undefined ? {} : { title: argv.title }),
    ...(argv.event === undefined ? {} : { events: asStrings(argv.event) })
  }))
  requireChanges(data)
  if ((create || data.title !== undefined) && (typeof data.title !== 'string' || data.title.trim() === '' || characterCount(data.title) > 128)) throw inputError('title must contain 1 through 128 characters.')
  if (typeof data.title === 'string' && containsZeroWidthCharacter(data.title)) throw inputError('title must not contain zero-width characters.')
  if ((create || data.events !== undefined) && (!Array.isArray(data.events) || data.events.length < 1 || data.events.length > 50 || data.events.some(event => typeof event !== 'string' || event.trim() === ''))) {
    throw inputError('events must be an array of 1 through 50 non-empty caret-delimited event keys.')
  }
  if (Array.isArray(data.events) && data.events.some(event => typeof event === 'string' && containsZeroWidthCharacter(event))) throw inputError('events must not contain zero-width characters.')
  return data
}

function withFunnelMutation (yargs: Argv, projectGameId: string | undefined): Argv {
  return withGameMutationOptions(withDataOption(yargs, 'JSON or TOON object containing title and caret-delimited event keys'), projectGameId, 'Game that owns the funnel')
    .option('title', { describe: 'Funnel title, up to 128 characters', type: 'string' })
    .option('event', { describe: "Ordered category^what^action key from funnel analytics; '^' is the separator; repeat in traversal order", type: 'array', string: true })
}

export function registerGameEventCommands (yargs: Argv, api: ApiClient): Argv {
  const projectGameId = getProjectGameId()

  return yargs
    .command('game-events', 'List and manage custom SDK event definitions for one game', events => registerResourceDiscovery(events, gameEventsDocumentation)
      .command('list', 'List custom event definitions', list => withDefaultGameOption(withListOptions(list, listCapabilities.gameEvents, 'game-events'), projectGameId, 'Game whose events to list'), async argv => {
        renderList(await listResources(api, scopedPath(argv.game, 'game_events'), argv, listCapabilities.gameEvents), argv, 'game-events')
      })
      .command('create', 'Create and enable a custom event definition', create => withEventMutation(create, projectGameId, true), async argv => {
        const data = await eventData(argv, true)
        const path = scopedPath(argv.game, 'game_events')
        const body = jsonApiDocument('game_events', data)
        await renderMutation(api, argv, { method: 'POST', path, body, expected: { type: 'game_events' }, behavior: { sideEffects: ['Enables a custom event definition for analytics.'] } })
      })
      .command('update <event-id>', 'Update an existing custom event definition', update => withEventMutation(update, projectGameId, false)
        .positional('event-id', { describe: 'Game event definition ID', type: 'string', demandOption: true }), async argv => {
        const data = await eventData(argv, false)
        const path = scopedPath(argv.game, 'game_events', argv.eventId)
        const body = jsonApiDocument('game_events', data, String(argv.eventId))
        await renderMutation(api, argv, { method: 'PATCH', path, body, expected: { type: 'game_events', id: String(argv.eventId) }, behavior: { sideEffects: ['Changes analytics event configuration.'] } })
      })
      .demandCommand(1, 'Choose game-events list, create, or update.'), () => {})
    .command('game-event-funnels', 'List and manage ordered custom-event funnels for one game', funnels => registerResourceDiscovery(funnels, gameEventFunnelsDocumentation)
      .command('list', 'List funnels', list => withDefaultGameOption(withListOptions(list, listCapabilities.gameEventFunnels, 'game-event-funnels'), projectGameId, 'Game whose funnels to list'), async argv => {
        renderList(await listResources(api, scopedPath(argv.game, 'game_event_funnels'), argv, listCapabilities.gameEventFunnels), argv, 'game-event-funnels')
      })
      .command('get <funnel-id>', 'Get one funnel', get => withDefaultGameOption(withOutputOptions(get), projectGameId, 'Game that owns the funnel')
        .positional('funnel-id', { describe: 'Funnel ID', type: 'string', demandOption: true }), async argv => {
        const funnelID = String(argv.funnelId)
        render(await getResource(api, scopedPath(argv.game, 'game_event_funnels', funnelID), argv, { type: 'game_event_funnels', id: funnelID }, 'game-event funnel read'), argv)
      })
      .command('create', 'Create an ordered custom-event funnel', create => withFunnelMutation(create, projectGameId), async argv => {
        const data = await funnelData(argv, true)
        const path = scopedPath(argv.game, 'game_event_funnels')
        const body = jsonApiDocument('game_event_funnels', data)
        await renderMutation(api, argv, { method: 'POST', path, body, expected: { type: 'game_event_funnels' }, behavior: { sideEffects: ['Creates a reusable analytics funnel.'] } })
      })
      .command('update <funnel-id>', 'Replace funnel title and/or ordered events', update => withFunnelMutation(update, projectGameId)
        .positional('funnel-id', { describe: 'Funnel ID', type: 'string', demandOption: true }), async argv => {
        const data = await funnelData(argv, false)
        const path = scopedPath(argv.game, 'game_event_funnels', argv.funnelId)
        const body = jsonApiDocument('game_event_funnels', data, String(argv.funnelId))
        await renderMutation(api, argv, { method: 'PATCH', path, body, expected: { type: 'game_event_funnels', id: String(argv.funnelId) }, behavior: { sideEffects: ['Replaces the supplied funnel fields.'] } })
      })
      .command('delete <funnel-id>', 'Delete a custom-event funnel', remove => withGameActionOptions(remove, projectGameId, 'Game that owns the funnel', { destructive: true })
        .positional('funnel-id', { describe: 'Funnel ID', type: 'string', demandOption: true }), async argv => {
        requireConfirmation(argv, 'Deleting a game-event funnel')
        const id = String(argv.funnelId)
        await renderMutation(api, argv, { method: 'DELETE', path: scopedPath(argv.game, 'game_event_funnels', id), expected: { type: 'game_event_funnels', id }, behavior: { destructive: true, sideEffects: ['Deletes the funnel from developer workflows.'] }, action: { result: { id, deleted: true } } })
      })
      .demandCommand(1, 'Choose game-event-funnels list, get, create, update, or delete.'), () => {})
}
