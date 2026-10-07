import assert from 'node:assert/strict'
import test from 'node:test'

import { apiHarness, jsonApi, requestBody, runCli } from './helpers'

void test('reviews update validates structured field types before previewing or requesting', async t => {
  let requests = 0
  let updateBody: Record<string, unknown> | undefined
  // The test server callback intentionally owns its async request lifecycle.
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  const { env } = await apiHarness(t, async (req, res) => {
    requests++
    updateBody = await requestBody(req)
    jsonApi(res, {
      data: {
        type: 'reviews',
        id: 'review-1',
        attributes: { developer_notes: 'Updated notes', seen_by_developer: false }
      }
    })
  }, 'review-update')

  for (const { data, message } of [
    { data: '{"developer_notes":42}', message: /developer_notes must be a string/ },
    { data: '{"seen_by_developer":"false"}', message: /seen_by_developer must be a boolean/ },
    { data: '{"developer_notes":"hidden\u200Bseparator"}', message: /developer_notes must not contain zero-width characters/ }
  ]) {
    const result = await runCli([
      'reviews', 'update', 'version-1', 'review-1', '--game', 'game-1',
      '--data', data, '--dry-run', '--format', 'json'
    ], { env })
    assert.equal(result.code, 2, result.stderr)
    assert.equal(result.stdout, '')
    const error = JSON.parse(result.stderr).error
    assert.equal(error.code, 'INVALID_INPUT')
    assert.match(error.message, message)
  }
  assert.equal(requests, 0)

  const preview = await runCli([
    'reviews', 'update', 'version-1', 'review-1', '--game', 'game-1',
    '--data', '{"developer_notes":"Updated notes","seen_by_developer":false}',
    '--dry-run', '--format', 'json'
  ], { env })
  assert.equal(preview.code, 0, preview.stderr)
  assert.deepEqual(JSON.parse(preview.stdout).request.body, {
    data: {
      type: 'reviews',
      id: 'review-1',
      attributes: { developer_notes: 'Updated notes', seen_by_developer: false }
    }
  })
  assert.equal(requests, 0)

  const updated = await runCli([
    'reviews', 'update', 'version-1', 'review-1', '--game', 'game-1',
    '--data', '{"developer_notes":"Updated notes","seen_by_developer":false}',
    '--format', 'json'
  ], { env })
  assert.equal(updated.code, 0, updated.stderr)
  assert.equal(requests, 1)
  assert.deepEqual(updateBody, {
    data: {
      type: 'reviews',
      id: 'review-1',
      attributes: { developer_notes: 'Updated notes', seen_by_developer: false }
    }
  })
})
