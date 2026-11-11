import assert from 'node:assert/strict'
import test from 'node:test'

import { audienceCatalog } from '../src/audiences'
import { runCli } from './helpers'

void test('audiences list serves the complete bundled category snapshot offline', async () => {
  assert.equal(audienceCatalog.length, 186)
  assert.equal(new Set(audienceCatalog.map(audience => audience.id)).size, audienceCatalog.length)
  assert.ok(audienceCatalog.every((audience, index) => index === 0 || audienceCatalog[index - 1].id < audience.id))
  assert.deepEqual(audienceCatalog.find(audience => audience.id === 1), { id: 1, name: 'Racing Games', enabled_for_testing: true })
  assert.deepEqual(audienceCatalog.find(audience => audience.id === 11), { id: 11, name: 'Battleship Games', enabled_for_testing: false })

  const result = await runCli(['audiences', 'list', '--format', 'json'])
  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.stderr, '')
  const document = JSON.parse(result.stdout) as { data: Array<{ id: number, name: string, enabled_for_testing: boolean }>, meta: { testing_only: boolean, total: number, bundled_snapshot: boolean, snapshot_advisory: boolean, mutation_backend_authoritative: boolean, usage: Record<string, string> } }
  assert.equal(document.meta.total, 186)
  assert.equal(document.meta.bundled_snapshot, true)
  assert.equal(document.meta.snapshot_advisory, true)
  assert.equal(document.meta.mutation_backend_authoritative, true)
  assert.deepEqual(document.meta.usage, {
    games: '--suggested-category NAME',
    playtest_requests: '--category ID',
    player_fit_tests: '--category ID'
  })
  assert.deepEqual(document.data, audienceCatalog)
})

void test('audiences list --testing-only returns only targetable bundled IDs', async () => {
  const result = await runCli(['audiences', 'list', '--testing-only', '--format', 'json'])
  assert.equal(result.code, 0, result.stderr)
  const document = JSON.parse(result.stdout) as { data: Array<{ id: number, enabled_for_testing: boolean }>, meta: { testing_only: boolean, total: number } }
  assert.equal(document.meta.testing_only, true)
  assert.equal(document.meta.total, 98)
  assert.ok(document.data.every(audience => audience.enabled_for_testing))
  assert.ok(document.data.some(audience => audience.id === 1))
  assert.ok(!document.data.some(audience => audience.id === 11))
})
