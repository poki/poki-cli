import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { apiHarness, jsonApi, requestBody, runCli, temporaryDirectory } from './helpers'

void test('A/B commands expose offline help, previews, and validation without permission discovery', async () => {
  for (const group of ['game-ab-tests', 'thumbnail-ab-tests']) {
    const help = await runCli(['help', group, '--format', 'json'])
    assert.equal(help.code, 0, help.stderr)
    assert.match(help.stdout, /create/)
    for (const action of ['start', 'stop', 'delete']) {
      const args = [group, action, 'test-1', '--game', 'game-1', '--format', 'json']
      const unconfirmed = await runCli(args)
      assert.notEqual(unconfirmed.code, 0)
      const preview = await runCli([...args, '--dry-run'])
      assert.equal(preview.code, 0, preview.stderr)
      const body = JSON.parse(preview.stdout)
      assert.equal(body.contacted_api, false)
      assert.equal(body.destructive, true)
      assert.equal(body.request.method, action === 'delete' ? 'DELETE' : 'POST')
      assert.equal(body.request.path, `/games/game-1/${group === 'game-ab-tests' ? 'ab_tests' : 'game_thumbnail_ab_tests'}/test-1${action === 'delete' ? '' : `/@${action}`}`)
    }
  }
  for (const args of [
    ['game-ab-tests', 'update', 't1', '--data', '{"version_a_id":"v2"}'],
    ['thumbnail-ab-tests', 'update', 't1', '--data', '{"thumbnail_b":"eA=="}'],
    ['thumbnail-ab-tests', 'create', '--data', '{"name":"Test","description":"Test","thumbnail_b":"%%%"}'],
    ['game-ab-tests', 'create', '--data', '{"name":"Test","version_a_id":"a","version_b_id":"b","target_sample_size":1.5}']
  ]) {
    const result = await runCli([...args, '--game', 'game-1', '--dry-run', '--format', 'json'])
    assert.equal(result.code, 2, result.stderr)
  }
})

void test('A/B lifecycle sends backend resource types and retains results', async t => {
  const requests: Array<{ method: string | undefined, url: string | undefined, body: unknown }> = []
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  const { env } = await apiHarness(t, async (req, res) => {
    const body = req.method === 'PATCH' || (req.method === 'POST' && req.url?.includes('/@') !== true) ? await requestBody(req) : undefined
    requests.push({ method: req.method, url: req.url, body })
    const type = req.url?.includes('game_thumbnail_ab_tests') === true ? 'game_thumbnail_ab_tests' : 'ab_tests'
    if (req.method === 'DELETE') { res.writeHead(204); res.end(); return }
    const resource = { type, id: 'test-1', attributes: { name: 'Experiment', status: 'done', result: 'a', result_headline: 'Variant A wins', version_a_sample_count: 2500, thumbnail_a_clicks: 1200 } }
    const list = req.method === 'GET' && req.url?.includes('/test-1') !== true
    jsonApi(res, { data: list ? [resource] : resource, ...(list ? { meta: { total: 1 } } : {}) })
  }, 'ab-lifecycle')
  for (const [group, type] of [['game-ab-tests', 'ab_tests'], ['thumbnail-ab-tests', 'game_thumbnail_ab_tests']]) {
    const createData = group === 'game-ab-tests'
      ? { name: 'Experiment', version_a_id: 'v1', version_b_id: 'v2', version_a_description: null, device: 'mobile' }
      : { name: 'Experiment', description: 'Compare thumbnails', thumbnail_b: 'eA==', target_sample_type: 'clicks' }
    const created = await runCli([group, 'create', '--game', 'g/1', '--data', JSON.stringify(createData), '--format', 'json'], { env })
    assert.equal(created.code, 0, created.stderr)
    assert.deepEqual(requests.at(-1), { method: 'POST', url: `/games/g%2F1/${type}`, body: { data: { type, attributes: createData } } })
    const list = await runCli([group, 'list', '--game', 'g/1', '--filter', 'status=done', '--full', '--format', 'json'], { env })
    assert.equal(list.code, 0, list.stderr)
    const listed = JSON.parse(list.stdout).data[0]
    assert.equal(group === 'game-ab-tests' ? listed.version_a_sample_count : listed.thumbnail_a_clicks, group === 'game-ab-tests' ? 2500 : 1200)
    assert.match(requests.at(-1)?.url ?? '', /filter%5Bstatus%5D=done/)
    const get = await runCli([group, 'get', 'test-1', '--game', 'g/1', '--format', 'json'], { env })
    assert.equal(get.code, 0, get.stderr)
    for (const action of ['update', 'start', 'stop', 'delete']) {
      const result = await runCli([group, action, 'test-1', '--game', 'g/1', ...(action === 'update' ? ['--name', 'Updated experiment'] : ['--yes']), '--format', 'json'], { env })
      assert.equal(result.code, 0, result.stderr)
      assert.equal(requests.at(-1)?.method, action === 'update' ? 'PATCH' : action === 'delete' ? 'DELETE' : 'POST')
    }
  }
  assert.equal(requests.length, 14)
})

void test('thumbnail-file is encoded for creation but redacted from dry-run', async t => {
  const directory = temporaryDirectory(t, 'ab-thumbnail')
  const path = join(directory, 'thumbnail.png')
  writeFileSync(path, 'image fixture')
  const args = ['thumbnail-ab-tests', 'create', '--game', 'g', '--name', 'New artwork', '--description', 'Comparison', '--thumbnail-file', path, '--format', 'json']
  const preview = await runCli([...args, '--dry-run'])
  assert.equal(preview.code, 0, preview.stderr)
  assert.equal(JSON.parse(preview.stdout).request.body.data.attributes.thumbnail_b.value_omitted, true)
  assert.doesNotMatch(preview.stdout, /aW1hZ2UgZml4dHVyZQ==/)
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  const { env } = await apiHarness(t, async (req, res) => {
    assert.equal((await requestBody(req) as { data: { attributes: { thumbnail_b: string } } }).data.attributes.thumbnail_b, Buffer.from('image fixture').toString('base64'))
    jsonApi(res, { data: { type: 'game_thumbnail_ab_tests', id: 'test-1', attributes: { status: 'draft' } } })
  }, 'ab-thumbnail-upload')
  assert.equal((await runCli(args, { env })).code, 0)
})

void test('Web Fit uses plain JSON and handles empty success; backend denials are not retried', async t => {
  let requests = 0
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  const { env } = await apiHarness(t, async (req, res) => {
    requests++
    if (req.url?.includes('/ab_tests') === true) {
      res.writeHead(403, { 'Content-Type': 'application/vnd.api+json' })
      res.end(JSON.stringify({ errors: [{ status: '403', title: 'permission-denied' }] }))
      return
    }
    assert.equal(req.url, '/games/game-1/_webfit')
    assert.equal(req.headers['content-type'], 'application/json')
    assert.deepEqual(await requestBody(req), { version_id: 'v1', golden_ticket: true })
    res.writeHead(200); res.end()
  }, 'web-fit-request')
  const args = ['web-fit-tests', 'request', '--game', 'game-1', '--version', 'v1', '--golden-ticket', '--format', 'json']
  const preview = await runCli([...args, '--dry-run'], { env })
  assert.equal(preview.code, 0, preview.stderr)
  assert.equal(requests, 0)
  const result = await runCli([...args, '--yes'], { env })
  assert.equal(result.code, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).data.requested, true)
  const denied = await runCli(['game-ab-tests', 'list', '--game', 'game-1', '--format', 'json'], { env })
  assert.notEqual(denied.code, 0)
  assert.equal(requests, 2)
})

void test('A/B content rules are delegated to the backend and validation errors remain actionable', async t => {
  const received: unknown[] = []
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  const { env } = await apiHarness(t, async (req, res) => {
    received.push(await requestBody(req))
    res.writeHead(422, { 'Content-Type': 'application/vnd.api+json' })
    res.end(JSON.stringify({ errors: [{ code: 'payload-validation-failed', detail: 'version_b_id is invalid: version_a_id and version_b_id must be different' }] }))
  }, 'ab-backend-validation')
  const data = { name: 'x\u200B', version_a_id: 'same', version_b_id: 'same', target_sample_size: -1 }
  for (const input of [
    ['--data', JSON.stringify(data)],
    ['--name', data.name, '--version-a', 'same', '--version-b', 'same', '--target-sample-size=-1']
  ]) {
    const args = ['game-ab-tests', 'create', '--game', 'g', ...input, '--format', 'json']
    const preview = await runCli([...args, '--dry-run'], { env })
    assert.equal(preview.code, 0, preview.stderr)
    assert.deepEqual(JSON.parse(preview.stdout).request.body.data.attributes, data)
    const result = await runCli(args, { env })
    assert.equal(result.code, 4, result.stderr)
    const error = JSON.parse(result.stderr).error
    assert.equal(error.code, 'PAYLOAD_VALIDATION_FAILED')
    assert.match(error.message, /version_a_id and version_b_id must be different/)
    assert.equal(error.retryable, false)
    assert.deepEqual(received.at(-1), JSON.parse(preview.stdout).request.body)
  }
  assert.equal(received.length, 2)
})
