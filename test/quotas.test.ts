import { createServer } from 'node:http'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { authEnvironment, jsonApi, listen, runCli, temporaryDirectory } from './helpers'
import assert from 'node:assert/strict'
import test from 'node:test'

import { ApiClient } from '../src/api'
import { CliError, errorDocument, safeErrorCause } from '../src/errors'
import { safeQuotaMetadata } from '../src/quotas'

const meta = {
  limit_key: 'playtest_game_daily_quota',
  scope: 'game',
  scope_id: 'game-1',
  unit: 'recordings',
  limit: 100,
  used: 98,
  remaining: 2,
  requested: 10,
  resets_at: '2026-10-06T00:00:00Z'
}

void test('quota rejections are definite, retain safe metadata and are never retried', async () => {
  for (const method of ['GET', 'POST'] as const) {
    let requests = 0
    const api = new ApiClient('https://example.invalid', {
      readAuth: () => ({ access_type: 'Bearer', access_token: 'test-token' }),
      fetch: (async () => {
        requests++
        return new Response(JSON.stringify({ errors: [{ status: '429', code: 'test-quota-exceeded', title: 'Testing limit reached', detail: '2 recordings remaining', meta: { ...meta, secret: 'must-not-leak' } }] }), { status: 429, headers: { 'Content-Type': 'application/vnd.api+json', 'Retry-After': '1' } })
      }) as typeof fetch
    })
    await assert.rejects(api.request({ method, path: '/games/game-1/playtest-requests', ...(method === 'POST' ? { body: {} } : {}) }), error => {
      assert.ok(error instanceof CliError)
      assert.equal(error.code, 'TEST_QUOTA_EXCEEDED')
      const document = JSON.stringify(errorDocument(error))
      assert.ok(document.includes('playtest_game_daily_quota'))
      assert.ok(document.includes('"retryable":false'))
      assert.ok(!document.includes('must-not-leak'))
      assert.ok(JSON.stringify(safeErrorCause(error)).includes('playtest_game_daily_quota'))
      return true
    })
    assert.equal(requests, 1)
  }
})

void test('quota metadata rejects malformed numeric values and unknown limit keys', () => {
  assert.deepEqual(safeQuotaMetadata({ ...meta, secret: 'hidden' }), meta)
  assert.equal(safeQuotaMetadata({ ...meta, remaining: -1 }), undefined)
  assert.equal(safeQuotaMetadata({ ...meta, limit_key: 'unknown' }), undefined)
})

void test('limits get resolves explicit scopes, project game and authenticated team', async t => {
  const paths: string[] = []
  const server = createServer((req, res) => {
    paths.push(req.url ?? '')
    if (req.url === '/users/@me') {
      jsonApi(res, { data: { type: 'users', id: 'user-1', attributes: {}, relationships: { team: { data: { type: 'teams', id: 'team-1' } } } } })
      return
    }
    const id = req.url?.split('/')[2]
    jsonApi(res, { data: { type: 'quotas', id, attributes: { resets_at: '2026-10-06T00:00:00Z', playtest_team_limit: 300, playtest_team_used: 298, webfit_limit: 2, webfit_active: 1 } } })
  })
  const directory = temporaryDirectory(t, 'limits')
  const env = authEnvironment(directory, await listen(t, server))
  for (const flags of [['--game', 'game-1'], ['--team', 'team-1'], []]) {
    const result = await runCli(['limits', 'get', ...flags, '--format', 'json'], { env, cwd: directory })
    assert.equal(result.code, 0, result.stderr)
    assert.equal(JSON.parse(result.stdout).data.playtest_team_used, 298)
  }
  writeFileSync(join(directory, 'poki.json'), JSON.stringify({ game_id: 'project-game' }))
  const result = await runCli(['limits', 'get', '--format', 'json'], { env, cwd: directory })
  assert.equal(result.code, 0, result.stderr)
  assert.deepEqual(paths, ['/games/game-1/@quota', '/teams/team-1/@quota', '/users/@me', '/teams/team-1/@quota', '/games/project-game/@quota'])
})
