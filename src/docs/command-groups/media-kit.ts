import { listCapabilities } from '../../list-capabilities'
import { mediaKitUploadTypes } from '../../media-kit'
import type { CommandSpecBuilder } from './types'

export function addMediaKitCommandSpecs ({ add, apiAction, argument, downloadRequestOptions, example, formatOption, gameOption, group, listOptionsFor, mutationOptions, option, outputOptions, requestOptions, uploadMutationOptions, waitOptions }: CommandSpecBuilder): void {
  const collection = '/games/:gameID/marketing_assets'
  const target = argument('target', 'Asset ID, exact current or legacy backend asset type, or all. Type and all targets download ZIPs of ready assets only.')
  const assetId = argument('asset-id', 'Media Kit asset ID.')
  const read = 'can_read_owned_marketing_assets' as const
  const edit = 'can_edit_owned_marketing_assets' as const
  group('media-kit', 'Manage Media Kit assets.', [
    'Use types for current upload requirements. Older orientation-specific assets remain readable, downloadable, and deletable.',
    'Processing status is uploading, ready, or error. Upload acceptance does not mean storage processing has finished.',
    'Normalized asset_type is the backend attributes.type category; normalized type remains marketing_assets. Raw output preserves the backend document.'
  ])
  add({ path: ['media-kit', 'types'], summary: 'Describe current upload types, enforced requirements, and frontend recommendations.', options: [formatOption], network: { method: 'none', path: 'bundled Media Kit type catalog', contacts_api: false }, behavior: ['Seven current types are accepted for upload; legacy orientation-specific upload types are excluded.', 'The bundled catalog may lag the backend; server validation is authoritative. The CLI checks readable nonempty files, extensions, sizes, and the 50-file request limit. Media contents and existing capacity are checked by the server.'], output: { shape: '{data: [{type, label, extensions, max_bytes, requirements, guidance}], meta: {total, max_files_per_upload, validation, bundled_snapshot}}' } })
  apiAction(['media-kit', 'list'], 'List all Media Kit assets for a game.', { method: 'GET', path: collection, contacts_api: true }, [read], { options: [gameOption, ...listOptionsFor(listCapabilities.mediaKit)], behavior: ['This collection has no filtering, sorting, or pagination. Older asset types are included.'] })
  apiAction(['media-kit', 'get'], 'Inspect an asset, optionally waiting for completion.', { method: 'GET', path: collection, contacts_api: true }, [read], {
    arguments: [assetId],
    options: [gameOption, ...outputOptions, ...waitOptions('Poll the collection until the selected asset is ready or error.')],
    missing_input: 'an asset ID',
    behavior: ['Resolves the ID from the complete collection; there is no individual-resource endpoint. Raw output returns the untouched collection containing the asset.', 'Polling succeeds at ready, fails at error, and rejects missing assets or invalid statuses. Success includes meta.wait.']
  })
  apiAction(['media-kit', 'upload'], 'Upload one or more files of one current asset type.', { method: 'MULTIPLE', path: [`POST ${collection}/:type`, `GET ${collection} (--wait only)`], contacts_api: true }, [edit, read], {
    options: [gameOption, option('--type', 'enum', 'Current asset type; run poki media-kit types for requirements.', { values: [...mediaKitUploadTypes], required: true }), option('--file', 'path', 'Readable nonempty file; repeat once per file, up to 50.', { repeatable: true, required: true }), ...uploadMutationOptions, ...waitOptions('Poll once per interval for all newly accepted IDs to become ready.')],
    permission_logic: 'Uploading requires can_edit_owned_marketing_assets; polling additionally requires can_read_owned_marketing_assets.',
    missing_input: '--type and --file',
    side_effects: ['Creates assets and starts asynchronous storage uploads. Accepted files remain created when other files fail.'],
    behavior: [
      'Uses repeated multipart file fields and streams file-backed blobs. Dry-run validates local files and describes the request without contacting the API.',
      'Normalized success always returns a collection, including single-file uploads; raw output preserves the original singular or collection response.',
      'Partial acceptance raises MEDIA_KIT_UPLOAD_PARTIAL_FAILURE (exit 4), with details.accepted, accepted_ids, failed [{filename, error}], and recovery commands. It returns immediately even when polling was requested. Do not replay the batch.',
      'All-rejected batches raise MEDIA_KIT_UPLOAD_REJECTED (exit 4) with per-file failures; single-file rejections use standard API errors.',
      'After successful creation, response or polling failures raise MEDIA_KIT_UPLOAD_INCOMPLETE with accepted IDs when available, recovery commands, and a safe cause. This is non-retryable; resume reads rather than uploading again.'
    ],
    examples: [example('poki media-kit upload --type image_screenshot --file ./shot-1.png --file ./shot-2.png --wait', 'Upload screenshots and wait for storage completion.'), example('poki media-kit upload --type video_gameplay --file ./gameplay.mp4 --dry-run', 'Check local file input and preview the upload.')]
  })
  apiAction(['media-kit', 'delete'], 'Permanently delete an asset and its stored file.', { method: 'DELETE', path: `${collection}/:assetID`, contacts_api: true }, [edit], { arguments: [assetId], options: [gameOption, ...mutationOptions], missing_input: 'an asset ID', risk: 'destructive', destructive: true, side_effects: ['Permanently deletes the asset and its stored file.'] })
  for (const kind of ['preview', 'download'] as const) {
    apiAction(['media-kit', `${kind}-url`], `Return an absolute signed ${kind} URL.`, { method: 'GET', path: `${collection}/:${kind === 'preview' ? 'assetID' : 'target'}/${kind}-url`, contacts_api: true }, [read], {
      arguments: [kind === 'preview' ? assetId : target],
      options: [gameOption, ...requestOptions],
      missing_input: kind === 'preview' ? 'an asset ID' : 'a download target',
      behavior: ['Signed URLs expire after 15 minutes. No browser is opened. The server rejects assets that are not ready.', ...(kind === 'download' ? ['Type targets select the exact backend type, not the broader frontend compatibility category.'] : ['Preview rendering depends on the file format; source artwork and font formats may not have a preview.'])],
      output: { shape: kind === 'preview' ? '{data: {game_id, asset_id, url}, meta: {}}' : '{data: {game_id, target, url}, meta: {}}' }
    })
  }
  apiAction(['media-kit', 'download'], 'Stream an asset or ZIP to a local file.', { method: 'MULTIPLE', path: [`GET ${collection}/:target/download-url`, 'GET returned signed location without bearer credentials'], contacts_api: true }, [read], {
    arguments: [target],
    options: [gameOption, option('--output', 'path', 'Required destination file path.', { required: true }), option('--force', 'boolean', 'Replace an existing file only after the complete download is ready.', { default: false }), ...downloadRequestOptions],
    missing_input: 'a download target and --output',
    risk: 'local_write',
    retry_safe: true,
    side_effects: ['Writes a local file; --force replaces an existing file after successful transfer.'],
    behavior: ['Individual IDs download the original file; exact type and all targets download ready assets as a ZIP.', 'Requires an explicit output path. Downloads are streamed, temporary files are cleaned up on failure or interruption, and existing files remain intact until successful replacement.'],
    output: { shape: '{data: {game_id, target, path, filename, bytes}, meta: {}}' },
    examples: [example('poki media-kit download all --output ./media-kit.zip', 'Download all ready assets as a ZIP.')]
  })
}
