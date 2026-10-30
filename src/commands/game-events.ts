import type { Argv } from 'yargs'

import { ApiClient } from '../api'
import { gameEventFunnelsDocumentation, gameEventsDocumentation } from '../docs/resources'
import { inputError } from '../errors'
import { requireChanges } from '../input'
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
const eventUpdateInput: MutationInputFields = { flags: eventFlags, fields: ['enabled', 'description', 'include_in_funnel'] }
// Create omits the two configuration fields: the server always enables a new
// event and includes only the first ten definitions per game in funnels.
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
  // The backend owns event identity normalization and content validation.
  for (const field of ['category', 'action', 'label', 'description']) {
    if ((create && ['category', 'action', 'description'].includes(field)) || data[field] !== undefined) {
      if (typeof data[field] !== 'string') throw inputError(`${field} must be a string.`)
    }
  }
  for (const field of ['enabled', 'include_in_funnel'] as const) {
    if (data[field] !== undefined && typeof data[field] !== 'boolean') throw inputError(`${field} must be a boolean.`)
  }
  return data
}

function withEventMutation (yargs: Argv, projectGameId: string | undefined, create: boolean): Argv {
  let command = withGameMutationOptions(withDataOption(yargs, create
    ? 'JSON or TOON backend fields category, action, label, and description; they represent frontend Category, What, and Action respectively, and the server always enables new events and includes only the first ten definitions per game in funnels by default'
    : 'JSON or TOON description, enabled, and include_in_funnel fields inline, from @file, or stdin'), projectGameId, 'Game that owns the event')
    .option('description', { describe: `${create ? 'Required measurement description' : 'Measurement description'}; document frequency, window, eligibility, units/buckets, denominator, and exclusions; shared across versions`, type: 'string' })
  if (create) {
    command = command
      .option('category', { describe: "Frontend Category; backend field category; 1-64 UTF-8 bytes after numeric normalization and no '/' or '^'", type: 'string' })
      .option('action', { describe: "Frontend What; legacy backend field action; 1-64 UTF-8 bytes after numeric normalization and no '/' or '^'", type: 'string' })
      .option('label', { describe: "Frontend Action; legacy backend field label; 0-64 UTF-8 bytes after numeric normalization and no '/' or '^'", type: 'string' })
  } else {
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
  if ((create || data.title !== undefined) && typeof data.title !== 'string') throw inputError('title must be a string.')
  if ((create || data.events !== undefined) && (!Array.isArray(data.events) || data.events.some(event => typeof event !== 'string'))) {
    throw inputError('events must be an array of caret-delimited event key strings.')
  }
  return data
}

function withFunnelMutation (yargs: Argv, projectGameId: string | undefined): Argv {
  return withGameMutationOptions(withDataOption(yargs, 'JSON or TOON object containing title and caret-delimited event keys'), projectGameId, 'Game that owns the funnel')
    .option('title', { describe: 'Funnel title, up to 128 UTF-8 bytes', type: 'string' })
    .option('event', { describe: "Ordered frontend Category^What^Action key from funnel analytics, sourced from backend category^action^label; '^' is the separator; repeat in traversal order", type: 'array', string: true })
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
