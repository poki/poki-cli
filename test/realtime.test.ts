import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { ApiClient } from '../src/api'
import { commandSpec, helpDocument } from '../src/docs/commands'
import { CliError } from '../src/errors'
import { serviceEnvironment } from '../src/service-environment'
import { CLI_USER_AGENT } from '../src/version'
import { authEnvironment, jsonApi, listen, parseToon, requestBody, runCli, temporaryDirectory } from './helpers'

void test('realtime users uses the project game and realtime origin with bearer authentication', async t => {
  const directory = temporaryDirectory(t, 'realtime-users')
  writeFileSync(join(directory, 'poki.json'), JSON.stringify({ game_id: 'project-game' }))
  const realtimeUrl = await listen(t, createServer((req, res) => {
    assert.equal(req.method, 'GET')
    assert.equal(req.headers.authorization, 'Bearer test-token')
    assert.equal(req.headers.accept, 'application/json')
    assert.equal(req.headers['user-agent'], CLI_USER_AGENT)
    assert.ok(req.url === '/metrics/playground/project-game' || req.url === '/metrics/playground/override-game')
    const game = req.url.split('/').at(-1) as string
    jsonApi(res, { metrics: { [game]: 42, unrelated: 999 }, retry_in_seconds: 2, extra: 'discard' })
  }))
  const env = { ...authEnvironment(directory), POKI_CLI_TEST_REALTIME_URL: realtimeUrl }
  const project = await runCli(['realtime', 'users', '--format', 'json'], { cwd: directory, env })
  assert.equal(project.code, 0, project.stderr)
  assert.deepEqual(JSON.parse(project.stdout), { metrics: { 'project-game': 42 }, retry_in_seconds: 2 })
  const override = await runCli(['realtime', 'users', '--game', 'override-game'], { cwd: directory, env })
  assert.equal(override.code, 0, override.stderr)
  assert.deepEqual(parseToon(override.stdout), { metrics: { 'override-game': 42 }, retry_in_seconds: 2 })
})

void test('realtime errors sends a sorted deduplicated batch without requiring a game', async t => {
  const directory = temporaryDirectory(t, 'realtime-errors')
  const counts = Array.from({ length: 1440 }, (_value, index) => index === 1439 ? 3 : 0)
  let calls = 0
  const realtimeUrl = await listen(t, createServer((req, res) => {
    void (async () => {
      calls++
      assert.equal(req.method, 'POST')
      assert.equal(req.url, '/metrics/errors')
      assert.equal(req.headers.authorization, 'Bearer test-token')
      assert.equal(req.headers['content-type'], 'application/json')
      assert.deepEqual(await requestBody(req), ['version-a', 'version-z'])
      jsonApi(res, { metrics: { 'version-a': counts, 'version-z': counts }, retry_in_seconds: 2 })
    })()
  }))
  const result = await runCli(['realtime', 'errors', '--version', 'version-z', '--version', 'version-a', '--version', 'version-z', '--format', 'json'], {
    env: { ...authEnvironment(directory), POKI_CLI_TEST_REALTIME_URL: realtimeUrl }
  })
  assert.equal(result.code, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), { metrics: { 'version-a': counts, 'version-z': counts }, retry_in_seconds: 2 })
  assert.equal(calls, 1)
})

void test('realtime C2P preserves nullable minute buckets and the service polling recommendation', async t => {
  const directory = temporaryDirectory(t, 'realtime-c2p')
  writeFileSync(join(directory, 'poki.json'), JSON.stringify({ game_id: 'game-id' }))
  const minutes = Array.from({ length: 1440 }, (_value, index) => index === 1439 ? { pageviews: 8, gameplays: 3 } : null)
  const realtimeUrl = await listen(t, createServer((req, res) => {
    void (async () => {
      assert.equal(req.method, 'POST')
      assert.equal(req.url, '/metrics/c2p')
      assert.equal(req.headers['content-type'], 'application/json')
      assert.deepEqual(await requestBody(req), ['game-id'])
      jsonApi(res, { metrics: { 'game-id': minutes }, retry_in_seconds: 2 })
    })()
  }))
  const env = { ...authEnvironment(directory), POKI_CLI_TEST_REALTIME_URL: realtimeUrl }
  for (const format of ['json', 'toon']) {
    const result = await runCli(['realtime', 'c2p', '--format', format], { cwd: directory, env })
    assert.equal(result.code, 0, result.stderr)
    const output = format === 'json' ? JSON.parse(result.stdout) : parseToon(result.stdout)
    assert.deepEqual(output, { metrics: { 'game-id': minutes }, retry_in_seconds: 2 })
  }
})

void test('realtime rejects missing and empty identifiers before contacting a service', async () => {
  for (const args of [
    ['users'], ['c2p'], ['errors'],
    ['users', '--game', ''], ['c2p', '--game', 'a,b'],
    ['errors', '--version', ''], ['errors', '--version', 'a,b'],
    ['users', '--game', 'g', '--timeout-ms', '0']
  ]) {
    const result = await runCli(['realtime', ...args, '--format', 'json'])
    assert.equal(result.code, 2, result.stderr)
    assert.equal(result.stdout, '')
    assert.equal(JSON.parse(result.stderr).error.code, args.length === 1 && args[0] === 'errors' ? 'MISSING_INPUT' : 'INVALID_INPUT')
  }
  const unauthenticated = await runCli(['realtime', 'users', '--game', 'g', '--format', 'json'])
  assert.equal(unauthenticated.code, 3)
  assert.equal(JSON.parse(unauthenticated.stderr).error.code, 'AUTH_REQUIRED')
})

void test('realtime does not report missing or malformed metrics as successful empty data', async t => {
  const directory = temporaryDirectory(t, 'realtime-invalid')
  let payload: unknown
  const realtimeUrl = await listen(t, createServer((_req, res) => jsonApi(res, payload)))
  const env = { ...authEnvironment(directory), POKI_CLI_TEST_REALTIME_URL: realtimeUrl }
  for (const [metric, body] of [
    ['users', null], ['users', {}], ['users', { metrics: {} }],
    ['users', { metrics: { g: -1 } }], ['users', { metrics: { g: '42' } }],
    ['users', { metrics: { g: 0 }, retry_in_seconds: '2' }],
    ['errors', { metrics: { v: [null] } }],
    ['c2p', { metrics: { g: [null, { pageviews: 4 }] } }]
  ] as Array<[string, unknown]>) {
    payload = body
    const option = metric === 'errors' ? ['--version', 'v'] : ['--game', 'g']
    const result = await runCli(['realtime', metric, ...option, '--format', 'json'], { env })
    assert.equal(result.code, 5, result.stderr)
    assert.equal(result.stdout, '')
    assert.equal(JSON.parse(result.stderr).error.code, 'INVALID_API_RESPONSE')
  }
})

void test('realtime service failures are retryable reads, including POSTs, without automatic replay', async t => {
  const directory = temporaryDirectory(t, 'realtime-failure')
  let calls = 0
  const realtimeUrl = await listen(t, createServer((_req, res) => {
    calls++
    res.writeHead(503, { 'Content-Type': 'text/plain' })
    res.end('metric not ready')
  }))
  const env = { ...authEnvironment(directory), POKI_CLI_TEST_REALTIME_URL: realtimeUrl }
  for (const args of [['users', '--game', 'g'], ['errors', '--version', 'v'], ['c2p', '--game', 'g']]) {
    const result = await runCli(['realtime', ...args, '--format', 'json'], { env })
    assert.equal(result.code, 5, result.stderr)
    assert.equal(result.stdout, '')
    const error = JSON.parse(result.stderr).error
    assert.equal(error.code, 'HTTP_503')
    assert.equal(error.retryable, true)
  }
  assert.equal(calls, 3)
})

void test('realtime uses the selected service host and reuses refreshed credentials for Developers API requests', async () => {
  const requests: Array<{ url: string, authorization: string | null }> = []
  let refreshes = 0
  const api = new ApiClient('https://devs.invalid', {
    realtimeUrl: serviceEnvironment({ SERVICE_ENV: 'acceptance' }).realtimeUrl,
    readAuth: () => ({ access_type: 'Bearer', access_token: 'old-token', refresh_token: 'refresh-token' }),
    refreshAuth: async config => {
      refreshes++
      return { ...config, access_token: 'new-token' }
    },
    fetch: (async (input, init) => {
      const authorization = new Headers(init?.headers).get('Authorization')
      requests.push({ url: String(input), authorization })
      assert.equal(init?.redirect, 'manual')
      return new Response('{}', { status: authorization === 'Bearer old-token' ? 401 : 200 })
    }) as typeof fetch
  })
  await api.request({ service: 'realtime', path: '/metrics/errors', method: 'POST', body: ['v'], retrySafe: true })
  await api.request({ path: '/games/g' })
  assert.equal(refreshes, 1)
  assert.deepEqual(requests, [
    { url: 'https://realtime-acceptance.poki.com/metrics/errors', authorization: 'Bearer old-token' },
    { url: 'https://realtime-acceptance.poki.com/metrics/errors', authorization: 'Bearer new-token' },
    { url: 'https://devs.invalid/games/g', authorization: 'Bearer new-token' }
  ])
})

void test('realtime requests and Developers API pagination cannot cross their selected origin', async () => {
  let calls = 0
  const api = new ApiClient('https://devs.invalid', {
    realtimeUrl: 'https://realtime.invalid',
    readAuth: () => ({ access_type: 'Bearer', access_token: 'token' }),
    fetch: (async () => { calls++; return new Response('{}') }) as typeof fetch
  })
  for (const path of ['https://attacker.invalid/metrics/c2p', 'https://devs.invalid/metrics/c2p']) {
    await assert.rejects(api.request({ service: 'realtime', path }), (error: unknown) => error instanceof CliError && error.code === 'INVALID_API_RESPONSE')
  }
  assert.throws(() => api.resolveApiUrl('https://realtime.invalid/games'), CliError)
  assert.equal(api.isApiOrigin(new URL('https://realtime.invalid/games')), false)
  assert.equal(calls, 0)
})

void test('realtime structured help documents service shapes, resource permissions, and safe POST reads', () => {
  for (const metric of ['users', 'errors', 'c2p']) {
    const spec = commandSpec(['realtime', metric])
    assert.equal(spec?.risk, 'read_only')
    assert.equal(spec?.retry_safe, true)
    const document = helpDocument(['realtime', metric]) as Record<string, any>
    assert.equal(document.output_schema.shape.metrics, 'Object keyed by requested game or version IDs.')
    assert.equal(document.output_schema.shape.data, undefined)
    assert.deepEqual(document.permission_codes, [metric === 'errors' ? 'can_read_owned_versions' : 'can_read_owned_games'])
  }
  const c2p = helpDocument(['realtime', 'c2p']) as Record<string, any>
  assert.match(c2p.behavior.join(' '), /preserved as null/)
  assert.match(c2p.behavior.join(' '), /does not invent/)
  const errors = helpDocument(['realtime', 'errors']) as Record<string, any>
  assert.match(errors.output_schema.metrics, /neither raw error occurrences nor distinct affected users/)
})
