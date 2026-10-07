import type { Argv } from 'yargs'

import { ApiClient } from '../api'
import { playtestRequestsDocumentation } from '../docs/resources'
import { CliError, inputError, notFound, safeErrorCause } from '../errors'
import { requireChanges } from '../input'
import { jsonApiDocument, unreadableFields, unreadableFieldsReport } from '../jsonapi'
import { isRecord } from '../json'
import { writeStructured } from '../output'
import { getProjectGameId } from '../project'
import { audienceInputFromFlags } from './audience-input'
import { registerResourceDiscovery } from './resource-docs'
import {
  gamePath,
  normalizeMutationResponse,
  readExpectedResource,
  render,
  renderList,
  renderMutation,
  requestTimeout,
  requireConfirmation,
  requireExpectedJsonApiResource,
  resolveMutationInput,
  withDefaultGameOption,
  withGameMutationOptions,
  withListViewOptions
} from './common'
import { createPlaytestRequest, playtestRequestInput, validatePlaytestRequestData, withPlaytestRequestOptions } from './playtests'

function editFlags (argv: Record<string, unknown>): Record<string, unknown> {
  const data: Record<string, unknown> = audienceInputFromFlags(argv)
  if (argv.recordings !== undefined) data.recordings = argv.recordings
  if (argv.newUsersOnly !== undefined) data.new_users_only = argv.newUsersOnly
  if (argv.normalTile !== undefined) data.normal_tile = argv.normalTile
  return data
}

function asObjectArray (value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter(isRecord) : []
}

type ReplacementCreationState = 'not_created' | 'unknown'

function replacementCreationState (error: unknown): ReplacementCreationState {
  if (!(error instanceof CliError) || error.status === undefined) return 'unknown'
  return error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429
    ? 'not_created'
    : 'unknown'
}

function replacementRecovery (
  gameID: string,
  versionID: string,
  data: Record<string, unknown>,
  state: ReplacementCreationState
): Record<string, unknown> {
  const inspectArguments = ['playtest-requests', 'list', '--game', gameID, '--format', 'json']
  const createArguments = [
    'playtest-requests', 'create',
    '--game', gameID,
    '--version', versionID,
    '--data', JSON.stringify(data),
    '--format', 'json'
  ]
  return {
    inspect_current_state: {
      required_before_create: state === 'unknown',
      command: 'poki',
      arguments: inspectArguments
    },
    create_replacement: {
      condition: state === 'unknown'
        ? 'only_after_inspection_confirms_no_active_replacement'
        : 'after_correcting_the_rejection_cause',
      command: 'poki',
      arguments: createArguments
    },
    retry_payload: {
      game: gameID,
      version: versionID,
      data
    }
  }
}

function cancellationRecovery (
  gameID: string,
  requestID: string,
  versionID: string,
  data: Record<string, unknown>
): Record<string, unknown> {
  const inspectArguments = ['playtest-requests', 'list', '--game', gameID, '--format', 'json']
  const retryReplaceArguments = [
    'playtest-requests', 'replace', requestID,
    '--game', gameID,
    '--version', versionID,
    '--data', JSON.stringify(data),
    '--yes',
    '--format', 'json'
  ]
  const createArguments = [
    'playtest-requests', 'create',
    '--game', gameID,
    '--version', versionID,
    '--data', JSON.stringify(data),
    '--format', 'json'
  ]
  return {
    inspect_current_state: {
      required_before_next_mutation: true,
      command: 'poki',
      arguments: inspectArguments
    },
    retry_replacement: {
      condition: 'only_if_inspection_confirms_the_original_request_is_still_active',
      command: 'poki',
      arguments: retryReplaceArguments
    },
    create_replacement: {
      condition: 'only_if_inspection_confirms_the_original_request_is_cancelled_and_no_active_replacement_exists',
      command: 'poki',
      arguments: createArguments
    }
  }
}

export function registerPlaytestRequestCommands (yargs: Argv, api: ApiClient): Argv {
  const projectGameId = getProjectGameId()

  return yargs.command('playtest-requests', 'List, cancel, or replace active playtest requests', requests => registerResourceDiscovery(requests, playtestRequestsDocumentation)
    .command('list', 'List role-visible requests for a game', list => withDefaultGameOption(withListViewOptions(list, 'playtest-requests'), projectGameId, 'Read active requests for this game'), async argv => {
      const response = await api.request({ path: gamePath(argv.game), timeoutMs: requestTimeout(argv) })
      if (argv.raw === true) {
        render(response.body, argv)
        return
      }
      const gameID = String(argv.game)
      const game = requireExpectedJsonApiResource(response.body, { type: 'games', id: gameID }, 'playtest-request list game read')
      // An empty list is a factual claim about the backend. Normalization drops
      // a member it cannot represent, so only a member the response never sent
      // may be reported as "no active requests".
      const unreadable = unreadableFields(game.raw, game.normalized, ['playtest_requests'])
      if (unreadable.length > 0) {
        throw new CliError('INVALID_API_RESPONSE', 'The playtest-request list game read did not contain a readable playtest_requests member.', 5, {
          details: { unreadable_fields: unreadable },
          retryable: false,
          hint: `Inspect the game response with \`poki games get ${gameID} --raw\`. An unreadable member is never reported as an empty list.`
        })
      }
      const data = (game.normalized as { playtest_requests?: unknown[] }).playtest_requests ?? []
      const degraded = unreadableFieldsReport(game.document)
      renderList({
        data,
        meta: { total: data.length, ...(degraded.length === 0 ? {} : { unreadable_fields: degraded }) }
      }, argv, 'playtest-requests')
    })
    .command('create', 'Create a playtest request for a game version', create => withPlaytestRequestOptions(create, projectGameId), async argv => {
      const result = await createPlaytestRequest(api, argv)
      if (argv.dryRun !== true) render(result, argv)
    })
    .command('cancel <request-id>', 'Irreversibly cancel an active playtest request', cancel => withGameMutationOptions(cancel, projectGameId, 'Game ID that owns the request', { destructive: true })
      .positional('request-id', { describe: 'Playtest request ID', type: 'string', demandOption: true }), async argv => {
      requireConfirmation(argv, 'Cancelling a playtest request')
      const id = String(argv.requestId)
      await renderMutation(api, argv, { method: 'DELETE', path: gamePath(argv.game, 'playtest-requests', id), expected: { type: 'playtest_requests', id }, behavior: { destructive: true, sideEffects: ['Cancels outstanding work; the backend exposes no restore operation.'] }, action: { result: { id, cancelled: true } } })
    })
    .command('replace <request-id>', 'Cancel an active request and create a replacement; this operation is not atomic', edit => withPlaytestRequestOptions(edit, projectGameId, false, { nonAtomic: true })
      .positional('request-id', { describe: 'Active playtest request ID to replace', type: 'string', demandOption: true }), async argv => {
      const overrides = await resolveMutationInput(argv, playtestRequestInput, () => editFlags(argv))
      if (argv.version === undefined) requireChanges(overrides)

      requireConfirmation(argv, 'Replacing a playtest request')
      const gameID = String(argv.game)
      const preflight = await readExpectedResource(api, gamePath(gameID), argv, { type: 'games', id: gameID }, 'game preflight')
      const game = preflight.normalized as {
        thumbnail?: string
        thumbnail_url?: string
        playtest_requests?: unknown[]
        versions?: unknown[]
      }
      const activeRequests = asObjectArray(game.playtest_requests)
      const current = activeRequests.find(request => String(request.id) === argv.requestId)
      if (current === undefined) throw notFound('active playtest request', argv.requestId, 'Run `poki playtest-requests list` to see active request IDs.')

      const versionID = argv.version === undefined ? String(current.version_id ?? '') : String(argv.version)
      if (versionID === '') throw inputError('The existing request has no version ID; pass --version explicitly.')
      const versions = asObjectArray(game.versions)
      if (!versions.some(version => String(version.id) === versionID)) {
        throw inputError(`Version ${versionID} does not belong to game ${gameID}.`)
      }
      if (activeRequests.some(request => {
        return String(request.id) !== argv.requestId && String(request.version_id) === versionID
      })) {
        throw inputError(`Version ${versionID} already has another active playtest request.`)
      }

      const replacement: Record<string, unknown> = {
        // recordings counts the not-yet-started recordings and pending the ones
        // in progress, so their sum is what the original request still owes.
        // Delivered recordings appear in neither field and are not recreated.
        recordings: Number(current.recordings ?? 0) + Number(current.pending ?? 0),
        device_category: current.device_category ?? 'any',
        categories: current.categories ?? '',
        orientation: current.orientation ?? 'both',
        new_users_only: current.new_users_only ?? false,
        normal_tile: current.normal_tile ?? false,
        ...overrides
      }
      validatePlaytestRequestData(replacement)
      if (replacement.normal_tile === true && (game.thumbnail_url ?? game.thumbnail ?? '') === '') {
        throw inputError('normal_tile requires the game to have a thumbnail.')
      }

      const createAttributes = {
        ...replacement,
        game_id: argv.game,
        version_id: versionID
      }
      const deletePath = gamePath(gameID, 'playtest-requests', argv.requestId)
      const createPath = gamePath(gameID, 'playtest-requests')
      if (argv.dryRun === true) {
        render({
          dry_run: true,
          contacted_api: true,
          validation: {
            scope: 'local_input_and_current_resource_state',
            local_input_validated: true,
            backend_mutation_validated: false,
            mutation_permissions_validated: false,
            resource_state_validated: true
          },
          executable: 'unknown',
          risk: 'non_atomic',
          destructive: true,
          non_atomic: true,
          requests: [
            { method: 'DELETE', path: deletePath },
            { method: 'POST', path: createPath, body: jsonApiDocument('playtest_requests', createAttributes) }
          ],
          side_effects: ['The DELETE commits before the POST. A failed POST leaves the original request cancelled.']
        }, argv)
        return
      }
      try {
        const cancellation = await api.request({
          method: 'DELETE',
          path: deletePath,
          timeoutMs: requestTimeout(argv)
        })
        // Although the DELETE normally returns an empty body, validate any
        // body it does return before starting the non-atomic POST. A malformed
        // 2xx cannot prove whether cancellation committed.
        normalizeMutationResponse(cancellation.body, cancellation.status, 'DELETE', deletePath, { type: 'playtest_requests', id: String(argv.requestId) })
      } catch (error) {
        const original = error instanceof CliError ? error : undefined
        throw new CliError(
          'PLAYTEST_REQUEST_REPLACEMENT_CANCELLATION_FAILED',
          'The current state of the original request is unknown, so replacement creation was not attempted.',
          original?.exitCode ?? 5,
          {
            status: original?.status,
            retryable: false,
            requestId: original?.requestId,
            retryAfter: original?.retryAfter,
            hint: `Run \`poki playtest-requests list --game ${gameID} --format json\` before any further mutation. Do not replay the DELETE or create a replacement blindly.`,
            details: {
              original_request_id: argv.requestId,
              cancellation_state: 'unknown',
              replacement_creation_state: 'not_attempted',
              resolved_replacement: {
                game_id: gameID,
                version_id: versionID,
                data: replacement
              },
              recovery: cancellationRecovery(gameID, String(argv.requestId), versionID, replacement),
              cause: safeErrorCause(error)
            }
          }
        )
      }

      try {
        const response = await api.request({
          method: 'POST',
          path: createPath,
          body: jsonApiDocument('playtest_requests', createAttributes),
          timeoutMs: requestTimeout(argv)
        })
        const normalizedCreated = normalizeMutationResponse(response.body, response.status, 'POST', createPath, { type: 'playtest_requests' }).data
        if (
          normalizedCreated === null ||
          typeof normalizedCreated !== 'object' ||
          Array.isArray(normalizedCreated) ||
          (normalizedCreated as { type?: unknown }).type !== 'playtest_requests' ||
          typeof (normalizedCreated as { id?: unknown }).id !== 'string'
        ) {
          throw new CliError('INVALID_API_RESPONSE', 'The replacement response did not contain one playtest request resource.', 5, {
            status: response.status,
            retryable: false,
            hint: 'The replacement POST may already have committed. Inspect current request state and do not replay it blindly.'
          })
        }
        if (argv.raw === true) {
          render(response.body, argv)
          return
        }
        writeStructured({
          data: {
            cancelled_request_id: argv.requestId,
            replacement: normalizedCreated,
            atomic: false
          },
          meta: {}
        }, argv.format === 'json' ? 'json' : 'toon')
      } catch (error) {
        const original = error instanceof CliError ? error : undefined
        const creationState = replacementCreationState(error)
        throw new CliError(
          'PLAYTEST_REQUEST_REPLACEMENT_FAILED',
          creationState === 'not_created'
            ? 'The original request was cancelled, and the backend rejected its replacement without creating it.'
            : 'The original request was cancelled, but the outcome of the replacement POST is unknown.',
          original?.exitCode ?? 5,
          {
            status: original?.status,
            retryable: false,
            requestId: original?.requestId,
            retryAfter: original?.retryAfter,
            hint: creationState === 'unknown'
              ? `Run \`poki playtest-requests list --game ${gameID} --format json\` and inspect current request state before any create attempt. Do not retry the POST blindly.`
              : 'Correct the rejection cause, then use details.recovery.create_replacement without repeating the cancellation.',
            details: {
              cancelled_request_id: argv.requestId,
              replacement_creation_state: creationState,
              ...(creationState === 'not_created' ? { replacement_not_created: true } : {}),
              recovery: replacementRecovery(gameID, versionID, replacement, creationState),
              cause: safeErrorCause(error)
            }
          }
        )
      }
    })
    .demandCommand(1, 'Choose playtest-requests list, create, cancel, or replace.'), () => {})
}
