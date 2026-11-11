import assert from 'node:assert/strict'
import test from 'node:test'

import { apiHarness, runCli, parseToon } from './helpers'

void test('categories list reads authenticated plain JSON and preserves current category types', async t => {
  const categories = [
    { id: 12345, title: 'New Category', category_type: 'new-type', private_field: 'hidden' },
    { id: 1, title: 'Renamed Category', category_type: '' }
  ]
  const { env } = await apiHarness(t, (req, res) => {
    assert.equal(req.method, 'GET')
    assert.equal(req.url, '/categories')
    assert.ok(req.headers.authorization?.startsWith('Bearer '))
    assert.equal(req.headers.accept, 'application/json')
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(categories))
  }, 'categories')
  for (const format of ['json', 'toon']) {
    const result = await runCli(['categories', 'list', '--format', format, '--timeout-ms', '2000'], { env })
    assert.equal(result.code, 0, result.stderr)
    const document = format === 'json' ? JSON.parse(result.stdout) : parseToon(result.stdout)
    assert.deepEqual(document, { data: categories.map(({ private_field: ignored, ...category }) => category), meta: { total: 2 } })
  }
})

void test('categories list accepts empty lists and rejects malformed response shapes', async t => {
  let body: unknown = []
  const { env } = await apiHarness(t, (_req, res) => {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(body))
  }, 'categories-validation')
  const empty = await runCli(['categories', 'list', '--format', 'json'], { env })
  assert.equal(empty.code, 0, empty.stderr)
  assert.deepEqual(JSON.parse(empty.stdout), { data: [], meta: { total: 0 } })
  for (body of [null, { data: [] }, [null], [{ id: '1', title: 'Games', category_type: 'genre' }], [{ id: 1, title: 'Games' }]]) {
    const result = await runCli(['categories', 'list', '--format', 'json'], { env })
    assert.equal(result.code, 5, result.stderr)
    assert.match(result.stderr, /INVALID_API_RESPONSE/)
    assert.equal(result.stdout, '')
  }
})

void test('categories list requires authentication', async () => {
  const result = await runCli(['categories', 'list', '--format', 'json'])
  assert.equal(result.code, 3, result.stderr)
  assert.match(result.stderr, /AUTH_REQUIRED/)
})
