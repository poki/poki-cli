import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { configHomeEnvironment, listen, pokiConfigDirectory, runCli, temporaryDirectory } from './helpers'

// Unlike helpers.authEnvironment, refresh tests need to seed an arbitrary auth
// document and inject separate API and authentication servers into the private
// test entry point.
function seededAuthEnvironment (root: string, auth: Record<string, unknown>, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const config = pokiConfigDirectory(root)
  mkdirSync(config, { recursive: true })
  writeFileSync(join(config, 'auth.json'), JSON.stringify(auth))
  // Pin the seeded mode instead of inheriting the developer's umask, so the
  // permission repair below is asserted against a genuinely readable file.
  if (process.platform !== 'win32') chmodSync(join(config, 'auth.json'), 0o644)
  return { ...configHomeEnvironment(root), ...extra }
}

void test('a 401 triggers one refresh, replays the request once, and persists the new tokens', async t => {
  const directory = temporaryDirectory(t, 'auth-refresh')

  const refreshRequests: Array<{ method?: string, path?: string, body: unknown }> = []
  const refreshServer = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += String(chunk) })
    req.on('end', () => {
      refreshRequests.push({ method: req.method, path: req.url, body: JSON.parse(body) })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ access_token: 'fresh', refresh_token: 'r2' }))
    })
  })
  const refreshUrl = await listen(t, refreshServer)

  const apiAuthorizations: Array<string | undefined> = []
  const apiServer = createServer((req, res) => {
    apiAuthorizations.push(req.headers.authorization)
    if (req.headers.authorization === 'Bearer fresh') {
      res.writeHead(200, { 'Content-Type': 'application/vnd.api+json' })
      res.end(JSON.stringify({ data: [{ type: 'games', id: 'g', attributes: { title: 'Example' } }], meta: { total: 1 } }))
      return
    }
    res.writeHead(401, { 'Content-Type': 'application/vnd.api+json' })
    res.end(JSON.stringify({ errors: [{ code: 'unauthorized', detail: 'Token expired.' }] }))
  })
  const apiUrl = await listen(t, apiServer)

  const env = seededAuthEnvironment(directory, { access_type: 'Bearer', access_token: 'stale', refresh_token: 'r1' }, {
    POKI_CLI_TEST_API_URL: apiUrl,
    POKI_CLI_TEST_AUTH_URL: refreshUrl
  })
  const result = await runCli(['games', 'list', '--format', 'json'], { env, cwd: directory })
  assert.equal(result.code, 0, result.stderr)

  // Exactly two API requests: the stale attempt, then the replay.
  assert.deepEqual(apiAuthorizations, ['Bearer stale', 'Bearer fresh'])
  assert.equal(refreshRequests.length, 1)
  assert.equal(refreshRequests[0].method, 'POST')
  assert.equal(refreshRequests[0].path, '/auth/refresh')
  assert.deepEqual(refreshRequests[0].body, { refresh_token: 'r1' })

  // The refreshed tokens were written back through writeStoredAuth.
  const authPath = join(pokiConfigDirectory(directory), 'auth.json')
  const stored = JSON.parse(readFileSync(authPath, 'ascii'))
  assert.equal(stored.access_token, 'fresh')
  assert.equal(stored.refresh_token, 'r2')
  assert.equal(stored.access_type, 'Bearer')

  // The seeded file used the default umask, so persisting credentials must
  // also repair permissions on a file an older CLI left world-readable.
  if (process.platform !== 'win32') {
    assert.equal(statSync(authPath).mode & 0o777, 0o600)
  }

  const output = JSON.parse(result.stdout)
  assert.equal(output.data[0].id, 'g')
})

void test('a rejected refresh becomes AUTH_REQUIRED with exit 3 and no second API request', async t => {
  const directory = temporaryDirectory(t, 'auth-refresh-denied')

  let refreshRequests = 0
  const refreshServer = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      refreshRequests++
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'invalid_grant' }))
    })
  })
  const refreshUrl = await listen(t, refreshServer)

  let apiRequests = 0
  const apiServer = createServer((_req, res) => {
    apiRequests++
    res.writeHead(401, { 'Content-Type': 'application/vnd.api+json' })
    res.end(JSON.stringify({ errors: [{ code: 'unauthorized', detail: 'Token expired.' }] }))
  })
  const apiUrl = await listen(t, apiServer)

  const env = seededAuthEnvironment(directory, { access_type: 'Bearer', access_token: 'stale', refresh_token: 'r1' }, {
    POKI_CLI_TEST_API_URL: apiUrl,
    POKI_CLI_TEST_AUTH_URL: refreshUrl
  })
  const result = await runCli(['games', 'list', '--format', 'json'], { env, cwd: directory })
  assert.equal(result.code, 3, result.stderr)
  assert.equal(result.stdout, '')
  const error = JSON.parse(result.stderr).error
  assert.equal(error.code, 'AUTH_REQUIRED')
  assert.equal(apiRequests, 1)
  assert.equal(refreshRequests, 1)

  // The stale credentials stay on disk untouched.
  const stored = JSON.parse(readFileSync(join(pokiConfigDirectory(directory), 'auth.json'), 'ascii'))
  assert.equal(stored.access_token, 'stale')
  assert.equal(stored.refresh_token, 'r1')
})
