import assert from 'node:assert/strict'
import test from 'node:test'

import { gameReadiness } from '../src/readiness'
import { apiHarness, jsonApi, requestBody, runCli } from './helpers'

void test('game settings persist archive and personal favorite state, including reversal', async t => {
  const bodies: unknown[] = []
  const { env } = await apiHarness(t, (req, res) => {
    void (async () => {
      assert.equal(req.method, 'PATCH')
      assert.equal(req.url, '/games/g')
      const body = await requestBody(req)
      bodies.push(body)
      jsonApi(res, body)
    })()
  }, 'game-settings-parity')
  for (const enabled of [true, false]) {
    const result = await runCli(['games', 'update', 'g', enabled ? '--archived' : '--no-archived', enabled ? '--favorite' : '--no-favorite', '--format', 'json'], { env })
    assert.equal(result.code, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout).data, { type: 'games', id: 'g', archived: enabled, favorite: enabled })
    assert.deepEqual(bodies.at(-1), { data: { type: 'games', id: 'g', attributes: { archived: enabled, favorite: enabled } } })
  }
  const invalid = await runCli(['games', 'update', 'g', '--data', '{"archived":"false"}', '--dry-run', '--format', 'json'])
  assert.equal(invalid.code, 2)
})

void test('game reads preserve store URLs, planned releases, and Dialog integration', async t => {
  const metadata = {
    release_status: 'live-test',
    scheduled_release_status: 'full-release',
    scheduled_release_at: '2026-11-01T10:00:00Z',
    scheduled_release_confirmed: false,
    play_store_url: 'https://play.google.com/store/apps/details?id=example.game',
    apple_store_url: 'https://apps.apple.com/app/id123',
    steam_url: 'https://store.steampowered.com/app/123/'
  }
  const attributes = { archived: true, favorite: false, uses_dialog: true, play_store_url: metadata.play_store_url, apple_store_url: metadata.apple_store_url, steam_url: metadata.steam_url, content_metadata: metadata }
  const { env } = await apiHarness(t, (_req, res) => { jsonApi(res, { data: { type: 'games', id: 'g', attributes } }) }, 'game-fields-parity')
  const result = await runCli(['games', 'get', 'g', '--format', 'json'], { env })
  assert.equal(result.code, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout).data, { type: 'games', id: 'g', ...attributes })
})

void test('store URL changes and A/B winner requests reach the API without unrelated attributes', async t => {
  const bodies: unknown[] = []
  const { env } = await apiHarness(t, (req, res) => {
    void (async () => {
      assert.equal(req.method, 'POST')
      assert.equal(req.url, '/games/g/change_requests')
      const body = await requestBody(req) as { data: { attributes: Record<string, unknown> } }
      bodies.push(body.data.attributes)
      jsonApi(res, { data: { type: 'game_change_requests', id: 'r', attributes: { ...body.data.attributes, previous_steam_url: 'https://store.steampowered.com/app/456/' } } })
    })()
  }, 'change-request-parity')
  const url = 'https://play.google.com/store/apps/details?id=example.game'
  const changes = await runCli(['game-change-requests', 'create', '--game', 'g', '--play-store-url', url, '--apple-store-url', 'https://apps.apple.com/us/app/example/id123', '--steam-url', '', '--format', 'json'], { env })
  assert.equal(changes.code, 0, changes.stderr)
  assert.deepEqual(bodies[0], { play_store_url: url, apple_store_url: 'https://apps.apple.com/us/app/example/id123', steam_url: '' })
  assert.equal(JSON.parse(changes.stdout).data.steam_url, '')
  assert.equal(JSON.parse(changes.stdout).data.previous_steam_url, 'https://store.steampowered.com/app/456/')
  const winner = await runCli(['game-change-requests', 'create', '--game', 'g', '--thumbnail-ab-test-id', 'winner', '--format', 'json'], { env })
  assert.equal(winner.code, 0, winner.stderr)
  assert.deepEqual(bodies[1], { thumbnail_ab_test_id: 'winner' })
  const data = await runCli(['game-change-requests', 'create', '--game', 'g', '--data', '{"steam_url":"  https://store.steampowered.com/app/123/  ","apple_store_url":""}', '--dry-run', '--format', 'json'])
  assert.equal(data.code, 0, data.stderr)
  assert.deepEqual(JSON.parse(data.stdout).request.body.data.attributes, { steam_url: '  https://store.steampowered.com/app/123/  ', apple_store_url: '' })
  for (const attributes of [
    { steam_url: null }, { steam_url: 'https://example.com/app/123' },
    { play_store_url: 'https://play.google.com.evil.test/store/apps/details?id=x' },
    { apple_store_url: 'https://apps.apple.com/app/not-an-id' },
    { thumbnail_ab_test_id: '' }, { thumbnail_ab_test_id: 'winner', title: 'Other title' },
    { thumbnail_ab_test_id: 'winner', steam_url: '' }
  ]) {
    const invalid = await runCli(['game-change-requests', 'create', '--game', 'g', '--data', JSON.stringify(attributes), '--dry-run', '--format', 'json'])
    assert.equal(invalid.code, attributes.steam_url === null ? 2 : 0, invalid.stderr)
    if (invalid.code === 0) assert.deepEqual(JSON.parse(invalid.stdout).request.body.data.attributes, attributes)
  }
})

void test('recording lists expose lifecycle and only add playable URLs to completed recordings', async t => {
  const states = ['pending', 'encoding', 'done', 'canceled', null, undefined]
  const { env } = await apiHarness(t, (_req, res) => {
    jsonApi(res, { data: states.map((state, index) => ({ type: 'playtest_recordings', id: String(index), attributes: state === undefined ? {} : { state } })) })
  }, 'recording-states-parity')
  for (const raw of [false, true]) {
    const result = await runCli(['playtest-recordings', 'list', '--game', 'g', '--format', 'json', ...(raw ? ['--raw'] : [])], { env })
    assert.equal(result.code, 0, result.stderr)
    const document = JSON.parse(result.stdout)
    for (const [index, state] of states.entries()) {
      const recording = raw ? document.data[index].attributes : document.data[index]
      assert.equal(recording.state, state)
      assert.equal(typeof recording.video_url === 'string', state == null || state === 'done')
      assert.equal(typeof recording.metadata_json_url === 'string', state == null || state === 'done')
    }
  }
})

void test('readiness matches backend game approval, release, and archive restrictions', () => {
  const base = { id: 'g', team_id: 't', versions: [{ id: 'v', state: 'done' }] }
  const user = { id: 'u', team_id: 't' }
  const permissions = ['can_edit_owned_game_tracks', 'can_edit_owned_playtests', 'can_edit_owned_player_fit_tests']
  for (const release of ['not-released', 'live-test', 'no-link-release', '10k-test', '10k-test-with-content-restrictions']) {
    const report = gameReadiness({ ...base, approved: false, content_metadata: { release_status: release } }, user, permissions) as { operations: Record<string, { status: string }> }
    assert.equal(report.operations.versions_activate.status, ['no-link-release', '10k-test', '10k-test-with-content-restrictions'].includes(release) ? 'ready' : 'blocked')
  }
  const report = gameReadiness({ ...base, approved: true, archived: true }, user, permissions) as { operations: Record<string, { status: string, blockers: Array<{ code: string }> }> }
  assert.equal(report.operations.versions_activate.status, 'ready')
  for (const operation of ['playtest_requests_create', 'player_fit_tests_create']) {
    assert.equal(report.operations[operation].status, 'blocked')
    assert.ok(report.operations[operation].blockers.some(blocker => blocker.code === 'GAME_ARCHIVED'))
  }
})
