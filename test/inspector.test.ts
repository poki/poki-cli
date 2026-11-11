import assert from 'node:assert/strict'
import { mkdirSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import test from 'node:test'

import { CliError } from '../src/errors'
import { helpDocument } from '../src/docs/commands'
import { INSPECTOR_API_URL, InspectorClient } from '../src/inspector'
import { authEnvironment, listen, parseToon, runCli, runProductCli, temporaryDirectory } from './helpers'

const id = 'aii8s01g60o30c1g60o0'
const inspectorUrl = `https://inspector.poki.dev/?game=upload-${id}`
const buildResponse = { id, url: `https://inspector-uploads.poki-user-content.com/builds/${id}/index.html`, size: 128 }

void test('inspector uploads the default or configured build without game scope or credentials and cleans up its ZIP', async t => {
  let requests = 0
  const endpoint = await listen(t, createServer((req, res) => {
    requests++
    assert.equal(req.method, 'POST')
    assert.equal(req.url, '/v0/builds')
    assert.equal(req.headers.authorization, undefined)
    assert.equal(req.headers.cookie, undefined)
    assert.equal(req.headers.accept, 'application/json')
    assert.match(req.headers['content-type'] ?? '', /^multipart\/form-data; boundary=/)
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('latin1')
      assert.match(body, /name="file"; filename="build.zip"/)
      assert.match(body, /Content-Type: application\/zip/)
      assert.ok(body.includes('PK\u0003\u0004'))
      assert.ok(body.includes('index.html'))
      assert.equal(body.includes('name="disable-transforms"\r\n\r\ntrue\r\n'), requests === 1)
      res.writeHead(201, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ...buildResponse, root_folder: 'game', extra_field: 'raw-only' }))
    })
  }))
  const directory = temporaryDirectory(t, 'inspector-upload')
  mkdirSync(join(directory, 'dist'))
  mkdirSync(join(directory, 'tmp'))
  writeFileSync(join(directory, 'dist', 'index.html'), '<!doctype html><title>Test build</title>')
  const env = { POKI_CLI_TEST_INSPECTOR_URL: endpoint, TMPDIR: join(directory, 'tmp'), TMP: join(directory, 'tmp'), TEMP: join(directory, 'tmp') }
  const result = await runCli(['inspector', 'upload', '--disable-transforms', '--format', 'json'], { cwd: directory, env })
  assert.equal(result.code, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), {
    data: { ...buildResponse, urn: `upload-${id}`, inspector_url: inspectorUrl, root_folder: 'game' }, meta: {}
  })
  assert.deepEqual(readdirSync(join(directory, 'tmp')).filter(name => name.startsWith('poki-cli-inspector-')), [])

  // Reading the project build_dir must not require a game_id. Even stored
  // developer credentials must never be attached to this public upload.
  writeFileSync(join(directory, 'poki.json'), JSON.stringify({ build_dir: 'dist' }))
  const raw = await runCli(['inspector', 'upload', '--raw', '--format', 'json'], {
    cwd: directory, env: { ...authEnvironment(directory), ...env }
  })
  assert.equal(raw.code, 0, raw.stderr)
  assert.deepEqual(JSON.parse(raw.stdout), { ...buildResponse, root_folder: 'game', extra_field: 'raw-only' })

  const toon = await runCli(['inspector', 'upload', '--build-dir', join(directory, 'dist')], { env })
  assert.equal(toon.code, 0, toon.stderr)
  assert.equal(parseToon(toon.stdout).data.inspector_url, inspectorUrl)
  assert.equal(requests, 3)
  assert.deepEqual(readdirSync(join(directory, 'tmp')).filter(name => name.startsWith('poki-cli-inspector-')), [])
})

void test('inspector dry-run stays offline, uses the production Inspector pair, and rejects bad directories', async t => {
  const directory = temporaryDirectory(t, 'inspector-dry-run')
  const build = join(directory, 'build')
  mkdirSync(build)
  writeFileSync(join(build, 'index.html'), '<!doctype html>')
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ poki: { build_dir: 'build' } }))
  const result = await runProductCli(['inspector', 'upload', '--dry-run', '--format', 'json'], {
    cwd: directory, env: { SERVICE_ENV: 'acceptance' }
  })
  assert.equal(result.code, 0, result.stderr)
  const preview = JSON.parse(result.stdout)
  assert.equal(preview.contacted_api, false)
  assert.equal(preview.request.path, `${INSPECTOR_API_URL}/v0/builds`)
  assert.equal(realpathSync(preview.request.body.file.source_directory), realpathSync(build))
  assert.equal(preview.validation.backend_mutation_validated, false)
  assert.deepEqual(readdirSync(directory).sort(), ['build', 'package.json'])
  const empty = join(directory, 'empty')
  mkdirSync(empty)
  for (const path of ['', empty, join(directory, 'missing'), join(build, 'index.html')]) {
    const invalid = await runCli(['inspector', 'upload', '--build-dir', path, '--dry-run', '--format', 'json'])
    assert.equal(invalid.code, 2, invalid.stderr)
    assert.equal(invalid.stdout, '')
    assert.equal(JSON.parse(invalid.stderr).error.code, 'INVALID_INPUT')
  }
  const help = helpDocument(['inspector', 'upload']) as Record<string, any>
  assert.equal(help.scope, 'local build directory; no game ID or authentication required')
  assert.equal(help.input_schema.options.some((value: { name: string }) => value.name === '--game'), false)
  assert.equal(help.permission_codes, undefined)
  assert.ok(help.behavior.some((value: string) => value.includes('never automatically retried')))
})

void test('inspector preserves known uploaded identity on invalid responses, validates raw output, and cleans up failures', async t => {
  const responses: unknown[] = [
    { ...buildResponse, size: 'bad', secret: 'not-public' },
    { ...buildResponse, url: 'javascript:alert(1)', secret: 'not-public' },
    { ...buildResponse, root_folder: {}, secret: 'not-public' },
    { ...buildResponse, id: '../../evil', secret: 'not-public' },
    'invalid JSON'
  ]
  let requests = 0
  const endpoint = await listen(t, createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      const body = responses[requests++]
      res.writeHead(201)
      res.end(typeof body === 'string' ? body : JSON.stringify(body))
    })
  }))
  const directory = temporaryDirectory(t, 'inspector-bad-response')
  const scratch = join(directory, 'tmp')
  const build = join(directory, 'build')
  mkdirSync(scratch)
  mkdirSync(build)
  writeFileSync(join(build, 'index.html'), '<!doctype html>')
  for (let index = 0; index < responses.length; index++) {
    const result = await runCli(['inspector', 'upload', '--build-dir', build, '--raw', '--format', 'json'], {
      env: { POKI_CLI_TEST_INSPECTOR_URL: endpoint, TMPDIR: scratch, TMP: scratch, TEMP: scratch }
    })
    assert.equal(result.code, 5, result.stderr)
    assert.equal(result.stdout, '')
    const error = JSON.parse(result.stderr).error
    assert.equal(error.code, 'INVALID_API_RESPONSE')
    assert.equal(error.retryable, false)
    assert.equal(error.details.created?.inspector_url, index < 3 ? inspectorUrl : undefined)
    assert.equal(result.stderr.includes('not-public'), false)
    assert.deepEqual(readdirSync(scratch).filter(name => name.startsWith('poki-cli-inspector-')), [])
  }
  assert.equal(requests, responses.length)
})

void test('Inspector client never retries or redirects and does not suggest OAuth login on rejection', async () => {
  for (const status of [400, 401, 429, 500, 307]) {
    let requests = 0
    const client = new InspectorClient(undefined, async (url, options) => {
      requests++
      assert.equal(String(url), `${INSPECTOR_API_URL}/v0/builds`)
      assert.equal(options?.redirect, 'manual')
      assert.equal(new Headers(options?.headers).has('Authorization'), false)
      return new Response(JSON.stringify({ errors: [{ title: 'Upload rejected', code: 'invalid-zip-file', status: String(status) }] }), {
        status, headers: { 'x-request-id': 'trace-1', 'retry-after': '10', Location: 'https://elsewhere.invalid/' }
      })
    })
    await assert.rejects(client.upload(new FormData()), (error: unknown) => {
      assert.ok(error instanceof CliError)
      assert.equal(error.status, status)
      assert.equal(error.requestId, 'trace-1')
      assert.equal(error.retryAfter, '10')
      assert.equal(error.retryable, false)
      assert.equal(error.hint?.includes('auth login'), false)
      return true
    })
    assert.equal(requests, 1)
  }
})

void test('Inspector request deadline covers the response body and network errors remain non-retryable', async () => {
  let aborted = false
  const client = new InspectorClient(undefined, async (_url, options) => {
    const signal = options?.signal
    assert.ok(signal !== undefined && signal !== null)
    return new Response(new ReadableStream({
      start (controller) {
        signal.addEventListener('abort', () => {
          aborted = true
          controller.error(new Error('aborted'))
        }, { once: true })
      }
    }), { status: 201 })
  })
  await assert.rejects(client.upload(new FormData(), 10), (error: unknown) => {
    assert.ok(error instanceof CliError)
    assert.equal(error.code, 'API_TIMEOUT')
    assert.equal(error.retryable, false)
    return true
  })
  assert.equal(aborted, true)
  const offline = new InspectorClient(undefined, async () => { throw new TypeError('private network detail') })
  await assert.rejects(offline.upload(new FormData()), (error: unknown) => {
    assert.ok(error instanceof CliError)
    assert.equal(error.code, 'NETWORK_ERROR')
    assert.equal(error.retryable, false)
    assert.equal(error.message.includes('private network detail'), false)
    return true
  })
})
