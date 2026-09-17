import assert from 'node:assert/strict'
import { chmodSync, closeSync, existsSync, ftruncateSync, openSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { apiResponseError } from '../src/api'
import { normalizeJsonApi } from '../src/jsonapi'
import { mediaKitAssetTypes, mediaKitTypes } from '../src/media-kit'
import { apiHarness, completion, jsonApi, parseToon, runCli, spawnCli, temporaryDirectory } from './helpers'

function asset (id = 'a', attributes: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'marketing_assets',
    id,
    attributes: {
      game_id: 'g',
      type: 'image_screenshot',
      status: 'ready',
      filename: `${id}.png`,
      size: 3,
      content_type: 'image/png',
      width: 1920,
      height: 1080,
      created_at: '2026-09-17T00:00:00Z',
      internal_secret: 'hidden',
      ...attributes
    }
  }
}

const scoped = (...args: string[]): string[] => ['media-kit', ...args, '--game', 'g', '--format', 'json']
const errorOf = (result: { stderr: string }): Record<string, any> => JSON.parse(result.stderr).error

void test('Media Kit normalization aliases only the backend category and protects resource identity', () => {
  const result = normalizeJsonApi({ data: asset('a', { asset_type: 'spoofed', future: 'hidden' }) })
  assert.deepEqual(result.data, {
    type: 'marketing_assets',
    id: 'a',
    game_id: 'g',
    asset_type: 'image_screenshot',
    status: 'ready',
    filename: 'a.png',
    size: 3,
    content_type: 'image/png',
    width: 1920,
    height: 1080,
    created_at: '2026-09-17T00:00:00Z'
  })
  assert.deepEqual(normalizeJsonApi({ data: { type: 'games', id: 'g', attributes: { type: 'spoofed', title: 'x' } } }).data, { type: 'games', id: 'g' })
  assert.deepEqual(normalizeJsonApi({ data: asset('a', { id: 'spoofed' }) }).data, { type: 'marketing_assets', id: 'a' })
  const unreadable = normalizeJsonApi({ data: asset('a', { type: {} }) })
  assert.deepEqual(unreadable.meta.unreadable_fields, [{ type: 'marketing_assets', id: 'a', fields: ['asset_type'] }])
})

void test('Media Kit discovery is offline and describes seven current types and legacy compatibility', async () => {
  const result = await runCli(['media-kit', 'types'])
  assert.equal(result.code, 0, result.stderr)
  const body = parseToon(result.stdout)
  assert.equal(body.meta.total, 7)
  assert.equal(body.meta.max_files_per_upload, 50)
  assert.equal(mediaKitAssetTypes.length, 15)
  assert.match(JSON.stringify(body.data.find((row: any) => row.type === 'image_background')), /1080x1920/)
  for (const args of [['fields'], ['field', 'asset_type']]) {
    const fields = await runCli(['media-kit', ...args, '--format', 'json'])
    assert.equal(fields.code, 0, fields.stderr)
    assert.match(fields.stdout, /asset_type/)
  }
})

void test('Media Kit list/get expose projections, CSV, raw, legacy assets, and project game defaults', async t => {
  let body: unknown = { data: [asset(), asset('old', { type: 'video_vertical' })], meta: { total: 2 } }
  const { directory, env } = await apiHarness(t, (req, res) => {
    assert.equal(req.url, '/games/g/marketing_assets')
    assert.equal(req.headers.authorization, 'Bearer test-token')
    jsonApi(res, body)
  }, 'media-kit-list')
  writeFileSync(join(directory, 'poki.json'), JSON.stringify({ game_id: 'g' }))
  const summary = await runCli(scoped('list'), { env })
  assert.equal(summary.code, 0, summary.stderr)
  assert.equal(JSON.parse(summary.stdout).data[1].asset_type, 'video_vertical')
  assert.equal(JSON.parse(summary.stdout).data[0].width, undefined)
  const full = await runCli(scoped('list', '--full'), { env })
  assert.equal(JSON.parse(full.stdout).data[0].width, 1920)
  assert.doesNotMatch(full.stdout, /hidden|internal_secret/)
  const selected = await runCli(scoped('list', '--fields', 'asset_type,width'), { env })
  assert.deepEqual(JSON.parse(selected.stdout).data[0], { type: 'marketing_assets', id: 'a', asset_type: 'image_screenshot', width: 1920 })
  const csv = await runCli(['media-kit', 'list', '--game', 'g', '--format', 'csv', '--fields', 'asset_type,width'], { env })
  assert.equal(csv.code, 0, csv.stderr)
  assert.match(csv.stdout, /type,id,asset_type,width/)
  const get = await runCli(scoped('get', 'old'), { env })
  assert.equal(JSON.parse(get.stdout).data.id, 'old')
  for (const args of [['list'], ['get', 'a']]) {
    const raw = await runCli(scoped(...args, '--raw'), { env })
    assert.deepEqual(JSON.parse(raw.stdout), body)
  }
  const missing = await runCli(scoped('get', 'missing'), { env })
  assert.equal(missing.code, 4)
  const project = await runCli(['media-kit', 'list', '--format', 'json'], { env, cwd: directory })
  assert.equal(project.code, 0, project.stderr)
  body = { data: [], meta: { total: 0 } }
  const empty = await runCli(scoped('list'), { env })
  assert.deepEqual(JSON.parse(empty.stdout).data, [])
})

void test('Media Kit rejects unsupported list flags and malformed asset responses', async t => {
  let body: unknown = { data: [] }
  let requests = 0
  const { env } = await apiHarness(t, (_req, res) => { requests++; jsonApi(res, body) }, 'media-kit-invalid')
  for (const args of [['--sort', 'filename'], ['--filter', 'status=ready'], ['--page', '1'], ['--all']]) {
    assert.equal((await runCli(scoped('list', ...args), { env })).code, 2)
  }
  assert.equal(requests, 0)
  for (const value of [{}, { data: null }, { data: [asset(), asset()] }, { data: [asset('a', { game_id: 'other' })] }, { data: [{ ...asset(), type: 'games' }] }]) {
    body = value
    const result = await runCli(scoped('list', '--raw'), { env })
    assert.equal(result.code, 5)
    assert.equal(errorOf(result).code, 'INVALID_API_RESPONSE')
  }
})

void test('Media Kit uploads file-backed repeated multipart fields and preserves response cardinality only for raw', async t => {
  let body: unknown = { data: asset('a', { status: 'uploading' }) }
  let filenames: string[] = []
  const { directory, env } = await apiHarness(t, (req, res) => {
    assert.equal(req.method, 'POST')
    assert.equal(req.url, '/games/g/marketing_assets/image_screenshot')
    assert.match(req.headers['content-type'] ?? '', /^multipart\/form-data; boundary=/)
    let raw = ''
    req.on('data', chunk => { raw += String(chunk) })
    req.on('end', () => {
      filenames = [...raw.matchAll(/name="file"; filename="([^"]+)"/g)].map(match => match[1])
      jsonApi(res, body, 201)
    })
  }, 'media-kit-upload')
  const first = join(directory, 'first.PNG')
  const second = join(directory, 'second.png')
  writeFileSync(first, 'one')
  writeFileSync(second, 'two')
  const args = ['upload', '--type', 'image_screenshot', '--file', first]
  const single = await runCli(scoped(...args), { env })
  assert.equal(single.code, 0, single.stderr)
  assert.equal(JSON.parse(single.stdout).data.length, 1)
  assert.deepEqual(filenames, ['first.PNG'])
  const raw = await runCli(scoped(...args, '--raw'), { env })
  assert.deepEqual(JSON.parse(raw.stdout), body)
  body = { data: [asset('a'), asset('b')], meta: { total: 2, failed: [] } }
  const batch = await runCli(scoped(...args, '--file', second), { env })
  assert.equal(batch.code, 0, batch.stderr)
  assert.deepEqual(filenames, ['first.PNG', 'second.png'])
  assert.equal(JSON.parse(batch.stdout).data.length, 2)
})

void test('Media Kit validates files and types before any API request, including dry runs', async t => {
  const directory = temporaryDirectory(t, 'media-kit-preflight')
  const valid = join(directory, 'valid.png')
  const empty = join(directory, 'empty.png')
  const huge = join(directory, 'huge.png')
  writeFileSync(valid, 'abc')
  writeFileSync(empty, '')
  const descriptor = openSync(huge, 'w')
  ftruncateSync(descriptor, 100 * 1024 * 1024 + 1)
  closeSync(descriptor)
  const args = ['upload', '--type', 'image_screenshot']
  for (const file of ['', directory, empty, huge, join(directory, 'missing.png')]) {
    const result = await runCli(scoped(...args, '--file', file, '--dry-run'))
    assert.equal(result.code, 2, result.stderr)
  }
  const dry = await runCli(scoped(...args, '--file', valid, '--dry-run'))
  assert.equal(dry.code, 0, dry.stderr)
  assert.equal(JSON.parse(dry.stdout).contacted_api, false)
  assert.deepEqual(JSON.parse(dry.stdout).request.body.files, [{ path: valid, filename: 'valid.png', size: 3 }])
  const wrongExtension = await runCli(scoped('upload', '--type', 'video_gameplay', '--file', valid, '--dry-run'))
  assert.equal(wrongExtension.code, 2)
  const legacy = await runCli(scoped('upload', '--type', 'video_vertical', '--file', valid, '--dry-run'))
  assert.equal(legacy.code, 2)
  const tooMany = await runCli(scoped(...args, ...Array.from({ length: 51 }, () => ['--file', valid]).flat(), '--dry-run'))
  assert.equal(tooMany.code, 2)
  assert.equal((await runCli(scoped(...args, '--file', valid, '--wait', '--raw'))).code, 2)
  if (process.platform !== 'win32' && process.getuid?.() !== 0) {
    chmodSync(valid, 0o000)
    t.after(() => { if (existsSync(valid)) chmodSync(valid, 0o600) })
    assert.equal((await runCli(scoped(...args, '--file', valid, '--dry-run'))).code, 2)
  }
  for (const spec of mediaKitTypes) assert.equal(spec.max_bytes, spec.type === 'video_gameplay' ? 1024 ** 3 : 100 * 1024 ** 2)
})

void test('Media Kit partial and all-rejected batches retain safe failure details and never poll or replay', async t => {
  let allRejected = false
  let posts = 0
  const { directory, env } = await apiHarness(t, (req, res) => {
    assert.equal(req.method, 'POST')
    posts++
    req.resume()
    req.on('end', () => jsonApi(res, {
      data: allRejected ? [] : [asset('accepted', { status: 'uploading' })],
      meta: {
        total: allRejected ? 0 : 1,
        secret: 'hidden',
        failed: allRejected
          ? [{ filename: 'a.png', error: 'bad dimensions', private: 'hidden' }, { filename: 'b.png', error: 'invalid image' }]
          : [{ filename: 'b.png', error: 'bad dimensions', private: 'hidden' }]
      }
    }, allRejected ? 400 : 201))
  }, 'media-kit-partial')
  const file = join(directory, 'shot.png')
  writeFileSync(file, 'abc')
  const args = scoped('upload', '--type', 'image_screenshot', '--file', file, '--file', file, '--wait')
  const partial = await runCli(args, { env })
  assert.equal(partial.code, 4, partial.stderr)
  assert.equal(partial.stdout, '')
  const error = errorOf(partial)
  assert.equal(error.code, 'MEDIA_KIT_UPLOAD_PARTIAL_FAILURE')
  assert.deepEqual(error.details.accepted_ids, ['accepted'])
  assert.deepEqual(error.details.failed, [{ filename: 'b.png', error: 'bad dimensions' }])
  assert.equal(error.retryable, false)
  assert.deepEqual(error.details.recovery.resume_poll[0].arguments.slice(0, 3), ['media-kit', 'get', 'accepted'])
  assert.doesNotMatch(partial.stderr, /hidden|private/)
  allRejected = true
  const rejected = await runCli(args, { env })
  assert.equal(rejected.code, 4)
  assert.equal(errorOf(rejected).code, 'MEDIA_KIT_UPLOAD_REJECTED')
  assert.equal(errorOf(rejected).details.failed.length, 2)
  assert.doesNotMatch(rejected.stderr, /hidden|private/)
  assert.equal(posts, 2)
})

void test('HTTP 400 batch failure handling is scoped to this upload endpoint and validates every failure', () => {
  const body = { data: [], meta: { failed: [{ filename: 'a', error: 'invalid', secret: 'hidden' }] } }
  const valid = apiResponseError(400, body, new Headers(), { method: 'POST', path: '/games/g/marketing_assets/image_screenshot' })
  assert.equal(valid.code, 'MEDIA_KIT_UPLOAD_REJECTED')
  for (const request of [{ method: 'GET' as const, path: '/games/g/marketing_assets/image_screenshot' }, { method: 'POST' as const, path: '/games/g/versions' }]) {
    assert.equal(apiResponseError(400, body, new Headers(), request).code, 'HTTP_400')
  }
  for (const failed of [[{ filename: 123, error: 'secret' }], [null], 'bad']) {
    const error = apiResponseError(400, { data: [], meta: { failed } }, new Headers(), { method: 'POST', path: '/games/g/marketing_assets/image_screenshot' })
    assert.equal(error.code, 'HTTP_400')
    assert.doesNotMatch(JSON.stringify(error.details ?? {}), /secret/)
  }
})

void test('Media Kit polling tracks only accepted IDs with one collection read per poll', async t => {
  let polls = 0
  let posts = 0
  const { directory, env } = await apiHarness(t, (req, res) => {
    if (req.method === 'POST') {
      posts++
      req.resume()
      req.on('end', () => jsonApi(res, { data: [asset('a', { status: 'uploading' }), asset('b', { status: 'uploading' })] }, 201))
      return
    }
    polls++
    jsonApi(res, { data: [asset('unrelated', { status: 'error' }), asset('b', { status: polls === 1 ? 'uploading' : 'ready' }), asset('a')] })
  }, 'media-kit-wait')
  const file = join(directory, 'shot.png')
  writeFileSync(file, 'abc')
  const result = await runCli(scoped('upload', '--type', 'image_screenshot', '--file', file, '--file', file, '--wait', '--poll-interval-ms', '1'), { env })
  assert.equal(result.code, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout).data.map((row: any) => row.id), ['a', 'b'])
  assert.equal(JSON.parse(result.stdout).meta.wait.final_state, 'ready')
  assert.equal(polls, 2)
  assert.equal(posts, 1)
  const get = await runCli(scoped('get', 'a', '--wait'), { env })
  assert.equal(get.code, 0, get.stderr)
  assert.equal(JSON.parse(get.stdout).data.id, 'a')
})

void test('Media Kit wait failures preserve accepted IDs and read-only recovery after creation', async t => {
  let mode = 'error'
  const { directory, env } = await apiHarness(t, (req, res) => {
    if (req.method === 'POST') {
      req.resume()
      req.on('end', () => jsonApi(res, { data: asset('a', { status: 'uploading' }) }, 201))
      return
    }
    if (mode === 'denied') { jsonApi(res, { errors: [{ code: 'permission-denied' }] }, 403); return }
    jsonApi(res, { data: mode === 'missing' ? [] : [asset('a', { status: mode, error: 'storage failed' })] })
  }, 'media-kit-wait-failures')
  const file = join(directory, 'shot.png')
  writeFileSync(file, 'abc')
  for (const state of ['error', 'unknown', 'missing', 'denied', 'uploading']) {
    mode = state
    const result = await runCli(scoped('upload', '--type', 'image_screenshot', '--file', file, '--wait', '--poll-interval-ms', '1', '--wait-timeout-ms', '80'), { env })
    assert.notEqual(result.code, 0, result.stdout)
    const error = errorOf(result)
    assert.equal(error.code, 'MEDIA_KIT_UPLOAD_INCOMPLETE')
    assert.deepEqual(error.details.accepted_ids, ['a'])
    assert.equal(error.retryable, false)
    assert.ok(error.details.recovery.resume_poll.length === 1)
    if (state === 'error') {
      assert.equal(error.details.accepted[0].error, 'storage failed')
      assert.equal(error.details.cause.code, 'ASYNC_OPERATION_FAILED')
    }
  }
  mode = 'error'
  assert.equal(errorOf(await runCli(scoped('get', 'a', '--wait'), { env })).code, 'ASYNC_OPERATION_FAILED')
  mode = 'uploading'
  assert.equal(errorOf(await runCli(scoped('get', 'a', '--wait', '--wait-timeout-ms', '60'), { env })).code, 'WAIT_TIMEOUT')
})

void test('Media Kit malformed successful uploads are non-retryable even in raw mode', async t => {
  let body: unknown
  const { directory, env } = await apiHarness(t, (req, res) => {
    req.resume()
    req.on('end', () => jsonApi(res, body, 201))
  }, 'media-kit-bad-upload')
  const file = join(directory, 'shot.png')
  writeFileSync(file, 'abc')
  for (const value of [
    { data: asset('a', { game_id: 'other' }) }, { data: asset('a', { type: 'video_gameplay' }) },
    { data: { ...asset(), id: '' } }, { data: [] }, { data: [asset(), asset()] },
    { data: asset(), meta: { failed: [{ filename: 'a', error: { secret: 'hidden' } }] } }
  ]) {
    body = value
    const result = await runCli(scoped('upload', '--type', 'image_screenshot', '--file', file, '--raw'), { env })
    assert.equal(result.code, 5, result.stderr)
    assert.equal(result.stdout, '')
    assert.equal(errorOf(result).code, 'MEDIA_KIT_UPLOAD_INCOMPLETE')
    assert.equal(errorOf(result).retryable, false)
    assert.ok(errorOf(result).details.recovery.inspect)
    assert.doesNotMatch(result.stderr, /hidden/)
  }
})

void test('Media Kit deletion guards destructive actions and normalizes the deleted asset', async t => {
  let requests = 0
  const { env } = await apiHarness(t, (req, res) => {
    requests++
    assert.equal(req.method, 'DELETE')
    assert.equal(req.url, '/games/g/marketing_assets/old')
    jsonApi(res, { data: asset('old', { type: 'image_landscape_1' }) })
  }, 'media-kit-delete')
  assert.equal((await runCli(scoped('delete', 'old'), { env })).code, 2)
  const dry = await runCli(scoped('delete', 'old', '--dry-run'), { env })
  assert.equal(dry.code, 0, dry.stderr)
  assert.equal(JSON.parse(dry.stdout).destructive, true)
  assert.equal(requests, 0)
  const removed = await runCli(scoped('delete', 'old', '--yes'), { env })
  assert.equal(removed.code, 0, removed.stderr)
  assert.equal(JSON.parse(removed.stdout).data.asset_type, 'image_landscape_1')
  assert.equal(requests, 1)
})

void test('Media Kit URL and file downloads support single, exact legacy type, and all targets without bearer leakage', async t => {
  let location: unknown = '/signed?code=token'
  let transfers = 0
  const paths: string[] = []
  const { directory, env } = await apiHarness(t, (req, res) => {
    paths.push(req.url ?? '')
    if (req.url === '/signed?code=token') {
      transfers++
      assert.equal(req.headers.authorization, undefined)
      res.end('downloaded')
    } else {
      assert.equal(req.headers.authorization, 'Bearer test-token')
      jsonApi(res, { location })
    }
  }, 'media-kit-download')
  for (const args of [['preview-url', 'a'], ['download-url', 'all']]) {
    const result = await runCli(scoped(...args), { env })
    assert.equal(result.code, 0, result.stderr)
    assert.equal(JSON.parse(result.stdout).data.url, `${String(env.POKI_CLI_TEST_API_URL)}/signed?code=token`)
  }
  assert.equal(transfers, 0)
  const output = join(directory, 'kit.zip')
  for (const target of ['a', 'video_vertical', 'all']) {
    const result = await runCli(scoped('download', target, '--output', output, '--force'), { env })
    assert.equal(result.code, 0, result.stderr)
    assert.equal(JSON.parse(result.stdout).data.bytes, 10)
    assert.equal(readFileSync(output, 'utf8'), 'downloaded')
    assert.ok(paths.includes(`/games/g/marketing_assets/${target}/download-url`))
  }
  const before = paths.length
  assert.equal((await runCli(scoped('download', 'all', '--output', output), { env })).code, 2)
  assert.equal((await runCli(scoped('download', 'all', '--output', ''), { env })).code, 2)
  assert.equal(paths.length, before)
  for (const value of ['', {}, 'file:///private/secret']) {
    location = value
    const result = await runCli(scoped('download-url', 'a'), { env })
    assert.equal(result.code, 5, result.stderr)
    assert.equal(errorOf(result).code, 'INVALID_API_RESPONSE')
  }
})

void test('Media Kit API rejections retain normal permission and unavailable-asset errors', async t => {
  let status = 403
  const { env } = await apiHarness(t, (_req, res) => jsonApi(res, { errors: [{ code: status === 403 ? 'permission-denied' : 'conflict', title: 'Asset unavailable' }] }, status), 'media-kit-api-errors')
  assert.equal(errorOf(await runCli(scoped('list'), { env })).code, 'PERMISSION_DENIED')
  status = 409
  const unavailable = await runCli(scoped('download-url', 'a'), { env })
  assert.equal(unavailable.code, 4)
  assert.equal(errorOf(unavailable).code, 'CONFLICT')
})

void test('interrupted Media Kit downloads clean up partial files and preserve the previous destination', async t => {
  let started: (() => void) | undefined
  const streaming = new Promise<void>(resolve => { started = resolve })
  const { directory, env } = await apiHarness(t, (req, res) => {
    if (req.url?.includes('download-url') === true) { jsonApi(res, { location: '/stream' }); return }
    res.write('partial')
    started?.()
  }, 'media-kit-interrupt')
  const output = join(directory, 'kit.zip')
  writeFileSync(output, 'original')
  const child = spawnCli(scoped('download', 'all', '--output', output, '--force'), { env })
  const completed = completion(child)
  await streaming
  // Wait for the local temporary file, not just response headers at the server.
  for (let attempt = 0; attempt < 100 && !readdirSync(directory).some(name => name.startsWith('.poki-download-')); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  child.kill('SIGINT')
  const result = await completed
  assert.equal(result.code, 130, result.stderr)
  assert.equal(readFileSync(output, 'utf8'), 'original')
  assert.equal(readdirSync(directory).some(name => name.startsWith('.poki-download-')), false)
  assert.equal(existsSync(output), true)
})

void test('Media Kit upload transport timeouts and single-file rejections never replay the request', async t => {
  let status = 400
  let posts = 0
  const { directory, env } = await apiHarness(t, (req, res) => {
    posts++
    req.resume()
    req.on('end', () => {
      if (status === 0) return
      jsonApi(res, { errors: [{ title: 'Invalid dimensions', code: 'bad-request' }] }, status)
    })
  }, 'media-kit-upload-transport')
  const file = join(directory, 'shot.png')
  writeFileSync(file, 'abc')
  const args = scoped('upload', '--type', 'image_screenshot', '--file', file)
  const rejected = await runCli(args, { env })
  assert.equal(rejected.code, 4)
  assert.equal(errorOf(rejected).message, 'Invalid dimensions')
  status = 0
  const timeout = await runCli([...args, '--timeout-ms', '100'], { env })
  assert.equal(timeout.code, 5)
  assert.equal(errorOf(timeout).code, 'API_TIMEOUT')
  assert.equal(errorOf(timeout).retryable, false)
  assert.match(errorOf(timeout).hint, /resource state/)
  assert.equal(posts, 2)
})

void test('Media Kit download timeouts and broken response bodies preserve existing files', async t => {
  let broken = false
  const { directory, env } = await apiHarness(t, (req, res) => {
    if (req.url?.includes('download-url') === true) { jsonApi(res, { location: '/stream?code=secret-token' }); return }
    res.writeHead(200, { 'Content-Length': '1000' })
    res.write('partial')
    if (broken) setTimeout(() => res.destroy(), 10)
  }, 'media-kit-download-failure')
  const output = join(directory, 'kit.zip')
  writeFileSync(output, 'original')
  for (const failBody of [false, true]) {
    broken = failBody
    const result = await runCli(scoped('download', 'all', '--output', output, '--force', '--timeout-ms', '150'), { env })
    assert.equal(result.code, 5, result.stderr)
    assert.equal(errorOf(result).code, failBody ? 'NETWORK_ERROR' : 'API_TIMEOUT')
    assert.doesNotMatch(result.stderr, /secret-token/)
    assert.equal(readFileSync(output, 'utf8'), 'original')
    assert.equal(readdirSync(directory).some(name => name.startsWith('.poki-download-')), false)
  }
})

void test('Media Kit owned permissions survive whoami filtering without exposing administrative permissions', async t => {
  const { env } = await apiHarness(t, (_req, res) => jsonApi(res, {
    data: { type: 'users', id: 'u' },
    meta: { permissions: ['can_read_owned_marketing_assets', 'can_edit_owned_marketing_assets', 'can_read_all_marketing_assets', 'can_edit_all_marketing_assets'] }
  }), 'media-kit-permissions')
  const result = await runCli(['whoami', '--format', 'json'], { env })
  assert.equal(result.code, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout).meta.permissions, ['can_read_owned_marketing_assets', 'can_edit_owned_marketing_assets'])
})
