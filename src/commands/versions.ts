import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { basename, join, resolve } from 'path'
import type { Argv } from 'yargs'

import { ApiClient } from '../api'
import { sanitizeDeveloperResourceAttribute } from '../developer-surface'
import { versionsDocumentation } from '../docs/resources'
import { CliError, inputError, registerInterruptCleanup, safeErrorCause } from '../errors'
import { characterCount, containsZeroWidthCharacter, requireChanges } from '../input'
import { jsonApiDocument, jsonValueKind, normalizeJsonApiResource, normalizeJsonApiResourceForRecovery, ResourceResult } from '../jsonapi'
import { listCapabilities } from '../list-capabilities'
import { isRecord } from '../json'
import { getProjectGameId, readProjectConfig } from '../project'
import { DEFAULT_DOWNLOAD_TIMEOUT_MS } from '../timeouts'
import { appendUploadFile } from '../uploads'
import { createZip } from '../zipfile'
import { AsyncCreateContract, createThenWait, pollArguments } from './async-create'
import { registerResourceDiscovery } from './resource-docs'
import {
  gamePath,
  getResource,
  listResources,
  mutationPreview,
  MutationInputFields,
  normalizeMutationResponse,
  mutateResource,
  pollUntil,
  PollOutcome,
  readExpectedResource,
  render,
  renderList,
  renderMutation,
  requireExpectedJsonApiResource,
  responseLocation,
  requestTimeout,
  requireConfirmation,
  resolveMutationInput,
  withDataOption,
  withDefaultGameOption,
  withFormatOption,
  withGameMutationOptions,
  withListOptions,
  withMutationOptions,
  withOutputOptions,
  withTimeoutOption,
  withUploadOutputOptions,
  withWaitMeta,
  withWaitOptions,
  writeDownload
} from './common'

const versionFields = ['filename', 'label', 'notes'] as const
const updateInput: MutationInputFields = { flags: versionFields, fields: versionFields }
const downloadTypes = ['source', 'hosted'] as const
// A malformed known attribute deliberately collapses normalized output to
// identity-only. Both the activation preflight and `versions current` must
// therefore read the allocation from the validated raw resource: reporting an
// unreadable game as "no tracks" would state an allocation as fact and let an
// agent roll forward from an allocation that was never observed.
function readGameTrackAllocation (
  current: { raw: Record<string, unknown> },
  description: string
): unknown[] {
  const attributes = current.raw.attributes
  const relationships = current.raw.relationships
  const attributesAreObject = isRecord(attributes)
  if (attributes !== undefined && !attributesAreObject) {
    throw new CliError('INVALID_API_RESPONSE', `The ${description} response contained a malformed attributes member.`, 5, {
      details: { expected_attributes_kind: 'object', received_attributes_kind: jsonValueKind(attributes) },
      retryable: false
    })
  }
  const hasTracks = attributesAreObject && Object.prototype.hasOwnProperty.call(attributes, 'tracks')
  const relationshipsAreObject = isRecord(relationships)
  if (relationships !== undefined && !relationshipsAreObject) {
    throw new CliError('INVALID_API_RESPONSE', `The ${description} response contained a malformed relationships member.`, 5, {
      details: { expected_relationships_kind: 'object', received_relationships_kind: jsonValueKind(relationships) },
      retryable: false
    })
  }
  const hasRelationshipTracks = relationshipsAreObject && Object.prototype.hasOwnProperty.call(relationships, 'tracks')
  if (hasRelationshipTracks) {
    throw new CliError('INVALID_API_RESPONSE', `The ${description} response placed tracks in the wrong JSON:API resource member.`, 5, {
      details: {
        expected_tracks_source: 'attributes',
        received_tracks_source: 'relationships',
        attributes_tracks_member: hasTracks ? 'present' : 'missing'
      },
      retryable: false
    })
  }
  const rawTracks = hasTracks ? attributes.tracks : undefined
  const sanitizedTracks = hasTracks
    ? sanitizeDeveloperResourceAttribute('games', 'tracks', rawTracks)
    : { valid: true, value: [] }
  if (!sanitizedTracks.valid || !Array.isArray(sanitizedTracks.value)) {
    throw new CliError('INVALID_API_RESPONSE', `The ${description} response did not contain a valid tracks array.`, 5, {
      details: {
        expected_tracks_kind: 'array',
        received_attributes_kind: jsonValueKind(attributes),
        tracks_member: hasTracks ? 'present' : 'missing',
        ...(hasTracks ? { received_tracks_kind: jsonValueKind(rawTracks) } : {})
      },
      retryable: false
    })
  }
  return sanitizedTracks.value
}

// Only `versions current` reports the public version. The activation preflight
// deliberately does not read it: widening that preflight would let an unrelated
// malformed attribute mask ACTIVE_VERSION_MULTIPLE_TRACKS.
function readGamePublicVersion (
  current: { raw: Record<string, unknown> },
  description: string
): { value: unknown, present: boolean } {
  const attributes = current.raw.attributes
  const attributesAreObject = isRecord(attributes)
  if (!attributesAreObject || !Object.prototype.hasOwnProperty.call(attributes, 'public_version')) {
    return { value: undefined, present: false }
  }
  const rawPublicVersion = attributes.public_version
  const sanitized = sanitizeDeveloperResourceAttribute('games', 'public_version', rawPublicVersion)
  if (!sanitized.valid) {
    throw new CliError('INVALID_API_RESPONSE', `The ${description} response contained a malformed public_version member.`, 5, {
      details: { received_public_version_kind: jsonValueKind(rawPublicVersion) },
      retryable: false
    })
  }
  return { value: sanitized.value, present: sanitized.value !== undefined }
}

function validateVersionText (data: Record<string, unknown>): void {
  for (const field of versionFields) {
    const value = data[field]
    if (value === undefined) continue
    if (typeof value !== 'string') throw inputError(`${field} must be a string.`)
    if (field !== 'filename' && containsZeroWidthCharacter(value)) throw inputError(`${field} must not contain zero-width characters.`)
  }
  if (typeof data.label === 'string' && characterCount(data.label) > 256) {
    throw inputError('label must contain at most 256 characters.')
  }
}

function withVersionUpdateOptions (yargs: Argv, projectGameId: string | undefined): Argv {
  return withGameMutationOptions(withDataOption(yargs, 'JSON or TOON object, @file, or - for stdin; mutually exclusive with filename, label, and notes'), projectGameId, 'Parent Poki for Developers game ID')
    .option('filename', { describe: 'Uploaded archive filename shown by the API', type: 'string' })
    .option('label', { describe: 'Human-readable version label', type: 'string' })
    .option('notes', { describe: 'Version description or release notes', type: 'string' })
}

function mutationOutcomeIsUncertain (error: unknown): boolean {
  if (!(error instanceof CliError) || error.status === undefined) return true
  // Authenticated mutations never follow a redirect, so a 3xx leaves the PATCH
  // outcome at the redirect target unobserved: as uncertain as a timeout.
  const redirect = error.status >= 300 && error.status < 400
  return redirect || (error.status >= 200 && error.status < 300) || error.status === 408 || error.status === 429 || error.status >= 500
}

function activationRecovery (
  gameID: string,
  previousTracks: unknown[],
  requestedTracks: unknown[]
): Record<string, unknown> {
  const previous = previousTracks.length === 1 && isRecord(previousTracks[0]) ? previousTracks[0] : undefined
  const canRestoreExactly = previous?.track === 'public' && typeof previous.version_id === 'string' && previous.version_id !== '' && previous.weight === 100
  return {
    inspect_current_allocation: {
      required_before_next_mutation: true,
      command: 'poki',
      arguments: ['versions', 'current', '--game', gameID, '--format', 'json'],
      compare_with: {
        previous_tracks: previousTracks,
        requested_tracks: requestedTracks
      }
    },
    restore_previous_allocation: canRestoreExactly
      ? {
          available_via_cli: true,
          condition: 'only_after_inspection_confirms_the_requested_allocation_is_active_and_rollback_is_desired',
          command: 'poki',
          arguments: ['versions', 'activate', String(previous.version_id), '--game', gameID, '--yes', '--format', 'json']
        }
      : {
          available_via_cli: false,
          condition: 'manual_recovery_only_after_current_state_inspection',
          reason: 'versions activate can restore exactly only a previous single public track at weight 100; preserve details.previous_tracks for coordinated recovery.'
        }
  }
}

// Version processing states from the field reference; done and error are the
// only terminal ones.
function versionStateOf (resource: unknown): string {
  const data = isRecord(resource) ? resource.data : undefined
  const state = isRecord(data) ? data.state : undefined
  return typeof state === 'string' ? state : 'unknown'
}

async function waitForVersion (api: ApiClient, versionId: string, argv: Record<string, unknown>): Promise<PollOutcome> {
  return await pollUntil(argv, async timeoutMs => {
    const resource = await getResource(
      api,
      `/versions/${encodeURIComponent(versionId)}`,
      { ...argv, raw: false, timeoutMs },
      { type: 'game_versions', id: versionId },
      'version poll'
    )
    const state = versionStateOf(resource)
    return { resource, state, terminal: state === 'done' || state === 'error', succeeded: state === 'done' }
    // A version poll is an ordinary GET, so it uses the ordinary request
    // timeout even when the upload itself used the multipart one.
  }, `version ${versionId} processing`, requestTimeout(argv) ?? api.timeoutMs)
}

// Version uploads predate the JSON:API resource surface and the deployed API
// still returns the created game version as a plain JSON object. Accept that
// shape while also accepting a future JSON:API document. In both cases the
// normalized result goes through the same reviewed game_versions allowlist.
function normalizeVersionUploadResponse (
  body: unknown,
  status: number,
  path: string,
  onRecoverySnapshot?: (result: ResourceResult) => void
): ResourceResult {
  const plain = isRecord(body) && !Object.prototype.hasOwnProperty.call(body, 'data')
  if (!plain) return normalizeMutationResponse(body, status, 'POST', path, { type: 'game_versions' }, onRecoverySnapshot)

  const attributes = Object.fromEntries(Object.entries(body)
    .filter(([field]) => field !== 'type' && field !== 'id'))
  const document = {
    data: {
      type: body.type ?? 'game_versions',
      ...(Object.prototype.hasOwnProperty.call(body, 'id') ? { id: body.id } : {}),
      attributes
    }
  }
  const normalized = normalizeJsonApiResource(document)
  onRecoverySnapshot?.(normalizeJsonApiResourceForRecovery(document))
  return normalized
}

function uploadedVersionId (
  normalized: ResourceResult,
  status: number,
  path: string,
  expectedGameID: string
): string {
  const resource = isRecord(normalized.data) ? normalized.data : undefined
  const id = resource?.id
  const validID = typeof id === 'string' && id.trim() !== ''
  const validType = resource?.type === 'game_versions'
  const validGame = typeof resource?.game_id === 'string' && resource.game_id === expectedGameID
  if (validID && validType && validGame) return id

  throw new CliError('INVALID_API_RESPONSE', 'The successful upload response did not identify one game version belonging to the requested game.', 5, {
    status,
    details: {
      method: 'POST',
      path,
      expected_resource_type: 'game_versions',
      expected_id_kind: 'non_empty_string',
      expected_game_identity: 'requested_game',
      received_primary_data_kind: jsonValueKind(normalized.data),
      received_resource_type_matches: validType,
      received_id_kind: jsonValueKind(id),
      received_id_usable: validID,
      received_game_identity_matches: validGame
    },
    retryable: false,
    hint: 'The upload may already have committed. Inspect current version state and do not replay the upload blindly.'
  })
}

const uploadWaitContract: AsyncCreateContract = {
  errorCode: 'VERSION_UPLOAD_WAIT_FAILED',
  noun: 'version',
  missingId: {
    message: 'The version upload succeeded, but its response did not reliably identify a version belonging to the requested game.',
    hint: 'Do not upload the build again. Use details.recovery.inspect_created_version to list the game versions and identify the existing upload.'
  },
  pollFailed: {
    message: 'The version was created, but polling its processing state failed.',
    hint: 'Do not upload the build again. Use details.recovery.resume_poll to continue polling the created version.'
  },
  inspect: argv => ({
    action: 'list_existing_versions',
    arguments: [
      'versions', 'list',
      '--game', String(argv.game),
      '--archived', 'all',
      '--sort', '-created_at',
      '--fields', 'id,filename,label,state,created_at',
      '--format', 'json'
    ]
  }),
  resumePoll: (createdId, argv) => ({
    action: 'poll_existing_version',
    arguments: [
      'versions', 'get', createdId, '--wait',
      ...pollArguments(argv),
      '--format', 'json'
    ]
  })
}

export function registerVersionCommands (yargs: Argv, api: ApiClient): Argv {
  const projectGameId = getProjectGameId()
  const project = readProjectConfig()

  return yargs.command('versions', 'Inspect, upload, download, archive, and activate game versions', versions => registerResourceDiscovery(versions, versionsDocumentation)
    .command('list', 'List versions belonging to one game with bounded pagination', list => withDefaultGameOption(withListOptions(list, listCapabilities.versions, 'versions'), projectGameId, 'Parent Poki for Developers game ID')
      .option('archived', {
        describe: 'Select active, archived, or all versions',
        choices: ['active', 'archived', 'all'] as const,
        default: 'active'
      }), async argv => {
      const archiveFilter: Array<[string, string]> = argv.archived === 'active'
        ? [['archived_at', 'null']]
        : argv.archived === 'archived'
          ? [['archived_at', 'not:null']]
          : []
      const result = await listResources(api, gamePath(argv.game, 'versions'), argv, listCapabilities.versions, archiveFilter)
      renderList(result, argv, 'versions')
    })
    .command('get <version-id>', 'Get a version by ID without needing its parent game ID', get => withWaitOptions(withOutputOptions(get), 'Poll until state reaches done; state error exits nonzero with the final resource')
      .positional('version-id', { describe: 'Version ID', type: 'string', demandOption: true }), async argv => {
      if (argv.wait === true) {
        const outcome = await waitForVersion(api, String(argv.versionId), argv)
        render(withWaitMeta(outcome), argv)
        return
      }
      const versionID = String(argv.versionId)
      render(await getResource(api, `/versions/${encodeURIComponent(versionID)}`, argv, { type: 'game_versions', id: versionID }, 'version read'), argv)
    })
    .command('files <version-id>', 'List the uploaded files recorded for a version', files => withDefaultGameOption(withListOptions(files, listCapabilities.versionFiles, 'version-files'), projectGameId, 'Parent game ID')
      .positional('version-id', { describe: 'Version ID', type: 'string', demandOption: true }), async argv => {
      const path = gamePath(argv.game, 'versions', argv.versionId, 'files')
      renderList(await listResources(api, path, argv, listCapabilities.versionFiles), argv, 'version-files')
    })
    .command('update <version-id>', 'Update a version label, filename, or release notes', update => withVersionUpdateOptions(update, projectGameId)
      .positional('version-id', { describe: 'Version ID', type: 'string', demandOption: true }), async argv => {
      const data = await resolveMutationInput(argv, updateInput, () => Object.fromEntries(versionFields.filter(field => argv[field] !== undefined).map(field => [field, argv[field]])))
      requireChanges(data)
      validateVersionText(data)

      const id = String(argv.versionId)
      const body = jsonApiDocument('game_versions', data, id)
      const path = gamePath(argv.game, 'versions', id)
      await renderMutation(api, argv, { method: 'PATCH', path, body, expected: { type: 'game_versions', id }, behavior: { sideEffects: ['Updates version metadata and audit history.'] } })
    })
    .command('upload', 'Zip and upload a build as a new version', upload => withWaitOptions(withDefaultGameOption(withMutationOptions(withUploadOutputOptions(upload)), projectGameId, 'Game that will own the new version'), 'After upload, poll until state reaches done; state error exits nonzero with the final resource')
      .option('build-dir', {
        describe: 'Non-empty existing directory to zip; defaults to build_dir from project config or dist',
        default: project.build_dir ?? 'dist',
        type: 'string'
      })
      .option('label', { describe: 'Human-readable version label', type: 'string' })
      .option('notes', { describe: 'Version notes', type: 'string' })
      .option('disable-image-compression', { describe: 'Disable image compression for this version', type: 'boolean', default: false })
      .option('disable-transforms', { describe: 'Disable upload transforms for this version', type: 'boolean', default: false }), async argv => {
      const requestedBuildDir = String(argv.buildDir)
      if (requestedBuildDir.trim() === '') {
        throw inputError('--build-dir must be a non-empty directory path.', { build_dir: requestedBuildDir })
      }
      const buildDir = resolve(requestedBuildDir)
      if (!existsSync(buildDir)) throw inputError(`Build directory '${buildDir}' does not exist.`, { build_dir: buildDir })
      if (!statSync(buildDir).isDirectory()) throw inputError(`Build directory '${buildDir}' is not a directory.`, { build_dir: buildDir })
      if (readdirSync(buildDir).length === 0) throw inputError(`Build directory '${buildDir}' is empty.`, { build_dir: buildDir })
      validateVersionText({ label: argv.label, notes: argv.notes })
      const path = gamePath(argv.game, 'versions')
      const previewBody = {
        multipart: true,
        file: { source_directory: buildDir, archive_name: 'build.zip' },
        ...(argv.label === undefined ? {} : { label: argv.label }),
        ...(argv.notes === undefined ? {} : { notes: argv.notes }),
        disable_image_compression: argv.disableImageCompression,
        disable_transforms: argv.disableTransforms
      }
      if (mutationPreview('POST', path, previewBody, argv, {
        sideEffects: ['Creates a version and starts asynchronous upload processing.']
      })) return

      const temporaryDirectory = mkdtempSync(join(tmpdir(), 'poki-cli-upload-'))
      // An interrupt never reaches the finally below, which would leak the
      // build archive in the OS temporary directory.
      const removeTemporaryOnInterrupt = registerInterruptCleanup(() => {
        rmSync(temporaryDirectory, { recursive: true, force: true })
      })
      const archivePath = join(temporaryDirectory, 'build.zip')
      try {
        await createZip(archivePath, buildDir)
        const form = new FormData()
        await appendUploadFile(form, 'file', archivePath, 'build.zip', 'application/zip')
        if (argv.label !== undefined) form.append('label', String(argv.label))
        if (argv.notes !== undefined) form.append('notes', String(argv.notes))
        if (argv.disableImageCompression) form.append('disable-image-compression', 'true')
        if (argv.disableTransforms) form.append('disable-transforms', 'true')
        const belongsToGame = (data: unknown, requireType: boolean): Record<string, unknown> | undefined => {
          if (!isRecord(data) || data.game_id !== String(argv.game)) return undefined
          return !requireType || data.type === 'game_versions' ? data : undefined
        }
        await createThenWait({
          contract: uploadWaitContract,
          argv,
          send: async () => await api.request({ method: 'POST', path, rawBody: form, timeoutMs: requestTimeout(argv) }),
          normalize: (response, onRecoverySnapshot) => normalizeVersionUploadResponse(response.body, response.status, path, onRecoverySnapshot),
          createdIdOf: (normalized, response) => uploadedVersionId(normalized, response.status, path, String(argv.game)),
          requireCreatedId: 'always',
          recoveryFromSnapshot: data => belongsToGame(data, true),
          recoveryFromNormalized: data => belongsToGame(data, false),
          poll: async createdId => await waitForVersion(api, createdId, argv)
        })
      } finally {
        removeTemporaryOnInterrupt()
        // Cleanup must never replace an upload result or a no-replay recovery
        // error after the remote mutation may already have committed.
        try {
          rmSync(temporaryDirectory, { recursive: true, force: true })
        } catch {}
      }
    })
    .command('archive <version-id>', 'Archive a version', archive => withGameMutationOptions(archive, projectGameId, 'Parent Poki for Developers game ID')
      .positional('version-id', { describe: 'Version ID', type: 'string', demandOption: true }), async argv => {
      const id = String(argv.versionId)
      await renderMutation(api, argv, { method: 'POST', path: gamePath(argv.game, 'versions', id, '_archive'), expected: { type: 'game_versions', id }, behavior: { sideEffects: ['Hides the version from active lists; reversible via versions unarchive.'] }, action: { result: { type: 'game_versions', id, action: 'archived' }, preferResponse: true } })
    })
    .command('unarchive <version-id>', 'Restore an archived version', unarchive => withGameMutationOptions(unarchive, projectGameId, 'Parent Poki for Developers game ID')
      .positional('version-id', { describe: 'Version ID', type: 'string', demandOption: true }), async argv => {
      const id = String(argv.versionId)
      await renderMutation(api, argv, { method: 'POST', path: gamePath(argv.game, 'versions', id, '_unarchive'), expected: { type: 'game_versions', id }, behavior: { sideEffects: ['Returns the version to active lists.'] }, action: { result: { type: 'game_versions', id, action: 'unarchived' }, preferResponse: true } })
    })
    .command('activate <version-id>', 'Send all public traffic to a backend-eligible version', activate => withGameMutationOptions(activate, projectGameId, 'Parent Poki for Developers game ID', { destructive: true })
      .positional('version-id', { describe: 'Version ID; the backend requires state done and, depending on permissions, an approved review', type: 'string', demandOption: true }), async argv => {
      requireConfirmation(argv, 'Activating a version')
      const gameID = String(argv.game)
      const path = gamePath(gameID)
      const publicTrack = { track: 'public', version_id: String(argv.versionId), weight: 100 }
      if (mutationPreview('PATCH', path, jsonApiDocument('games', { tracks: [publicTrack] }, gameID), argv, {
        destructive: true,
        nonAtomic: true,
        sideEffects: [
          'Replaces the public traffic allocation with this version at 100%.',
          'Execution first fetches the game and rejects activation when multiple tracks currently exist; this offline preview cannot validate that state.'
        ]
      })) return
      const current = await readExpectedResource(api, path, argv, { type: 'games', id: gameID }, 'game preflight')
      const previousTracks = readGameTrackAllocation(current, 'game preflight')
      if (previousTracks.length > 1) {
        throw new CliError('ACTIVE_VERSION_MULTIPLE_TRACKS', 'The active version cannot be changed while multiple tracks exist.', 4, {
          status: 409,
          details: { game_id: gameID, track_count: previousTracks.length, tracks: previousTracks },
          hint: 'Resolve the game\'s traffic experiment or track allocation before activating a version.'
        })
      }
      const body = jsonApiDocument('games', { tracks: [publicTrack] }, gameID)
      let result: unknown
      try {
        result = await mutateResource(api, 'PATCH', path, body, argv, { type: 'games', id: gameID })
      } catch (error) {
        if (!mutationOutcomeIsUncertain(error)) throw error
        const original = error instanceof CliError ? error : undefined
        const requestedTracks = [publicTrack]
        throw new CliError('VERSION_ACTIVATION_OUTCOME_UNKNOWN', 'The activation PATCH may have committed, so the current traffic allocation is unknown.', original?.exitCode ?? 5, {
          status: original?.status,
          retryable: false,
          requestId: original?.requestId,
          retryAfter: original?.retryAfter,
          hint: `Run \`poki versions current --game ${gameID} --format json\` before any retry or rollback. Do not replay the activation blindly.`,
          details: {
            activation_state: 'unknown',
            game_id: gameID,
            requested_version_id: String(argv.versionId),
            previous_tracks: previousTracks,
            requested_tracks: requestedTracks,
            recovery: activationRecovery(gameID, previousTracks, requestedTracks),
            cause: safeErrorCause(error)
          }
        })
      }
      // previous_tracks lets an agent roll back by re-activating the version
      // that held public traffic before this change.
      if (argv.raw !== true && isRecord(result)) {
        const meta = result.meta
        result.meta = { ...(isRecord(meta) ? meta : {}), previous_tracks: previousTracks }
      }
      render(result, argv)
    })
    .command('current', 'Show which version holds public traffic and the full track allocation', current => withDefaultGameOption(withOutputOptions(current), projectGameId, 'Game to inspect'), async argv => {
      const gameID = String(argv.game)
      const response = await api.request({ path: gamePath(gameID), timeoutMs: requestTimeout(argv) })
      if (argv.raw === true) {
        render(response.body, argv)
        return
      }
      const current = requireExpectedJsonApiResource(response.body, { type: 'games', id: gameID }, 'current game read')
      const tracks = readGameTrackAllocation(current, 'current game read')
      const publicVersion = readGamePublicVersion(current, 'current game read')
      render({
        data: {
          game_id: current.raw.id,
          ...(publicVersion.present ? { public_version: publicVersion.value } : {}),
          tracks
        },
        meta: {}
      }, argv)
    })
    .command('download <version-id>', 'Download a source or hosted version archive to disk', download => withDefaultGameOption(withTimeoutOption(withFormatOption(download), DEFAULT_DOWNLOAD_TIMEOUT_MS), projectGameId, 'Parent game ID')
      .positional('version-id', { describe: 'Version ID', type: 'string', demandOption: true })
      .option('type', { describe: 'Archive kind', choices: downloadTypes, default: 'source' })
      .option('output', { describe: 'Destination file path', type: 'string' })
      .option('force', { describe: 'Replace an existing destination after the complete download is ready', type: 'boolean', default: false }), async argv => {
      const requestedOutput = String(argv.output ?? `${String(argv.versionId)}-${String(argv.type)}.zip`)
      // An explicit empty --output would otherwise resolve to the current
      // working directory and waste the whole transfer on a path that can
      // never be published.
      if (requestedOutput.trim() === '') {
        throw inputError('--output must be a non-empty file path.', { output: requestedOutput })
      }
      const destination = resolve(requestedOutput)
      const existing = statSync(destination, { throwIfNoEntry: false })
      if (existing !== undefined && !existing.isFile()) {
        throw inputError(`Destination '${destination}' is not a regular file.`, { output: destination })
      }
      if (existing !== undefined && !argv.force) {
        throw inputError(`Destination '${destination}' already exists. Pass --force to replace it.`, { output: destination })
      }
      const path = gamePath(argv.game, 'download', argv.versionId, argv.type)
      const locationResponse = await api.request({ path, timeoutMs: requestTimeout(argv) })
      const location = api.resolveExternalLocation(responseLocation(locationResponse.body, 'a version download location'))
      // Without an explicit --timeout-ms the signed archive transfer falls back
      // to the download budget, while the small location request above keeps
      // the ordinary one.
      const response = await api.downloadExternal(
        location,
        async body => await writeDownload(destination, body, Boolean(argv.force)),
        requestTimeout(argv)
      )
      render({ data: { version_id: argv.versionId, type: argv.type, path: destination, filename: basename(destination), bytes: response.body }, meta: {} }, argv)
    })
    .demandCommand(1, 'Choose versions list, get, files, update, upload, archive, unarchive, activate, current, or download.'), () => {})
}
