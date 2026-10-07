import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { basename, extname, resolve } from 'node:path'
import type { Argv } from 'yargs'

import { ApiClient } from '../api'
import { mediaKitDocumentation } from '../docs/resources'
import { CliError, inputError, notFound, safeErrorCause } from '../errors'
import { isRecord } from '../json'
import { normalizeJsonApi, ResourceResult } from '../jsonapi'
import { listCapabilities } from '../list-capabilities'
import { maxMediaKitUploadFiles, mediaKitTypes, mediaKitUploadFailures, mediaKitUploadTypes } from '../media-kit'
import { getProjectGameId } from '../project'
import { DEFAULT_DOWNLOAD_TIMEOUT_MS } from '../timeouts'
import { appendUploadFile } from '../uploads'
import {
  gamePath, mutationPreview, pollUntil, render, renderList, renderMutation,
  requestTimeout, requireConfirmation, responseLocation, withDefaultGameOption,
  withFormatOption, withGameMutationOptions, withListOptions, withMutationOptions,
  withOutputOptions, withRequestOptions, withTimeoutOption, withUploadOutputOptions,
  withWaitMeta, withWaitOptions, writeDownload
} from './common'
import { pollArguments } from './async-create'
import { registerResourceDiscovery } from './resource-docs'

const collectionPath = (game: unknown): string => gamePath(game, 'marketing_assets')

function invalidResponse (reason: string): CliError {
  return new CliError('INVALID_API_RESPONSE', 'The Poki API returned an invalid Media Kit response.', 5, {
    details: { reason }, retryable: false
  })
}

function assetsDocument (body: unknown, game: string, uploadType?: string): ResourceResult & { data: Array<Record<string, unknown>> } {
  if (!isRecord(body) || (!Array.isArray(body.data) && !(uploadType !== undefined && isRecord(body.data)))) {
    throw invalidResponse('expected_asset_collection')
  }
  const resources = Array.isArray(body.data) ? body.data : [body.data]
  const ids = new Set<string>()
  for (const resource of resources) {
    if (!isRecord(resource) || resource.type !== 'marketing_assets' || typeof resource.id !== 'string' || resource.id.trim() === '' || ids.has(resource.id)) {
      throw invalidResponse('invalid_or_duplicate_asset_identity')
    }
    ids.add(resource.id)
    const attributes = resource.attributes
    if (!isRecord(attributes) || attributes.game_id !== game || typeof attributes.type !== 'string' || attributes.type.trim() === '' ||
      (uploadType !== undefined && attributes.type !== uploadType)) {
      throw invalidResponse('unexpected_game_or_asset_type')
    }
  }
  const result = normalizeJsonApi({ ...body, data: resources }, undefined, undefined, 'collection')
  const normalized = result.data as Array<Record<string, unknown>>
  if (normalized.some(asset => asset.game_id !== game || typeof asset.asset_type !== 'string')) {
    throw invalidResponse('unreadable_asset_attributes')
  }
  return { ...result, data: normalized }
}

async function readAssets (api: ApiClient, argv: Record<string, unknown>): Promise<{ body: unknown, result: ReturnType<typeof assetsDocument> }> {
  const response = await api.request({ path: collectionPath(argv.game), timeoutMs: requestTimeout(argv) })
  return { body: response.body, result: assetsDocument(response.body, String(argv.game)) }
}

function selectedAssets (result: ReturnType<typeof assetsDocument>, ids: string[]): Array<Record<string, unknown>> {
  return ids.map(id => {
    const asset = result.data.find(asset => asset.id === id)
    if (asset === undefined) throw notFound('Media Kit asset', id, 'Run poki media-kit list to inspect the current assets.')
    return asset
  })
}

async function waitForAssets (api: ApiClient, argv: Record<string, unknown>, ids: string[], singular: boolean, observed?: (assets: Array<Record<string, unknown>>) => void): Promise<unknown> {
  const outcome = await pollUntil(argv, async timeoutMs => {
    const { result } = await readAssets(api, { ...argv, timeoutMs })
    const assets = selectedAssets(result, ids)
    if (assets.some(asset => !['uploading', 'ready', 'error'].includes(String(asset.status)))) {
      throw invalidResponse('invalid_processing_status')
    }
    observed?.(assets)
    const failed = assets.some(asset => asset.status === 'error')
    const ready = assets.every(asset => asset.status === 'ready')
    return {
      resource: { data: singular ? assets[0] : assets, meta: {} },
      state: failed ? 'error' : ready ? 'ready' : 'uploading',
      terminal: failed || ready,
      succeeded: ready
    }
  }, 'Media Kit assets', requestTimeout(argv) ?? api.timeoutMs)
  return withWaitMeta(outcome)
}

function recovery (argv: Record<string, unknown>, ids: string[]): Record<string, unknown> {
  return {
    inspect: { command: 'poki', arguments: ['media-kit', 'list', '--game', String(argv.game), '--full'] },
    resume_poll: ids.map(id => ({ command: 'poki', arguments: ['media-kit', 'get', id, '--game', String(argv.game), '--wait', ...pollArguments(argv)] }))
  }
}

async function upload (api: ApiClient, argv: Record<string, unknown>): Promise<void> {
  const spec = mediaKitTypes.find(spec => spec.type === argv.type)
  if (spec === undefined) throw inputError('Choose a current upload type from poki media-kit types.')
  const paths = argv.file as string[]
  if (paths.length < 1 || paths.length > maxMediaKitUploadFiles) throw inputError('Upload between 1 and 50 files per request.')
  const files = []
  for (const input of paths) {
    if (input.trim() === '') throw inputError('--file must be a non-empty path.')
    const path = resolve(input)
    let info
    try {
      info = await stat(path)
      await access(path, constants.R_OK)
    } catch {
      throw inputError('Upload file must exist and be readable.', { path })
    }
    if (!info.isFile() || info.size === 0) throw inputError('Upload file must be a nonempty regular file.', { path })
    if (info.size > spec.max_bytes) throw inputError('Upload file exceeds the size limit for this type.', { path, max_bytes: spec.max_bytes })
    if (!(spec.extensions as readonly string[]).includes(extname(path).toLowerCase())) {
      throw inputError('Upload file extension is not supported for this type.', { path, extensions: spec.extensions })
    }
    files.push({ path, filename: basename(path), size: info.size })
  }
  const path = gamePath(argv.game, 'marketing_assets', spec.type)
  if (mutationPreview('POST', path, { asset_type: spec.type, files }, argv, {
    sideEffects: ['Creates Media Kit assets and starts asynchronous storage uploads. Accepted files remain created when other files fail.']
  })) return
  const form = new FormData()
  for (const file of files) await appendUploadFile(form, 'file', file.path, file.filename)
  let accepted: Array<Record<string, unknown>> = []
  let committed = false
  let status: number | undefined
  try {
    const response = await api.request({ method: 'POST', path, rawBody: form, timeoutMs: requestTimeout(argv) })
    committed = true
    status = response.status
    const result = assetsDocument(response.body, String(argv.game), spec.type)
    accepted = result.data
    const failed = mediaKitUploadFailures(response.body)
    if (isRecord(response.body) && isRecord(response.body.meta) && 'failed' in response.body.meta && failed === undefined) {
      throw invalidResponse('invalid_upload_failures')
    }
    if (accepted.length === 0 || accepted.length + (failed?.length ?? 0) !== files.length) {
      throw invalidResponse('unexpected_upload_result_count')
    }
    const ids = accepted.map(asset => String(asset.id))
    if (failed !== undefined && failed.length > 0) {
      throw new CliError('MEDIA_KIT_UPLOAD_PARTIAL_FAILURE', 'Some Media Kit files were rejected; accepted files were created.', 4, {
        status,
        retryable: false,
        details: { accepted, accepted_ids: ids, failed, recovery: recovery(argv, ids) },
        hint: 'Inspect accepted assets; correct and upload only the rejected files. Do not replay the whole batch.'
      })
    }
    if (argv.wait === true) {
      render(await waitForAssets(api, argv, ids, false, assets => { accepted = assets }), argv)
    } else {
      // Keep only the reviewed per-file failure shape in normalized metadata.
      render(argv.raw === true ? response.body : { ...result, meta: { ...result.meta, ...(failed === undefined ? {} : { failed }) } }, argv)
    }
  } catch (error) {
    if (error instanceof CliError && error.code === 'MEDIA_KIT_UPLOAD_PARTIAL_FAILURE') throw error
    if (!committed && !(error instanceof CliError && error.status !== undefined && error.status >= 200 && error.status < 300)) throw error
    const ids = accepted.map(asset => String(asset.id))
    throw new CliError('MEDIA_KIT_UPLOAD_INCOMPLETE', 'Media Kit files may already be created, but their upload result could not be confirmed.', error instanceof CliError ? error.exitCode : 5, {
      status: error instanceof CliError ? error.status ?? status : status,
      retryable: false,
      details: { accepted, accepted_ids: ids, recovery: recovery(argv, ids), cause: safeErrorCause(error) },
      hint: 'Inspect the current assets or resume polling the accepted IDs. Do not replay the upload.'
    })
  }
}

async function signedLocation (api: ApiClient, argv: Record<string, unknown>, target: string, kind: 'preview' | 'download'): Promise<string> {
  const response = await api.request({ path: gamePath(argv.game, 'marketing_assets', target, `${kind}-url`), timeoutMs: requestTimeout(argv) })
  return api.resolveExternalLocation(responseLocation(response.body, `a Media Kit ${kind} location`))
}

export function registerMediaKitCommands (yargs: Argv, api: ApiClient): Argv {
  const game = getProjectGameId()
  const scoped = (command: Argv): Argv => withDefaultGameOption(command, game)
  return yargs.command('media-kit', 'Manage Media Kit assets', kit => registerResourceDiscovery(kit, mediaKitDocumentation)
    .command('types', 'Describe current upload types and requirements', withFormatOption, argv => {
      render({
        data: mediaKitTypes,
        meta: {
          total: mediaKitTypes.length,
          max_files_per_upload: maxMediaKitUploadFiles,
          validation: 'The CLI checks files, extensions, and sizes. The backend validates media contents and capacity; requirements describe enforced rules and guidance describes recommendations.',
          bundled_snapshot: true
        }
      }, argv)
    })
    .command('list', 'List Media Kit assets', list => scoped(withListOptions(list, listCapabilities.mediaKit, 'media-kit')), async argv => {
      const { body, result } = await readAssets(api, argv)
      renderList(argv.raw === true ? body : result, argv, 'media-kit')
    })
    .command('get <asset-id>', 'Inspect an asset', get => scoped(withWaitOptions(withOutputOptions(get), 'Wait until the asset is ready or errors'))
      .positional('asset-id', { describe: 'Media Kit asset ID', type: 'string', demandOption: true }), async argv => {
      if (argv.wait === true) {
        render(await waitForAssets(api, argv, [String(argv.assetId)], true), argv)
        return
      }
      const { body, result } = await readAssets(api, argv)
      const asset = selectedAssets(result, [String(argv.assetId)])[0]
      render(argv.raw === true ? body : { data: asset, meta: {} }, argv)
    })
    .command('upload', 'Upload files of one current asset type', command => scoped(withWaitOptions(withMutationOptions(withUploadOutputOptions(command)), 'Wait for all accepted assets to become ready'))
      .option('type', { describe: 'Current upload asset type', type: 'string', choices: mediaKitUploadTypes, demandOption: true })
      .option('file', { describe: 'Local file path; repeat once per file', type: 'array', string: true, nargs: 1, demandOption: true }), async argv => { await upload(api, argv) })
    .command('delete <asset-id>', 'Delete an asset', command => withGameMutationOptions(command, game, 'Game that owns the asset', { destructive: true })
      .positional('asset-id', { describe: 'Media Kit asset ID', type: 'string', demandOption: true }), async argv => {
      requireConfirmation(argv, 'Deleting a Media Kit asset')
      await renderMutation(api, argv, {
        method: 'DELETE',
        path: gamePath(argv.game, 'marketing_assets', argv.assetId),
        expected: { type: 'marketing_assets', id: String(argv.assetId) },
        behavior: { destructive: true, sideEffects: ['Permanently deletes the asset and its stored file.'] }
      })
    })
    .command('preview-url <asset-id>', 'Get a signed preview URL', command => scoped(withRequestOptions(command))
      .positional('asset-id', { describe: 'Media Kit asset ID', type: 'string', demandOption: true }), async argv => {
      render({ data: { game_id: argv.game, asset_id: argv.assetId, url: await signedLocation(api, argv, String(argv.assetId), 'preview') }, meta: {} }, argv)
    })
    .command('download-url <target>', 'Get a signed file or ZIP URL', command => scoped(withRequestOptions(command))
      .positional('target', { describe: 'Asset ID, exact backend asset type, or all', type: 'string', demandOption: true }), async argv => {
      render({ data: { game_id: argv.game, target: argv.target, url: await signedLocation(api, argv, String(argv.target), 'download') }, meta: {} }, argv)
    })
    .command('download <target>', 'Download a file or ZIP', command => scoped(withTimeoutOption(withFormatOption(command), DEFAULT_DOWNLOAD_TIMEOUT_MS))
      .positional('target', { describe: 'Asset ID, exact backend asset type, or all', type: 'string', demandOption: true })
      .option('output', { describe: 'Destination file path', type: 'string', demandOption: true })
      .option('force', { describe: 'Replace an existing destination after transfer completes', type: 'boolean', default: false }), async argv => {
      if (String(argv.output).trim() === '') throw inputError('--output must be a non-empty file path.')
      const destination = resolve(String(argv.output))
      const existing = await stat(destination).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined
        throw inputError('Could not inspect the download destination.', { output: destination })
      })
      if (existing !== undefined && !existing.isFile()) throw inputError('Download destination must be a regular file.', { output: destination })
      if (existing !== undefined && !argv.force) throw inputError('Download destination already exists. Pass --force to replace it.', { output: destination })
      const location = await signedLocation(api, argv, String(argv.target), 'download')
      const response = await api.downloadExternal(location, async body => await writeDownload(destination, body, Boolean(argv.force)), requestTimeout(argv))
      render({ data: { game_id: argv.game, target: argv.target, path: destination, filename: basename(destination), bytes: response.body }, meta: {} }, argv)
    })
    .demandCommand(1, 'Choose a Media Kit action.'), () => {})
}
