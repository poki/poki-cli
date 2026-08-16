import { readFileSync } from 'fs'
import { resolve } from 'path'
import type { Argv } from 'yargs'

import { ApiClient } from '../api'
import { gameChangeRequestsDocumentation } from '../docs/resources'
import { inputError } from '../errors'
import { characterCount, containsZeroWidthCharacter, requireChanges } from '../input'
import { jsonApiDocument } from '../jsonapi'
import { listCapabilities } from '../list-capabilities'
import { getProjectGameId } from '../project'
import { registerResourceDiscovery } from './resource-docs'
import {
  gamePath,
  getFromCollection,
  listResources,
  mutationInputFields,
  render,
  renderList,
  renderMutation,
  requireConfirmation,
  resolveMutationInput,
  withDataOption,
  withDefaultGameOption,
  withGameMutationOptions,
  withListOptions,
  withOutputOptions
} from './common'

const createInput = mutationInputFields({
  title: 'title',
  thumbnailFile: 'thumbnail',
  customContentSecurityPolicy: 'custom_content_security_policy',
  cspReason: 'custom_content_security_policy_reasons'
})

function reasons (values: unknown): Record<string, string> {
  const result: Record<string, string> = {}
  for (const value of Array.isArray(values) ? values.map(String) : []) {
    const separator = value.indexOf('=')
    const source = value.slice(0, separator).trim()
    const reason = value.slice(separator + 1).trim()
    if (separator <= 0 || source === '' || reason === '') throw inputError(`Invalid CSP reason '${value}'. Use source=reason.`)
    if (characterCount(reason) > 200) throw inputError(`CSP reason for '${source}' must contain at most 200 characters.`)
    result[source] = reason
  }
  return result
}

function pathFor (game: unknown, request?: unknown): string {
  return gamePath(game, 'change_requests', ...(request === undefined ? [] : [request]))
}

interface ThumbnailInput {
  value: string
  preview: Record<string, unknown>
}

function thumbnailFromFile (path: string): ThumbnailInput {
  const absolutePath = resolve(path)
  try {
    const contents = readFileSync(absolutePath)
    const value = contents.toString('base64')
    return {
      value,
      preview: {
        encoding: 'base64',
        source_file: absolutePath,
        source_bytes: contents.byteLength,
        encoded_characters: value.length,
        value_omitted: true
      }
    }
  } catch (error) {
    throw inputError(`Could not read thumbnail file '${absolutePath}'.`, {
      path: absolutePath,
      cause: error instanceof Error ? error.message : String(error)
    })
  }
}

export function registerGameChangeRequestCommands (yargs: Argv, api: ApiClient): Argv {
  const projectGameId = getProjectGameId()

  return yargs.command('game-change-requests', 'List, inspect, create, and cancel developer game change requests', requests => registerResourceDiscovery(requests, gameChangeRequestsDocumentation)
    .command('list', 'List change requests for one game', list => withDefaultGameOption(withListOptions(list, listCapabilities.gameChangeRequests, 'game-change-requests'), projectGameId, 'Game whose requests to list'), async argv => {
      renderList(await listResources(api, pathFor(argv.game), argv, listCapabilities.gameChangeRequests), argv, 'game-change-requests')
    })
    .command('get <request-id>', 'Get one game change request by filtering the game collection', get => withDefaultGameOption(withOutputOptions(get), projectGameId, 'Game that owns the request')
      .positional('request-id', { describe: 'Game change request ID', type: 'string', demandOption: true }), async argv => {
      render(await getFromCollection(api, pathFor(argv.game), argv, listCapabilities.gameChangeRequests, 'id', { type: 'game_change_requests', id: String(argv.requestId) }, {
        label: 'game change request',
        hint: 'Run `poki game-change-requests list` to see visible request IDs.'
      }), argv)
    })
    .command('create', 'Request a title, thumbnail, or custom Content Security Policy change', create => withGameMutationOptions(withDataOption(create, 'JSON or TOON request fields; thumbnail must already be base64'), projectGameId, 'Game to change')
      .option('title', { describe: 'Requested public title, 3 through 128 characters', type: 'string' })
      .option('thumbnail-file', { describe: 'Image file encoded to the API thumbnail field as base64', type: 'string' })
      .option('custom-content-security-policy', { describe: 'Requested CSP string; use an empty string to remove the custom CSP', type: 'string' })
      .option('csp-reason', { describe: 'CSP source and reason in source=reason form; repeatable; each reason is at most 200 characters', type: 'array', string: true }), async argv => {
      // Read inside the flag branch: --data and --thumbnail-file are mutually
      // exclusive, so an unreadable file must never pre-empt that rejection.
      let thumbnail: ThumbnailInput | undefined
      const data = await resolveMutationInput(argv, createInput, () => {
        thumbnail = argv.thumbnailFile === undefined ? undefined : thumbnailFromFile(String(argv.thumbnailFile))
        return {
          ...(argv.title === undefined ? {} : { title: argv.title }),
          ...(thumbnail === undefined ? {} : { thumbnail: thumbnail.value }),
          ...(argv.customContentSecurityPolicy === undefined ? {} : { custom_content_security_policy: argv.customContentSecurityPolicy }),
          ...(argv.cspReason === undefined ? {} : { custom_content_security_policy_reasons: reasons(argv.cspReason) })
        }
      })
      requireChanges(data)
      if (data.title !== undefined && (typeof data.title !== 'string' || characterCount(data.title.trim()) < 3 || characterCount(data.title) > 128)) throw inputError('title must contain 3 through 128 characters.')
      if (typeof data.title === 'string' && containsZeroWidthCharacter(data.title)) throw inputError('title must not contain zero-width characters.')
      if (data.thumbnail !== undefined && (typeof data.thumbnail !== 'string' || data.thumbnail === '')) throw inputError('thumbnail must be a non-empty base64 string.')
      if (data.custom_content_security_policy !== undefined && typeof data.custom_content_security_policy !== 'string') throw inputError('custom_content_security_policy must be a string.')
      if (data.custom_content_security_policy_reasons !== undefined) {
        const suppliedReasons = data.custom_content_security_policy_reasons
        if (suppliedReasons === null || typeof suppliedReasons !== 'object' || Array.isArray(suppliedReasons) || Object.entries(suppliedReasons).some(([source, reason]) => source.trim() === '' || typeof reason !== 'string' || reason.trim() === '' || characterCount(reason) > 200)) {
          throw inputError('custom_content_security_policy_reasons must map non-empty sources to strings of at most 200 characters.')
        }
      }
      if (data.title === undefined && data.thumbnail === undefined && data.custom_content_security_policy === undefined) {
        throw inputError('At least title, thumbnail, or custom_content_security_policy is required.')
      }
      const path = pathFor(argv.game)
      const body = jsonApiDocument('game_change_requests', data)
      const previewBody = data.thumbnail === undefined
        ? body
        : jsonApiDocument('game_change_requests', {
          ...data,
          thumbnail: thumbnail?.preview ?? {
            encoding: 'base64',
            encoded_characters: data.thumbnail.length,
            value_omitted: true
          }
        })
      await renderMutation(api, argv, { method: 'POST', path, body, previewBody, expected: { type: 'game_change_requests' }, behavior: { sideEffects: ['May create an approval request or apply eligible game changes immediately.'] } })
    })
    .command('cancel <request-id>', 'Cancel your own pending game change request', cancel => withGameMutationOptions(cancel, projectGameId, 'Game that owns the request', { destructive: true })
      .positional('request-id', { describe: 'Pending request ID created by the current user', type: 'string', demandOption: true }), async argv => {
      requireConfirmation(argv, 'Cancelling a game change request')
      const path = pathFor(argv.game, argv.requestId)
      const body = jsonApiDocument('game_change_requests', { status: 'cancelled' }, String(argv.requestId))
      await renderMutation(api, argv, { method: 'PATCH', path, body, expected: { type: 'game_change_requests', id: String(argv.requestId) }, behavior: { destructive: true, sideEffects: ['Permanently cancels the pending request.'] } })
    })
    .demandCommand(1, 'Choose game-change-requests list, get, create, or cancel.'), () => {})
}
