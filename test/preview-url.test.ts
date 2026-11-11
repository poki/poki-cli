import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeJsonApiResource, normalizeJsonApiResourceForRecovery } from '../src/jsonapi'
import { apiHarness, jsonApi, runCli } from './helpers'

const gameId = '14526a86-001e-420c-9947-75359672b5c1'
const versionId = '3dc68c8c-a362-42ad-88a4-1593d794fc99'
const previewUrl = `https://poki.com/en/preview/${gameId}/${versionId}`
const hostedUrl = `https://${gameId}.gdn.poki.com/${versionId}/index.html`
const version = {
  type: 'game_versions',
  id: versionId,
  attributes: { game_id: gameId, state: 'done', url: hostedUrl }
}

void test('version preview URLs use resource IDs and preserve the hosted entrypoint', () => {
  const result = normalizeJsonApiResource({
    data: {
      ...version,
      attributes: { ...version.attributes, preview_url: 'https://untrusted.example/' }
    }
  })
  assert.deepEqual(result, {
    data: { type: 'game_versions', id: versionId, ...version.attributes, preview_url: previewUrl },
    meta: {}
  })
  const encoded = normalizeJsonApiResource({
    data: {
      type: 'game_versions', id: 'version/with?delimiters', attributes: { game_id: 'game/#id' }
    }
  })
  assert.equal((encoded.data as Record<string, unknown>).preview_url,
    'https://poki.com/en/preview/game%2F%23id/version%2Fwith%3Fdelimiters')
})

void test('missing or malformed IDs never produce a preview URL, including upload recovery', () => {
  for (const missingGameId of [undefined, null, '', ' ', 42]) {
    const result = normalizeJsonApiResource({
      data: {
        ...version, attributes: { game_id: missingGameId, preview_url: 'https://untrusted.example/' }
      }
    })
    assert.equal((result.data as Record<string, unknown>).preview_url, undefined)
  }
  for (const id of [undefined, null, '', ' ', 42]) {
    const body = { data: { ...version, id } }
    const normal = normalizeJsonApiResource(body)
    const recovery = normalizeJsonApiResourceForRecovery(body)
    assert.equal((normal.data as Record<string, unknown>).preview_url, undefined)
    assert.equal((recovery.data as Record<string, unknown>).preview_url, undefined)
    assert.doesNotMatch(JSON.stringify(recovery), /__poki_cli_unidentified_resource__/)
  }
})

void test('CLI exposes preview URLs in version views and embedded game versions while preserving raw responses', async t => {
  const gameDocument = {
    data: {
      type: 'games',
      id: gameId,
      relationships: { versions: { data: [{ type: 'game_versions', id: versionId }] } }
    },
    included: [version]
  }
  const { env } = await apiHarness(t, (req, res) => {
    const path = req.url?.split('?')[0]
    if (path === `/games/${gameId}`) {
      jsonApi(res, gameDocument)
    } else if (path === `/versions/${versionId}`) {
      jsonApi(res, { data: version })
    } else {
      assert.equal(path, `/games/${gameId}/versions`)
      jsonApi(res, { data: [version], meta: { total: 1 } })
    }
  }, 'preview-urls')

  for (const view of [[], ['--full'], ['--fields', 'preview_url,url']]) {
    const result = await runCli(['versions', 'list', '--game', gameId, ...view, '--format', 'json'], { env })
    assert.equal(result.code, 0, result.stderr)
    const data = JSON.parse(result.stdout).data[0]
    assert.equal(data.preview_url, previewUrl)
    assert.equal(data.url, hostedUrl)
  }
  const single = await runCli(['versions', 'get', versionId, '--format', 'json'], { env })
  assert.equal(single.code, 0, single.stderr)
  assert.equal(JSON.parse(single.stdout).data.preview_url, previewUrl)

  const game = await runCli(['games', 'get', gameId, '--format', 'json'], { env })
  assert.equal(game.code, 0, game.stderr)
  assert.equal(JSON.parse(game.stdout).data.versions[0].preview_url, previewUrl)

  for (const [args, expected] of [
    [['versions', 'list', '--game', gameId], { data: [version], meta: { total: 1 } }],
    [['versions', 'get', versionId], { data: version }],
    [['games', 'get', gameId], gameDocument]
  ] as const) {
    const raw = await runCli([...args, '--raw', '--format', 'json'], { env })
    assert.equal(raw.code, 0, raw.stderr)
    assert.deepEqual(JSON.parse(raw.stdout), expected)
  }
})

void test('field discovery and workflow help direct browser users to the CLI preview URL', async () => {
  const field = await runCli(['versions', 'field', 'preview_url', '--format', 'json'])
  assert.equal(field.code, 0, field.stderr)
  const definition = JSON.parse(field.stdout).data
  assert.equal(definition.source, 'cli')
  assert.equal(definition.mutability, 'computed')
  assert.match(definition.summary, /once state is done/)

  const workflows = await runCli(['help', 'workflows', '--format', 'json'])
  assert.equal(workflows.code, 0, workflows.stderr)
  const steps = JSON.parse(workflows.stdout).preview.steps
  assert.match(steps[0], /--filter state=done --sort -created_at --page-size 1/)
  assert.match(steps[1], /preview_url/)
})
