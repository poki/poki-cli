import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { apiHarness, authEnvironment, jsonApi, listen, requestBody, runCli, temporaryDirectory } from './helpers'

void test('resource lists default to operational summaries and support full and selected views', async t => {
  const { env } = await apiHarness(t, (req, res) => {
    jsonApi(res, {
      data: [{
        type: 'games',
        id: 'game-1',
        attributes: {
          title: 'Example',
          approved: true,
          internal_notes: 'private detail',
          unknown_server_field: 42
        }
      }],
      meta: { total: 1 }
    })
  }, 'views')

  const summary = await runCli(['games', 'list', '--format', 'json'], { env })
  assert.deepEqual(JSON.parse(summary.stdout), {
    data: [{ type: 'games', id: 'game-1', title: 'Example', approved: true }],
    // One row against a 30-row request proves exhaustion, so has_next is a
    // reported false rather than an absent key a reader could take either way.
    meta: { total: 1, page: 1, page_size: 30, has_next: false, view: 'summary' }
  })

  const full = await runCli(['games', 'list', '--full', '--format', 'json'], { env })
  assert.equal(JSON.parse(full.stdout).meta.view, 'full')
  assert.equal(JSON.parse(full.stdout).data[0].unknown_server_field, undefined)
  assert.equal(JSON.parse(full.stdout).data[0].internal_notes, undefined)

  const rejected = await runCli(['games', 'list', '--fields', 'unknown_server_field,missing', '--format', 'json'], { env })
  assert.equal(rejected.code, 2)
  assert.equal(JSON.parse(rejected.stderr).error.code, 'INVALID_INPUT')
  assert.deepEqual(JSON.parse(rejected.stderr).error.details.unknown_fields, ['unknown_server_field', 'missing'])

  const selected = await runCli(['games', 'list', '--fields', 'title', '--format', 'json'], { env })
  assert.deepEqual(JSON.parse(selected.stdout).data, [{ type: 'games', id: 'game-1', title: 'Example' }])
  assert.equal(JSON.parse(selected.stdout).meta.view, 'selected')

  // --raw remains the explicit troubleshooting escape hatch for the original
  // backend document, including undocumented fields.
  const raw = await runCli(['games', 'list', '--raw', '--format', 'json'], { env })
  assert.equal(JSON.parse(raw.stdout).data[0].attributes.internal_notes, 'private detail')
  assert.equal(JSON.parse(raw.stdout).data[0].attributes.unknown_server_field, 42)

  for (const args of [
    ['games', 'list', '--full', '--fields', 'title'],
    ['games', 'list', '--raw', '--full'],
    ['games', 'list', '--raw', '--fields', 'title']
  ]) {
    const result = await runCli([...args, '--format', 'json'], { env })
    assert.equal(result.code, 2)
    assert.equal(JSON.parse(result.stderr).error.code, 'INVALID_INPUT')
  }
})

void test('resource commands use the expected routes, normalized output, and mutation bodies', async t => {
  const observedBodies: Array<Record<string, unknown>> = []
  // The test server callback intentionally owns its async request lifecycle.
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  const { env } = await apiHarness(t, async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer test-token')
    assert.match(req.headers['user-agent'] ?? '', /^poki-cli\//)

    if (req.method === 'POST' && req.url === '/games/game-1/player_fit_tests') {
      observedBodies.push(await requestBody(req))
      jsonApi(res, { data: { type: 'player_fit_tests', id: 'fit-1', attributes: { target_gameplays: 500 } } }, 201)
      return
    }
    if (req.method === 'GET' && req.url !== undefined && req.url.startsWith('/games/game-1/playtest-recordings?')) {
      jsonApi(res, {
        data: [{
          type: 'playtest_recordings',
          id: 'recording-1',
          attributes: {
            duration: 30,
            backend_only: 'preserved in raw output',
            video_url: 'https://backend.invalid/wrong.webm',
            metadata_json_url: 'https://backend.invalid/wrong.json'
          }
        }],
        meta: { total: 1, backend_only: 'preserved in raw output' }
      })
      return
    }
    res.writeHead(404)
    res.end()
  }, 'api')

  const fit = await runCli(['player-fit-tests', 'create', '--game', 'game-1', '--version', 'version-1', '--format', 'json'], { env })
  assert.equal(fit.code, 0, fit.stderr)
  const fitDocument = observedBodies[0] as unknown as { data: { attributes: Record<string, unknown> } }
  assert.equal(fitDocument.data.attributes.target_gameplays, 500)
  assert.equal(fitDocument.data.attributes.version_id, 'version-1')
  assert.equal(fitDocument.data.attributes.device_category, 'any')
  for (const field of ['device_categories', 'test_version', 'target_count']) {
    assert.equal(fitDocument.data.attributes[field], undefined, field)
  }

  const videoUrl = 'https://storage.googleapis.com/poki-playtest-recordings/recording-1.webm'
  const metadataJsonUrl = 'https://storage.googleapis.com/poki-playtest-recordings/recording-1.json'

  const recordings = await runCli(['playtest-recordings', 'list', '--game', 'game-1', '--format', 'json'], { env })
  assert.equal(recordings.code, 0, recordings.stderr)
  const recordingsDocument = JSON.parse(recordings.stdout)
  assert.equal(recordingsDocument.data[0].video_url, videoUrl)
  assert.equal(recordingsDocument.data[0].metadata_json_url, metadataJsonUrl)
  assert.equal(recordingsDocument.data[0].backend_only, undefined)
  assert.equal(recordingsDocument.meta.view, 'summary')

  const selectedRecordings = await runCli(['playtest-recordings', 'list', '--game', 'game-1', '--fields', 'video_url,metadata_json_url', '--format', 'json'], { env })
  assert.equal(selectedRecordings.code, 0, selectedRecordings.stderr)
  assert.deepEqual(JSON.parse(selectedRecordings.stdout).data, [{
    type: 'playtest_recordings',
    id: 'recording-1',
    video_url: videoUrl,
    metadata_json_url: metadataJsonUrl
  }])

  const rawRecordings = await runCli(['playtest-recordings', 'list', '--game', 'game-1', '--raw', '--format', 'json'], { env })
  assert.equal(rawRecordings.code, 0, rawRecordings.stderr)
  const rawRecordingsDocument = JSON.parse(rawRecordings.stdout)
  assert.equal(rawRecordingsDocument.data[0].attributes.video_url, videoUrl)
  assert.equal(rawRecordingsDocument.data[0].attributes.metadata_json_url, metadataJsonUrl)
  assert.equal(rawRecordingsDocument.data[0].attributes.backend_only, 'preserved in raw output')
  assert.equal(rawRecordingsDocument.meta.backend_only, 'preserved in raw output')

  const recording = await runCli(['playtest-recordings', 'get', 'recording-1', '--game', 'game-1', '--format', 'json'], { env })
  assert.equal(recording.code, 0, recording.stderr)
  const recordingData = JSON.parse(recording.stdout).data
  assert.equal(recordingData.video_url, videoUrl)
  assert.equal(recordingData.metadata_json_url, metadataJsonUrl)

  const rawRecording = await runCli(['playtest-recordings', 'get', 'recording-1', '--game', 'game-1', '--raw', '--format', 'json'], { env })
  assert.equal(rawRecording.code, 0, rawRecording.stderr)
  const rawRecordingDocument = JSON.parse(rawRecording.stdout)
  assert.equal(rawRecordingDocument.data[0].attributes.video_url, videoUrl)
  assert.equal(rawRecordingDocument.data[0].attributes.metadata_json_url, metadataJsonUrl)
  assert.equal(rawRecordingDocument.data[0].attributes.backend_only, 'preserved in raw output')
  assert.equal(rawRecordingDocument.meta.backend_only, 'preserved in raw output')

  const missing = await runCli(['playtest-recordings', 'get', 'missing-recording', '--game', 'game-1', '--format', 'json'], { env })
  assert.equal(missing.code, 4)
  assert.equal((JSON.parse(missing.stderr) as { error: { code: string, status: number } }).error.code, 'NOT_FOUND')
  assert.equal((JSON.parse(missing.stderr) as { error: { code: string, status: number } }).error.status, 404)
})

void test('raw Playtest reads add asset URLs when the backend attributes container is malformed', async t => {
  const malformedRecordings = [
    { type: 'playtest_recordings', id: 'recording-with-null-attributes', attributes: null },
    { type: 'playtest_recordings', id: 'recording-with-array-attributes', attributes: ['malformed'] }
  ]
  const { env } = await apiHarness(t, (req, res) => {
    req.resume()
    jsonApi(res, { data: malformedRecordings })
  }, 'raw-recording-assets')

  for (const command of [
    ['playtest-recordings', 'list', '--game', 'game-1', '--raw', '--format', 'json'],
    ['playtest-recordings', 'get', 'recording-with-null-attributes', '--game', 'game-1', '--raw', '--format', 'json']
  ]) {
    const result = await runCli(command, { env })
    assert.equal(result.code, 0, result.stderr)
    for (const recording of JSON.parse(result.stdout).data as Array<{ id: string, attributes: Record<string, unknown> }>) {
      assert.deepEqual(recording.attributes, {
        video_url: `https://storage.googleapis.com/poki-playtest-recordings/${recording.id}.webm`,
        metadata_json_url: `https://storage.googleapis.com/poki-playtest-recordings/${recording.id}.json`
      })
    }
  }
})

function gameWithPlaytestRequests (gameId = 'game-1'): Record<string, unknown> {
  return {
    data: {
      type: 'games',
      id: gameId,
      attributes: { thumbnail_url: 'https://example.invalid/thumbnail.png' },
      relationships: {
        versions: {
          data: [
            { type: 'game_versions', id: 'version-1' },
            { type: 'game_versions', id: 'version-2' }
          ]
        },
        playtest_requests: {
          data: [
            { type: 'playtest_requests', id: 'request-1' },
            { type: 'playtest_requests', id: 'request-2' }
          ]
        }
      }
    },
    included: [
      { type: 'game_versions', id: 'version-1', attributes: { game_id: 'game-1' } },
      { type: 'game_versions', id: 'version-2', attributes: { game_id: 'game-1' } },
      {
        type: 'playtest_requests',
        id: 'request-1',
        attributes: {
          game_id: gameId,
          version_id: 'version-1',
          recordings: 3,
          mobile_target: 4,
          desktop_target: 3,
          tablet_target: 3,
          mobile_finished: 2,
          desktop_finished: 2,
          tablet_finished: 1,
          device_categories: ['mobile', 'desktop', 'tablet'],
          categories: '',
          orientation: 'both',
          new_users_only: false,
          normal_tile: false
        }
      },
      {
        type: 'playtest_requests',
        id: 'request-2',
        attributes: {
          game_id: gameId,
          version_id: 'version-2',
          recordings: 1,
          pending: 0,
          device_categories: ['mobile'],
          categories: '',
          orientation: 'portrait',
          new_users_only: false,
          normal_tile: false
        }
      }
    ]
  }
}

// One command table, executed once with the project-configured game and once
// with an explicit --game flag, pins the game-scoped developer routes and the
// filter and sort encoding for both game resolution modes.
void test('game-scoped commands route via the project game by default and via explicit --game', async t => {
  const directory = temporaryDirectory(t, 'routes')
  const project = join(directory, 'project')
  mkdirSync(project)
  writeFileSync(join(project, 'poki.json'), JSON.stringify({
    game_id: 'game-1',
    build_dir: 'dist'
  }))

  const observed: Array<{ method: string, path: string, query: URLSearchParams }> = []
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    observed.push({ method: req.method ?? '', path: url.pathname, query: url.searchParams })

    if (req.method === 'GET' && url.pathname === '/games/game-1') {
      jsonApi(res, gameWithPlaytestRequests())
      return
    }
    if (req.method === 'DELETE' && url.pathname.startsWith('/games/game-1/playtest-requests/')) {
      res.writeHead(202)
      res.end()
      return
    }
    if (req.method === 'PATCH' && url.pathname === '/games/game-1/versions/version-1') {
      jsonApi(res, { data: { type: 'game_versions', id: 'version-1', attributes: { notes: 'Updated' } } })
      return
    }
    if (req.method === 'POST' && url.pathname === '/games/game-1/playtest-requests') {
      jsonApi(res, { data: { type: 'playtest_requests', id: 'new-request', attributes: {} } }, 201)
      return
    }
    if (req.method === 'POST' && url.pathname === '/games/game-1/player_fit_tests') {
      jsonApi(res, { data: { type: 'player_fit_tests', id: 'new-fit-test', attributes: { target_gameplays: 500 } } }, 201)
      return
    }
    if (req.method === 'GET' && url.pathname === '/games/game-1/playtest-recordings') {
      jsonApi(res, { data: [{ type: 'playtest_recordings', id: 'recording-1', attributes: {} }], meta: { total: 1 } })
      return
    }
    if (req.method === 'GET' && url.pathname === '/games/game-1/player_fit_tests') {
      jsonApi(res, { data: [{ type: 'player_fit_tests', id: 'fit-1', attributes: {} }], meta: { total: 1 } })
      return
    }
    if (req.method === 'GET' && url.pathname === '/games/game-1/netlib/lobbies') {
      jsonApi(res, { data: [{ type: 'lobbies', id: 'game-1:ROOM', attributes: { code: 'ROOM', peer_count: 4, ghosts: 1, public: true } }], meta: { total: 1 } })
      return
    }
    if (req.method === 'GET' && url.pathname === '/games/game-1/versions') {
      jsonApi(res, { data: [{ type: 'game_versions', id: 'version-1', attributes: {} }], meta: { total: 1 } })
      return
    }
    if (req.method === 'GET' && url.pathname === '/games/game-1/change_requests') {
      jsonApi(res, { data: [{ type: 'game_change_requests', id: 'R1', attributes: { status: 'pending' } }], meta: { total: 1 } })
      return
    }
    if (req.method === 'POST' && url.pathname === '/games/game-1/change_requests') {
      jsonApi(res, { data: { type: 'game_change_requests', id: 'new-request', attributes: { title: 'New title here' } } }, 201)
      return
    }
    if (req.method === 'GET' && url.pathname === '/games/game-1/game_events') {
      jsonApi(res, { data: [{ type: 'game_events', id: 'E1', attributes: {} }], meta: { total: 1 } })
      return
    }
    if (req.method === 'PATCH' && url.pathname === '/games/game-1/game_events/E1') {
      jsonApi(res, { data: { type: 'game_events', id: 'E1', attributes: { description: 'x' } } })
      return
    }
    if (req.method === 'GET' && url.pathname === '/games/game-1/game_event_funnels') {
      jsonApi(res, { data: [{ type: 'game_event_funnels', id: 'F1', attributes: {} }], meta: { total: 1 } })
      return
    }
    if (req.method === 'GET' && url.pathname === '/games/game-1/game_event_funnels/F1') {
      jsonApi(res, { data: { type: 'game_event_funnels', id: 'F1', attributes: { title: 'T' } } })
      return
    }
    if (req.method === 'POST' && url.pathname === '/games/game-1/game_event_funnels') {
      jsonApi(res, { data: { type: 'game_event_funnels', id: 'new-funnel', attributes: {} } }, 201)
      return
    }
    if (req.method === 'PATCH' && url.pathname === '/games/game-1/game_event_funnels/F1') {
      jsonApi(res, { data: { type: 'game_event_funnels', id: 'F1', attributes: {} } })
      return
    }
    if (req.method === 'GET' && url.pathname === '/games/game-1/versions/V1/reviews/R1') {
      jsonApi(res, { data: { type: 'reviews', id: 'R1', attributes: { status: 'pending' } } })
      return
    }
    if (req.method === 'PATCH' && url.pathname === '/games/game-1/versions/V1/reviews/R1') {
      jsonApi(res, { data: { type: 'reviews', id: 'R1', attributes: { seen_by_developer: true } } })
      return
    }
    if (req.method === 'GET' && url.pathname === '/games/game-1/versions/V1/files') {
      jsonApi(res, { data: [{ type: 'game_version_files', id: 'file-1', attributes: { filename: 'index.html' } }], meta: { total: 1 } })
      return
    }
    if (req.method === 'POST' && url.pathname === '/games/game-1/versions/V1/_unarchive') {
      jsonApi(res, { data: { type: 'game_versions', id: 'V1', attributes: {} } })
      return
    }
    if (req.method === 'PATCH' && url.pathname === '/games/game-1/playtest-recordings/R1') {
      res.writeHead(204)
      res.end()
      return
    }
    // The recording action endpoints legitimately return an empty body; the
    // CLI synthesizes the confirmation output.
    if (req.method === 'POST' && /^\/games\/game-1\/playtest-recordings\/R1\/@(archive|unarchive|watch)$/.test(url.pathname)) {
      res.writeHead(204)
      res.end()
      return
    }
    res.writeHead(404)
    res.end()
  })
  const env = authEnvironment(join(directory, 'config'), await listen(t, server))

  // `scoped: false` marks commands that address the game positionally and
  // therefore take no --game flag; they run identically in both modes.
  const commands: Array<{ args: string[], scoped?: false }> = [
    { args: ['games', 'get', 'game-1'], scoped: false },
    { args: ['versions', 'list', '--archived', 'archived', '--sort', '-created_at'] },
    { args: ['versions', 'update', 'version-1', '--notes', 'Updated'] },
    { args: ['playtest-recordings', 'list', '--version', 'version-1', '--archived', 'all'] },
    { args: ['playtest-recordings', 'get', 'recording-1'] },
    { args: ['playtest-requests', 'create', '--version', 'version-1'] },
    { args: ['playtest-requests', 'list'] },
    { args: ['playtest-requests', 'cancel', 'request-to-cancel', '--yes'] },
    { args: ['playtest-requests', 'replace', 'request-1', '--orientation', 'portrait', '--yes'] },
    { args: ['player-fit-tests', 'list'] },
    { args: ['player-fit-tests', 'get', 'fit-1'] },
    { args: ['player-fit-tests', 'create', '--version', 'version-1'] },
    { args: ['netlib-lobbies', 'list', '--filter', 'public=true', '--sort', '-created_at'] },
    { args: ['game-change-requests', 'list'] },
    { args: ['game-change-requests', 'get', 'R1'] },
    { args: ['game-change-requests', 'create', '--title', 'New title here'] },
    { args: ['game-events', 'list'] },
    { args: ['game-events', 'update', 'E1', '--description', 'x'] },
    { args: ['game-event-funnels', 'list'] },
    { args: ['game-event-funnels', 'get', 'F1'] },
    { args: ['game-event-funnels', 'create', '--title', 'T', '--event', 'a^b^c'] },
    { args: ['game-event-funnels', 'update', 'F1', '--event', 'a^b^'] },
    { args: ['reviews', 'get', 'V1', 'R1'] },
    { args: ['reviews', 'update', 'V1', 'R1', '--seen'] },
    { args: ['versions', 'files', 'V1'] },
    { args: ['versions', 'unarchive', 'V1'] },
    { args: ['playtest-recordings', 'archive', 'R1'] },
    { args: ['playtest-recordings', 'unarchive', 'R1'] },
    { args: ['playtest-recordings', 'watch', 'R1'] },
    { args: ['playtest-recordings', 'skip-assessment', 'R1', '--yes'] }
  ]

  for (const mode of ['project-default', 'explicit'] as const) {
    observed.length = 0
    for (const { args, scoped } of commands) {
      const full = mode === 'explicit' && scoped !== false ? [...args, '--game', 'game-1'] : args
      const options = mode === 'project-default' ? { cwd: project, env } : { env }
      const result = await runCli([...full, '--format', 'json'], options)
      assert.equal(result.code, 0, `${mode} ${args.join(' ')}: ${result.stderr}`)
      assert.doesNotThrow(() => JSON.parse(result.stdout), `${mode} ${args.join(' ')}`)
    }

    assert.ok(observed.length >= commands.length, mode)
    const routeNames = observed.map(request => `${request.method} ${request.path}`)
    assert.ok(observed.every(request => request.path.startsWith('/games/game-1')), `${mode}:\n${routeNames.join('\n')}`)
    for (const route of [
      'GET /games/game-1',
      'GET /games/game-1/versions',
      'PATCH /games/game-1/versions/version-1',
      'GET /games/game-1/playtest-recordings',
      'GET /games/game-1/player_fit_tests',
      'POST /games/game-1/player_fit_tests',
      'GET /games/game-1/netlib/lobbies',
      'POST /games/game-1/playtest-requests',
      'DELETE /games/game-1/playtest-requests/request-to-cancel',
      'GET /games/game-1/change_requests',
      'POST /games/game-1/change_requests',
      'GET /games/game-1/game_events',
      'PATCH /games/game-1/game_events/E1',
      'GET /games/game-1/game_event_funnels',
      'GET /games/game-1/game_event_funnels/F1',
      'POST /games/game-1/game_event_funnels',
      'PATCH /games/game-1/game_event_funnels/F1',
      'GET /games/game-1/versions/V1/reviews/R1',
      'PATCH /games/game-1/versions/V1/reviews/R1',
      'GET /games/game-1/versions/V1/files',
      'POST /games/game-1/versions/V1/_unarchive',
      'POST /games/game-1/playtest-recordings/R1/@archive',
      'POST /games/game-1/playtest-recordings/R1/@unarchive',
      'POST /games/game-1/playtest-recordings/R1/@watch',
      'PATCH /games/game-1/playtest-recordings/R1'
    ]) assert.ok(routeNames.includes(route), `${mode}: ${route}`)

    const versions = observed.find(request => request.method === 'GET' && request.path.endsWith('/versions'))
    assert.equal(versions?.query.get('filter[archived_at]'), 'not:null', mode)
    assert.equal(versions?.query.get('sort'), '-created_at', mode)
    const recordings = observed.find(request => request.path.endsWith('/playtest-recordings'))
    assert.equal(recordings?.query.get('filter[version_id]'), 'version-1', mode)
    const fit = observed.find(request => request.path.endsWith('/player_fit_tests') && request.query.has('filter[id]'))
    assert.equal(fit?.query.get('filter[id]'), 'fit-1', mode)
    const netlib = observed.find(request => request.path.endsWith('/netlib/lobbies'))
    assert.equal(netlib?.query.get('filter[public]'), 'true', mode)
    assert.equal(netlib?.query.get('sort'), '-created_at', mode)
    // The singular change-request read is emulated by filtering the game
    // collection on the requested ID.
    const changeRequest = observed.find(request => request.path.endsWith('/change_requests') && request.query.has('filter[id]'))
    assert.equal(changeRequest?.query.get('filter[id]'), 'R1', mode)
  }
})

void test('mutation adapters build constrained JSON:API documents and enforce developer-editable game fields', async t => {
  const bodies = new Map<string, Record<string, unknown>>()
  let gameReads = 0
  let mutationRequests = 0
  // The test server callback intentionally owns its async request lifecycle.
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  const { env } = await apiHarness(t, async (req, res) => {
    if (req.method === 'GET' && req.url === '/games/game-1') {
      gameReads++
      jsonApi(res, { data: { type: 'games', id: 'game-1', attributes: { annotations: { engine: 'unity', license_fee: 'no' } } } })
      return
    }
    if (req.method === 'POST' || req.method === 'PATCH') {
      mutationRequests++
      bodies.set(`${req.method} ${req.url ?? ''}`, await requestBody(req))
      const type = req.url?.includes('versions') === true
        ? 'game_versions'
        : req.url?.includes('playtest-requests') === true
          ? 'playtest_requests'
          : 'games'
      const id = type === 'games'
        ? 'game-1'
        : type === 'game_versions' && req.method === 'PATCH'
          ? req.url?.split('/').at(-1)
          : `${type}-1`
      jsonApi(res, { data: { type, id, attributes: {} } }, req.method === 'POST' ? 201 : 200)
      return
    }
    res.writeHead(404)
    res.end()
  }, 'mutations')

  const update = await runCli(['games', 'update', 'game-1', '--engine', 'phaser-3', '--format', 'json'], { env })
  assert.equal(update.code, 0, update.stderr)
  const gameUpdate = bodies.get('PATCH /games/game-1') as unknown as { data: { attributes: { annotations: Record<string, string> } } }
  assert.deepEqual(gameUpdate.data.attributes.annotations, { engine: 'phaser-3' })
  assert.equal(gameReads, 0, 'annotation updates rely on the server preservation contract and need no GET')

  for (const args of [
    ['--annotation', 'exclusivity=exclusive'],
    ['--title', 'Rejected title'],
    ['--thumbnail', 'rejected-thumbnail'],
    ['--data', '{"annotations":{"exclusivity":"exclusive"}}'],
    ['--data', '{"annotations":{}}'],
    ['--data', '{"title":"Rejected title"}']
  ]) {
    const before = mutationRequests
    const rejected = await runCli(['games', 'update', 'game-1', ...args, '--format', 'json'], { env })
    assert.equal(rejected.code, 2, `${args.join(' ')}: ${rejected.stderr}`)
    assert.equal(JSON.parse(rejected.stderr).error.code, 'INVALID_INPUT')
    assert.equal(mutationRequests, before, args.join(' '))
  }

  const developerUpdate = await runCli([
    'games', 'update', 'game-1', '--data',
    '{"privacy_policy_url":"https://example.com/privacy","suggested_description":"Updated"}',
    '--format', 'json'
  ], { env })
  assert.equal(developerUpdate.code, 0, developerUpdate.stderr)
  const developerGameUpdate = bodies.get('PATCH /games/game-1') as unknown as { data: { attributes: Record<string, unknown> } }
  assert.equal(developerGameUpdate.data.attributes.privacy_policy_url, 'https://example.com/privacy')
  assert.equal(developerGameUpdate.data.attributes.suggested_description, 'Updated')

  const categoryUpdate = await runCli([
    'games', 'update', 'game-1',
    '--suggested-category', 'Racing Games',
    '--suggested-category', 'Battleship Games',
    '--format', 'json'
  ], { env })
  assert.equal(categoryUpdate.code, 0, categoryUpdate.stderr)
  const categoryGameUpdate = bodies.get('PATCH /games/game-1') as unknown as { data: { attributes: Record<string, unknown> } }
  assert.equal(categoryGameUpdate.data.attributes.suggested_categories, 'Racing Games,Battleship Games')

  const adminUpdate = await runCli([
    'games', 'update', 'game-1', '--data', '{"approved":true}', '--format', 'json'
  ], { env })
  assert.equal(adminUpdate.code, 2)
  assert.match(JSON.parse(adminUpdate.stderr).error.message, /Unsupported field: approved/)

  const version = await runCli(['versions', 'update', 'version-1', '--game', 'game-1', '--notes', 'Release notes', '--format', 'json'], { env })
  assert.equal(version.code, 0, version.stderr)
  const versionUpdate = bodies.get('PATCH /games/game-1/versions/version-1') as unknown as { data: { type: string, id: string, attributes: Record<string, unknown> } }
  assert.deepEqual(versionUpdate.data, {
    type: 'game_versions',
    id: 'version-1',
    attributes: { notes: 'Release notes' }
  })

  const request = await runCli(['playtest-requests', 'create', '--game', 'game-1', '--version', 'version-1', '--format', 'json'], { env })
  assert.equal(request.code, 0, request.stderr)
  const requestDocument = bodies.get('POST /games/game-1/playtest-requests') as unknown as { data: { attributes: Record<string, unknown> } }
  assert.deepEqual(requestDocument.data.attributes, {
    recordings: 10,
    device_categories: ['mobile', 'desktop', 'tablet'],
    orientation: 'both',
    categories: '',
    new_users_only: false,
    normal_tile: false,
    game_id: 'game-1',
    version_id: 'version-1'
  })

  bodies.delete('POST /games/game-1/playtest-requests')
  const missingThumbnail = await runCli(['playtest-requests', 'create', '--game', 'game-1', '--version', 'version-1', '--normal-tile', '--format', 'json'], { env })
  assert.equal(missingThumbnail.code, 2)
  assert.match((JSON.parse(missingThumbnail.stderr) as { error: { message: string } }).error.message, /thumbnail/)
  assert.equal(bodies.has('POST /games/game-1/playtest-requests'), false)
})

void test('normal-tile creation validates the raw game identity before trusting thumbnail state', async t => {
  const operations: string[] = []
  const { env } = await apiHarness(t, (req, res) => {
    operations.push(`${req.method ?? ''} ${req.url ?? ''}`)
    jsonApi(res, {
      data: {
        type: 'games',
        id: 'other-game',
        attributes: { thumbnail_url: 'wrong-game-thumbnail-secret' }
      }
    })
  }, 'normal-tile-game-identity')
  const args = ['playtest-requests', 'create', '--game', 'game-1', '--version', 'version-1', '--normal-tile', '--format', 'json']

  const preview = await runCli([...args, '--dry-run'], { env })
  assert.equal(preview.code, 0, preview.stderr)
  assert.equal(operations.length, 0)

  const result = await runCli([...args, '--raw'], { env })
  assert.equal(result.code, 5, result.stderr)
  assert.equal(result.stdout, '')
  assert.deepEqual(operations, ['GET /games/game-1'])
  assert.equal(JSON.parse(result.stderr).error.code, 'INVALID_API_RESPONSE')
  assert.doesNotMatch(result.stderr, /wrong-game-thumbnail-secret|other-game/)
})

void test('admin-only hidden playtest request input is rejected locally', async t => {
  let requests = 0
  const { env } = await apiHarness(t, (_req, res) => {
    requests++
    res.writeHead(500)
    res.end()
  }, 'hidden')

  const removedFlag = await runCli([
    'playtest-requests', 'create', '--game', 'game-1', '--version', 'version-1', '--hidden', '--format', 'json'
  ], { env })
  assert.equal(removedFlag.code, 2)
  assert.match(JSON.parse(removedFlag.stderr).error.message, /Unknown argument: --hidden/)

  const rejectedData = await runCli([
    'playtest-requests', 'create', '--game', 'game-1', '--version', 'version-1', '--data', '{"hidden":true}', '--format', 'json'
  ], { env })
  assert.equal(rejectedData.code, 2)
  assert.match(JSON.parse(rejectedData.stderr).error.message, /Unsupported field: hidden/)
  assert.equal(requests, 0)
})

void test('playtest recording tag updates validate locally and synthesize output for empty PATCH responses', async t => {
  let requests = 0
  let patchBody: Record<string, unknown> | undefined
  // The test server callback intentionally owns its async request lifecycle.
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  const { env } = await apiHarness(t, async (req, res) => {
    requests++
    if (req.method === 'PATCH' && req.url === '/games/game-1/playtest-recordings/R1') {
      patchBody = await requestBody(req)
      res.writeHead(204)
      res.end()
      return
    }
    res.writeHead(404)
    res.end()
  }, 'recording-tags')

  const conflicting = await runCli(['playtest-recordings', 'update', 'R1', '--game', 'game-1', '--tag', 'a', '--clear-tags', '--format', 'json'], { env })
  assert.equal(conflicting.code, 2)
  assert.match(JSON.parse(conflicting.stderr).error.message, /--clear-tags cannot be combined with --tag or --data/)

  const noInput = await runCli(['playtest-recordings', 'update', 'R1', '--game', 'game-1', '--format', 'json'], { env })
  assert.equal(noInput.code, 2)
  const noInputError = JSON.parse(noInput.stderr).error
  assert.equal(noInputError.code, 'INVALID_INPUT')
  assert.deepEqual(noInputError.details, { accepted_inputs: ['--tag NAME', '--clear-tags', '--data @tags.json'] })

  const emptyTag = await runCli(['playtest-recordings', 'update', 'R1', '--game', 'game-1', '--data', '{"tags":["ok",""]}', '--format', 'json'], { env })
  assert.equal(emptyTag.code, 2)
  assert.match(JSON.parse(emptyTag.stderr).error.message, /non-empty strings/)

  // yargs parses a valueless --tag as an empty array, which would otherwise
  // PATCH tags: [] and wipe the list without the explicit --clear-tags gate.
  for (const args of [['--tag'], ['--tag', '--yes']]) {
    const bareTag = await runCli(['playtest-recordings', 'update', 'R1', '--game', 'game-1', ...args, '--format', 'json'], { env })
    assert.equal(bareTag.code, 2)
    const bareTagError = JSON.parse(bareTag.stderr).error
    assert.equal(bareTagError.code, 'INVALID_INPUT')
    assert.match(bareTagError.message, /--tag requires a tag name; use --clear-tags/)
    assert.deepEqual(bareTagError.details, { accepted_inputs: ['--tag NAME', '--clear-tags'] })
  }

  assert.equal(requests, 0)

  // The recording PATCH endpoint returns an empty body, so the CLI must
  // synthesize the resulting tag list itself.
  const updated = await runCli(['playtest-recordings', 'update', 'R1', '--game', 'game-1', '--tag', 'a', '--tag', 'b', '--format', 'json'], { env })
  assert.equal(updated.code, 0, updated.stderr)
  assert.deepEqual(JSON.parse(updated.stdout), { data: { id: 'R1', tags: ['a', 'b'] }, meta: {} })
  assert.equal(requests, 1)
  assert.deepEqual((patchBody as unknown as { data: unknown }).data, {
    type: 'playtest_recordings',
    id: 'R1',
    attributes: { tags: ['a', 'b'] }
  })

  const skipped = await runCli(['playtest-recordings', 'skip-assessment', 'R1', '--game', 'game-1', '--yes', '--format', 'json'], { env })
  assert.equal(skipped.code, 0, skipped.stderr)
  assert.deepEqual(JSON.parse(skipped.stdout), { data: { id: 'R1', tags: [], skipped_assessment: true }, meta: {} })
  assert.equal(requests, 2)
  assert.deepEqual((patchBody as unknown as { data: unknown }).data, {
    type: 'playtest_recordings',
    id: 'R1',
    attributes: { tags: [], skipped_assessment: true }
  })

  const rawUpdate = await runCli(['playtest-recordings', 'update', 'R1', '--game', 'game-1', '--tag', 'raw', '--raw', '--format', 'json'], { env })
  assert.equal(rawUpdate.code, 0, rawUpdate.stderr)
  assert.equal(rawUpdate.stdout, 'null\n')
  assert.equal(requests, 3)

  const rawSkipped = await runCli(['playtest-recordings', 'skip-assessment', 'R1', '--game', 'game-1', '--yes', '--raw', '--format', 'json'], { env })
  assert.equal(rawSkipped.code, 0, rawSkipped.stderr)
  assert.equal(rawSkipped.stdout, 'null\n')
  assert.equal(requests, 4)
})

void test('--dry-run previews the resolved mutation without contacting the API', async t => {
  let requests = 0
  const { directory, env } = await apiHarness(t, (_req, res) => {
    requests++
    res.writeHead(500)
    res.end()
  }, 'dry-run')

  const update = await runCli(['games', 'update', 'game-1', '--engine', 'unity', '--dry-run', '--format', 'json'], { env })
  assert.equal(update.code, 0, update.stderr)
  assert.equal(update.stderr, '')
  const preview = JSON.parse(update.stdout)
  assert.deepEqual(preview, {
    dry_run: true,
    contacted_api: false,
    validation: {
      scope: 'local_input_only',
      local_input_validated: true,
      backend_mutation_validated: false,
      mutation_permissions_validated: false,
      resource_state_validated: false
    },
    executable: 'unknown',
    request: {
      method: 'PATCH',
      path: '/games/game-1',
      body: {
        data: {
          type: 'games',
          attributes: { annotations: { engine: 'unity' } },
          id: 'game-1'
        }
      }
    },
    risk: 'mutation',
    destructive: false,
    non_atomic: false,
    side_effects: preview.side_effects
  })
  assert.ok(Array.isArray(preview.side_effects) && preview.side_effects.length > 0)

  const shortUnicodeTitle = await runCli(['game-change-requests', 'create', '--game', 'game-1', '--title', '😀😀', '--dry-run', '--format', 'json'], { env })
  assert.equal(shortUnicodeTitle.code, 0, shortUnicodeTitle.stderr)

  const unicodeTitle = await runCli(['game-change-requests', 'create', '--game', 'game-1', '--title', '😀😀😀', '--dry-run', '--format', 'json'], { env })
  assert.equal(unicodeTitle.code, 0, unicodeTitle.stderr)

  const thumbnailPath = join(directory, 'thumbnail.png')
  writeFileSync(thumbnailPath, 'thumbnail bytes')
  const thumbnail = await runCli(['game-change-requests', 'create', '--game', 'game-1', '--thumbnail-file', thumbnailPath, '--dry-run', '--format', 'json'], { env })
  assert.equal(thumbnail.code, 0, thumbnail.stderr)
  const thumbnailPreview = JSON.parse(thumbnail.stdout).request.body.data.attributes.thumbnail
  assert.deepEqual(thumbnailPreview, {
    encoding: 'base64',
    source_file: thumbnailPath,
    source_bytes: 15,
    encoded_characters: 20,
    value_omitted: true
  })
  assert.doesNotMatch(thumbnail.stdout, /dGh1bWJuYWlsIGJ5dGVz/)

  const funnel = await runCli([
    'game-event-funnels', 'create', '--game', 'game-1', '--title', 'Tutorial',
    '--event', 'progress^tutorial^start',
    '--event', 'progress^tutorial^complete',
    '--dry-run', '--format', 'json'
  ], { env })
  assert.equal(funnel.code, 0, funnel.stderr)
  assert.deepEqual(JSON.parse(funnel.stdout).request, {
    method: 'POST',
    path: '/games/game-1/game_event_funnels',
    body: {
      data: {
        type: 'game_event_funnels',
        attributes: {
          title: 'Tutorial',
          events: [
            'progress^tutorial^start',
            'progress^tutorial^complete'
          ]
        }
      }
    }
  })

  const funnelFromData = await runCli([
    'game-event-funnels', 'update', 'funnel-1', '--game', 'game-1',
    '--data', '{"events":["progress^tutorial^"]}',
    '--dry-run', '--format', 'json'
  ], { env })
  assert.equal(funnelFromData.code, 0, funnelFromData.stderr)
  assert.deepEqual(JSON.parse(funnelFromData.stdout).request.body.data.attributes.events, [
    'progress^tutorial^'
  ])

  const reservedSeparator = await runCli([
    'game-events', 'create', '--game', 'game-1', '--category', 'progress^chapter', '--action', 'tutorial', '--description', 'Invalid', '--dry-run', '--format', 'json'
  ], { env })
  assert.equal(reservedSeparator.code, 0, reservedSeparator.stderr)

  const unicodeEvent = await runCli([
    'game-events', 'create', '--game', 'game-1', '--category', '😀'.repeat(16), '--action', 'tutorial', '--description', 'Valid', '--dry-run', '--format', 'json'
  ], { env })
  assert.equal(unicodeEvent.code, 0, unicodeEvent.stderr)

  const longUnicodeEvent = await runCli([
    'game-events', 'create', '--game', 'game-1', '--category', '😀'.repeat(16) + 'é', '--action', 'tutorial', '--description', 'Invalid', '--dry-run', '--format', 'json'
  ], { env })
  assert.equal(longUnicodeEvent.code, 0, longUnicodeEvent.stderr)

  const zeroWidthEvent = await runCli([
    'game-events', 'create', '--game', 'game-1', '--category', 'pro\u200Bgress', '--action', 'tutorial', '--description', 'Invalid', '--dry-run', '--format', 'json'
  ], { env })
  assert.equal(zeroWidthEvent.code, 0, zeroWidthEvent.stderr)

  for (const field of ['category', 'action', 'label']) {
    for (const input of [[`--${field}`, 'renamed'], ['--data', JSON.stringify({ [field]: 'renamed' })]]) {
      const result = await runCli(['game-events', 'update', 'event-1', '--game', 'game-1', ...input, '--format', 'json'], { env })
      assert.equal(result.code, 2, result.stdout)
    }
  }

  for (const data of [
    { category: 'level1', action: 'step2', label: 'attempt3' },
    { category: 'level{N}', action: 'step{n}', label: 'attempt3' },
    { category: 'a'.repeat(62) + '1', action: 'start' }
  ]) {
    for (const input of [Object.entries(data).flatMap(([field, value]) => [`--${field}`, value]).concat(['--description', 'Track progress']), ['--data', JSON.stringify({ ...data, description: 'Track progress' })]]) {
      const result = await runCli(['game-events', 'create', '--game', 'game-1', ...input, '--dry-run', '--format', 'json'], { env })
      assert.equal(result.code, 0, result.stderr)
      assert.deepEqual(JSON.parse(result.stdout).request.body.data.attributes, { ...data, description: 'Track progress' })
    }
  }

  for (const category of ['a'.repeat(61) + '1', 'level' + '1'.repeat(70)]) {
    const result = await runCli([
      'game-events', 'create', '--game', 'game-1', '--category', category,
      '--action', ' step{N} ', '--label', ' COMPLETE ', '--description', 'Track progress',
      '--dry-run', '--format', 'json'
    ], { env })
    assert.equal(result.code, 0, result.stderr)
    const attributes = JSON.parse(result.stdout).request.body.data.attributes
    assert.equal(attributes.category, category)
    assert.equal(attributes.action, ' step{N} ')
    assert.equal(attributes.label, ' COMPLETE ')
  }

  const metadataUpdate = await runCli([
    'game-events', 'update', 'event-1', '--game', 'game-1',
    '--data', '{"description":"Updated","enabled":false,"include_in_funnel":true}',
    '--dry-run', '--format', 'json'
  ], { env })
  assert.equal(metadataUpdate.code, 0, metadataUpdate.stderr)
  assert.deepEqual(JSON.parse(metadataUpdate.stdout).request.body.data.attributes, {
    description: 'Updated', enabled: false, include_in_funnel: true
  })

  assert.equal(requests, 0)
})

void test('per-group local validation rejects bad input before any HTTP request', async t => {
  let requests = 0
  const { env } = await apiHarness(t, (_req, res) => {
    requests++
    res.writeHead(500)
    res.end()
  }, 'local-validation')

  const failures: Array<{ args: string[], message: RegExp }> = [
    { args: ['game-events', 'create', '--game', 'game-1', '--category', 'progress', '--action', 'what'], message: /description must be a string/ },
    { args: ['reviews', 'request', '--game', 'game-1', '--version', 'version-1'], message: /developer_notes is required/ },
    { args: ['versions', 'update', 'version-1', '--game', 'game-1', '--label', 'x'.repeat(257)], message: /label must contain at most 256 UTF-8 bytes/ }
  ]
  for (const { args, message } of failures) {
    const result = await runCli([...args, '--format', 'json'], { env })
    assert.equal(result.code, 2, `${args.join(' ')}: ${result.stderr}`)
    assert.equal(result.stdout, '', args.join(' '))
    const error = JSON.parse(result.stderr).error
    assert.equal(error.code, 'INVALID_INPUT', args.join(' '))
    assert.match(error.message, message, args.join(' '))
  }

  const validated = await runCli([
    'data', 'query', '--query', '{"from":"dbt_p4d_gameplays","select":[{"field":"gameplays"}]}',
    '--validate-only', '--format', 'json'
  ], { env })
  assert.equal(validated.code, 0, validated.stderr)
  const validation = JSON.parse(validated.stdout)
  assert.equal(validation.local_structure_valid, true)
  assert.equal(validation.api_validated, false)
  assert.equal(validation.executable, 'unknown')
  assert.equal(validation.valid, undefined)
  assert.equal(validation.meta.contacted_api, false)

  assert.equal(requests, 0)
})

void test('playtest request replacement validates then cancels and recreates with merged settings', async t => {
  const operations: string[] = []
  let replacementBody: Record<string, unknown> | undefined
  const rawReplacementResponse = {
    data: {
      type: 'playtest_requests',
      id: 'replacement-1',
      attributes: { recordings: 5, orientation: 'portrait', backend_private_note: 'raw-only' }
    },
    meta: { backend_request_marker: 'replace-1' }
  }
  // The test server callback intentionally owns its async request lifecycle.
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  const { env } = await apiHarness(t, async (req, res) => {
    operations.push(`${req.method ?? ''} ${req.url ?? ''}`)
    if (req.method === 'GET' && req.url === '/games/game-1') {
      jsonApi(res, gameWithPlaytestRequests())
      return
    }
    if (req.method === 'DELETE' && req.url === '/games/game-1/playtest-requests/request-1') {
      res.writeHead(202)
      res.end()
      return
    }
    if (req.method === 'POST' && req.url === '/games/game-1/playtest-requests') {
      replacementBody = await requestBody(req)
      jsonApi(res, rawReplacementResponse, 201)
      return
    }
    res.writeHead(404)
    res.end()
  }, 'request-edit')

  for (const input of [
    ['--category', '1'.repeat(513)],
    ['--data', JSON.stringify({ categories: Array(257).fill('1').join(',') })]
  ]) {
    const rejected = await runCli(['playtest-requests', 'replace', 'request-1', '--game', 'game-1', ...input, '--yes', '--format', 'json'], { env })
    assert.equal(rejected.code, 2, rejected.stderr)
    assert.match(JSON.parse(rejected.stderr).error.message, /512 characters/)
    assert.deepEqual(operations, ['GET /games/game-1'])
    operations.length = 0
  }

  const preview = await runCli(['playtest-requests', 'replace', 'request-1', '--game', 'game-1', '--orientation', 'portrait', '--dry-run', '--format', 'json'], { env })
  assert.equal(preview.code, 0, preview.stderr)
  assert.deepEqual(operations, ['GET /games/game-1'])
  const previewDocument = JSON.parse(preview.stdout)
  assert.equal(previewDocument.dry_run, true)
  assert.equal(previewDocument.contacted_api, true)
  assert.equal(previewDocument.validation.scope, 'local_input_and_current_resource_state')
  assert.equal(previewDocument.validation.resource_state_validated, true)
  assert.equal(previewDocument.validation.backend_mutation_validated, false)
  assert.equal(previewDocument.validation.mutation_permissions_validated, false)
  assert.equal(previewDocument.executable, 'unknown')
  assert.deepEqual(previewDocument.requests.map((request: { method: string }) => request.method), ['DELETE', 'POST'])
  operations.length = 0

  const result = await runCli(['playtest-requests', 'replace', 'request-1', '--game', 'game-1', '--orientation', 'portrait', '--yes', '--format', 'json'], { env })
  assert.equal(result.code, 0, result.stderr)
  assert.deepEqual(operations, [
    'GET /games/game-1',
    'DELETE /games/game-1/playtest-requests/request-1',
    'POST /games/game-1/playtest-requests'
  ])
  const attributes = (replacementBody as unknown as { data: { attributes: Record<string, unknown> } }).data.attributes
  assert.equal(attributes.recordings, 5)
  assert.deepEqual(attributes.device_categories, ['mobile', 'desktop', 'tablet'])
  assert.equal(attributes.device_category, undefined)
  assert.equal(attributes.version_id, 'version-1')
  assert.equal(attributes.orientation, 'portrait')
  assert.deepEqual(JSON.parse(result.stdout), {
    data: {
      cancelled_request_id: 'request-1',
      replacement: { type: 'playtest_requests', id: 'replacement-1', recordings: 5, orientation: 'portrait' },
      atomic: false
    },
    meta: {}
  })

  operations.length = 0
  const rawResult = await runCli([
    'playtest-requests', 'replace', 'request-1', '--game', 'game-1',
    '--orientation', 'portrait', '--yes', '--raw', '--format', 'json'
  ], { env })
  assert.equal(rawResult.code, 0, rawResult.stderr)
  assert.deepEqual(operations, [
    'GET /games/game-1',
    'DELETE /games/game-1/playtest-requests/request-1',
    'POST /games/game-1/playtest-requests'
  ])
  assert.deepEqual(JSON.parse(rawResult.stdout), rawReplacementResponse)
})

void test('playtest request replacement validates the raw game identity before cancellation', async t => {
  const operations: string[] = []
  const { env } = await apiHarness(t, (req, res) => {
    operations.push(`${req.method ?? ''} ${req.url ?? ''}`)
    jsonApi(res, gameWithPlaytestRequests('other-game'))
  }, 'request-replace-game-identity')

  const result = await runCli([
    'playtest-requests', 'replace', 'request-1', '--game', 'game-1', '--recordings', '4',
    '--yes', '--raw', '--format', 'json'
  ], { env })
  assert.equal(result.code, 5, result.stderr)
  assert.equal(result.stdout, '')
  assert.deepEqual(operations, ['GET /games/game-1'])
  assert.equal(JSON.parse(result.stderr).error.code, 'INVALID_API_RESPONSE')
  assert.doesNotMatch(result.stderr, /other-game/)
})

void test('playtest request replacement preserves recovery when cancellation outcome is uncertain', async t => {
  const scenarios = [
    { name: 'timeout', expectedCause: 'API_TIMEOUT' },
    { name: 'server-failure', expectedCause: 'UNAVAILABLE' },
    { name: 'malformed-success', expectedCause: 'INVALID_API_RESPONSE' }
  ] as const

  for (const scenario of scenarios) {
    let posts = 0
    let deletes = 0
    const { env } = await apiHarness(t, (req, res) => {
      if (req.method === 'GET') {
        jsonApi(res, gameWithPlaytestRequests())
        return
      }
      if (req.method === 'POST') {
        posts++
        jsonApi(res, { data: { type: 'playtest_requests', id: 'must-not-be-created' } }, 201)
        return
      }
      deletes++
      if (scenario.name === 'timeout') {
        setTimeout(() => {
          res.writeHead(202)
          res.end()
        }, 1000)
        return
      }
      if (scenario.name === 'server-failure') {
        jsonApi(res, {
          errors: [{ code: 'unavailable', title: 'Temporarily unavailable', meta: { secret: 'per-error-secret' } }],
          meta: { secret: 'document-secret' }
        }, 503)
        return
      }
      jsonApi(res, { data: 42, private_secret: 'malformed-secret' }, 202)
    }, `request-cancel-${scenario.name}`)

    const result = await runCli([
      'playtest-requests', 'replace', 'request-1', '--game', 'game-1', '--recordings', '4',
      // Leave enough time for the preflight GET under parallel test load;
      // the DELETE delay remains well beyond this request deadline.
      '--yes', '--timeout-ms', '250', '--format', 'json'
    ], { env })
    assert.equal(result.code, 5, `${scenario.name}: ${result.stderr}`)
    assert.equal(result.stdout, '')
    assert.equal(deletes, 1)
    assert.equal(posts, 0)
    assert.doesNotMatch(result.stderr, /per-error-secret|document-secret|malformed-secret/)

    const error = JSON.parse(result.stderr).error
    assert.equal(error.code, 'PLAYTEST_REQUEST_REPLACEMENT_CANCELLATION_FAILED')
    assert.equal(error.retryable, false)
    assert.equal(error.details.original_request_id, 'request-1')
    assert.equal(error.details.cancellation_state, 'unknown')
    assert.equal(error.details.replacement_creation_state, 'not_attempted')
    assert.equal(error.details.resolved_replacement.game_id, 'game-1')
    assert.equal(error.details.resolved_replacement.version_id, 'version-1')
    assert.equal(error.details.resolved_replacement.data.recordings, 4)
    assert.equal(error.details.cause.code, scenario.expectedCause)
    assert.equal(error.details.recovery.inspect_current_state.required_before_next_mutation, true)
    assert.equal(error.details.recovery.retry_replacement.condition, 'only_if_inspection_confirms_the_original_request_is_still_active')
    assert.equal(error.details.recovery.create_replacement.condition, 'only_if_inspection_confirms_the_original_request_is_cancelled_and_no_active_replacement_exists')
    assert.match(error.hint, /Do not replay the DELETE or create a replacement blindly/)
  }
})

void test('playtest request replacement requires state inspection after an uncertain POST failure', async t => {
  const { env } = await apiHarness(t, (req, res) => {
    if (req.method === 'GET') {
      jsonApi(res, gameWithPlaytestRequests())
      return
    }
    if (req.method === 'DELETE') {
      res.writeHead(202)
      res.end()
      return
    }
    jsonApi(res, { errors: [{ code: 'unavailable', title: 'Temporarily unavailable' }] }, 503)
  }, 'request-partial')

  const result = await runCli(['playtest-requests', 'replace', 'request-1', '--game', 'game-1', '--recordings', '4', '--yes', '--format', 'json'], { env })
  assert.equal(result.code, 5)
  assert.equal(result.stdout, '')
  const error = JSON.parse(result.stderr).error
  assert.equal(error.code, 'PLAYTEST_REQUEST_REPLACEMENT_FAILED')
  assert.equal(error.status, 503)
  assert.equal(error.details.cancelled_request_id, 'request-1')
  assert.equal(error.details.replacement_creation_state, 'unknown')
  assert.equal(error.details.replacement_not_created, undefined)
  assert.equal(error.details.recovery.inspect_current_state.required_before_create, true)
  assert.deepEqual(error.details.recovery.inspect_current_state.arguments, [
    'playtest-requests', 'list', '--game', 'game-1', '--format', 'json'
  ])
  assert.equal(error.details.recovery.create_replacement.condition, 'only_after_inspection_confirms_no_active_replacement')
  assert.equal(error.details.recovery.retry_payload.game, 'game-1')
  assert.equal(error.details.recovery.retry_payload.version, 'version-1')
  assert.equal(error.details.recovery.retry_payload.data.recordings, 4)
  assert.match(error.hint, /inspect current request state before any create attempt/i)
})

void test('playtest request replacement reports a definite 4xx rejection and executable recovery', async t => {
  let postAttempts = 0
  let deletes = 0
  const { env } = await apiHarness(t, (req, res) => {
    if (req.method === 'GET') {
      jsonApi(res, gameWithPlaytestRequests())
      return
    }
    if (req.method === 'DELETE') {
      deletes++
      res.writeHead(202)
      res.end()
      return
    }
    postAttempts++
    if (postAttempts === 1) {
      jsonApi(res, { errors: [{ code: 'permission-denied', title: 'Permission denied' }] }, 403)
      return
    }
    jsonApi(res, { data: { type: 'playtest_requests', id: 'recovered-request', attributes: { recordings: 4 } } }, 201)
  }, 'request-rejected')

  const result = await runCli(['playtest-requests', 'replace', 'request-1', '--game', 'game-1', '--recordings', '4', '--yes', '--format', 'json'], { env })
  assert.equal(result.code, 4)
  const error = JSON.parse(result.stderr).error
  assert.equal(error.code, 'PLAYTEST_REQUEST_REPLACEMENT_FAILED')
  assert.equal(error.status, 403)
  assert.equal(error.details.replacement_creation_state, 'not_created')
  assert.equal(error.details.replacement_not_created, true)
  assert.equal(error.details.recovery.inspect_current_state.required_before_create, false)
  assert.equal(error.details.recovery.create_replacement.condition, 'after_correcting_the_rejection_cause')

  const retryArguments = error.details.recovery.create_replacement.arguments as string[]
  const retried = await runCli(retryArguments, { env })
  assert.equal(retried.code, 0, retried.stderr)
  assert.equal(JSON.parse(retried.stdout).data.id, 'recovered-request')
  assert.equal(deletes, 1)
  assert.equal(postAttempts, 2)
})

void test('playtest request replacement treats a malformed successful response as outcome unknown', async t => {
  const { env } = await apiHarness(t, (req, res) => {
    if (req.method === 'GET') {
      jsonApi(res, gameWithPlaytestRequests())
      return
    }
    if (req.method === 'DELETE') {
      res.writeHead(202)
      res.end()
      return
    }
    jsonApi(res, null, 201)
  }, 'request-invalid-success')

  const result = await runCli(['playtest-requests', 'replace', 'request-1', '--game', 'game-1', '--recordings', '4', '--yes', '--format', 'json'], { env })
  assert.equal(result.code, 5)
  const error = JSON.parse(result.stderr).error
  assert.equal(error.code, 'PLAYTEST_REQUEST_REPLACEMENT_FAILED')
  assert.equal(error.status, 201)
  assert.equal(error.details.replacement_creation_state, 'unknown')
  assert.equal(error.details.recovery.inspect_current_state.required_before_create, true)
  assert.deepEqual(error.details.cause, {
    code: 'INVALID_API_RESPONSE',
    message: 'The replacement response did not contain one playtest request resource.',
    status: 201,
    retryable: false,
    hint: 'The replacement POST may already have committed. Inspect current request state and do not replay it blindly.'
  })
  assert.equal(error.details.cause.response, undefined)
})

void test('playtest-requests list keeps listing requests when an unrelated game attribute is unreadable', async t => {
  const { env } = await apiHarness(t, (req, res) => {
    const game = gameWithPlaytestRequests()
    const data = game.data as { attributes: Record<string, unknown> }
    // The CLI requires annotations.engine to be a string. That one unreadable
    // value must not turn an active request into "no active requests".
    data.attributes.annotations = { engine: 5 }
    jsonApi(res, game)
  }, 'request-list-degraded')

  const result = await runCli(['playtest-requests', 'list', '--game', 'game-1', '--format', 'json'], { env })
  assert.equal(result.code, 0, result.stderr)
  const document = JSON.parse(result.stdout)
  assert.deepEqual(document.data.map((request: { id: string }) => request.id), ['request-1', 'request-2'])
  assert.equal(document.meta.total, 2)
  assert.deepEqual(document.meta.unreadable_fields, [{ type: 'games', id: 'game-1', fields: ['annotations'] }])
})

void test('playtest-requests list fails closed instead of reporting an unreadable member as an empty list', async t => {
  const scenarios = [
    {
      name: 'wrong-type request linkage',
      relationships: { playtest_requests: { data: [{ type: 'teams', id: 'unreadable-request-secret' }] } },
      attributes: {}
    },
    {
      name: 'requests in the wrong JSON:API member',
      attributes: { playtest_requests: [{ type: 'playtest_requests', id: 'unreadable-request-secret' }] }
    },
    {
      name: 'malformed relationships container',
      attributes: {},
      relationships: 'unreadable-request-secret'
    }
  ]

  for (const scenario of scenarios) {
    await t.test(scenario.name, async t => {
      const { env } = await apiHarness(t, (req, res) => {
        jsonApi(res, {
          data: {
            type: 'games',
            id: 'game-1',
            attributes: scenario.attributes,
            ...(scenario.relationships === undefined ? {} : { relationships: scenario.relationships })
          }
        })
      }, 'request-list-unreadable')

      const result = await runCli(['playtest-requests', 'list', '--game', 'game-1', '--format', 'json'], { env })
      assert.equal(result.code, 5, result.stdout)
      assert.equal(result.stdout, '')
      const error = JSON.parse(result.stderr).error
      assert.equal(error.code, 'INVALID_API_RESPONSE')
      assert.deepEqual(error.details.unreadable_fields, ['playtest_requests'])
      assert.doesNotMatch(result.stderr, /unreadable-request-secret/)
    })
  }
})

void test('game-change-requests get --raw returns the filtered backend document unchanged', async t => {
  let requests = 0
  const { env } = await apiHarness(t, (req, res) => {
    requests++
    const url = new URL(req.url ?? '/', 'http://localhost')
    assert.equal(url.pathname, '/games/g/change_requests')
    assert.equal(url.searchParams.get('filter[id]'), 'R1')
    jsonApi(res, { data: [{ type: 'game_change_requests', id: 'R1', attributes: { status: 'pending' } }], meta: { total: 1 } })
  }, 'gcr-raw')

  const result = await runCli(['game-change-requests', 'get', 'R1', '--game', 'g', '--raw', '--format', 'json'], { env })
  assert.equal(result.code, 0, result.stderr)
  const body = JSON.parse(result.stdout)
  assert.deepEqual(body.data[0].attributes, { status: 'pending' })
  assert.equal(body.meta.total, 1)
  assert.equal(requests, 1)
})

void test('game creation always directs users to the manual workflow without contacting the API', async t => {
  let requests = 0
  const { env } = await apiHarness(t, (_req, res) => {
    requests++
    res.writeHead(500)
    res.end()
  }, 'manual-game-creation')

  for (const args of [
    [],
    ['--title', 'Example', '--team', 'team-1'],
    ['--title', 'X', '--team', 'team-1', '--dry-run'],
    ['--data', '@missing-game.json'],
    ['--data', '-'],
    ['--data', '{invalid json', '--yes', '--raw'],
    ['--thumbnail', 'old-input']
  ]) {
    const result = await runCli(['games', 'create', ...args, '--format', 'json'], { env })
    assert.equal(result.code, 2, result.stderr)
    assert.equal(result.stdout, '')
    const error = JSON.parse(result.stderr).error
    assert.equal(error.code, 'GAME_CREATION_UNSUPPORTED', `${args.join(' ')}: ${result.stderr}`)
    assert.match(error.message, /New games can ONLY be created manually in Poki for Developers/)
    assert.equal(error.retryable, false)
  }
  assert.equal(requests, 0)
})

void test('Player Fit creation uses the current API audience and target fields', async () => {
  const args = ['player-fit-tests', 'create', '--game', 'game-1', '--version', 'version-1', '--dry-run', '--format', 'json']
  for (const device of ['any', 'desktop', 'mobile']) {
    for (const input of [['--device-category', device], ['--data', JSON.stringify({ device_category: device })]]) {
      const result = await runCli([...args, ...input])
      assert.equal(result.code, 0, result.stderr)
      const attributes = JSON.parse(result.stdout).request.body.data.attributes
      assert.equal(attributes.device_category, device)
      assert.equal(attributes.target_gameplays, 500)
      for (const field of ['device_categories', 'test_version', 'target_count']) {
        assert.equal(attributes[field], undefined, field)
      }
    }
  }
  for (const input of [
    ['--device-category', 'tablet'],
    ['--device-category', 'mobile', '--device-category', 'desktop'],
    ['--test-version', '2'],
    ...[{ device_categories: ['mobile'] }, { test_version: 1 }, { target_count: 500 }, { target_gameplays: 1000 }, { device_category: ['mobile'] }].map(data => ['--data', JSON.stringify(data)])
  ]) {
    const result = await runCli([...args, ...input])
    assert.equal(result.code, 2, result.stdout)
  }
})

void test('playtest creation maps legacy flags to device arrays and accepts explicit selections', async () => {
  const args = ['playtest-requests', 'create', '--game', 'game-1', '--version', 'version-1', '--new-users-only', 'true', '--normal-tile', 'false', '--format', 'json', '--dry-run']
  for (const device of ['any', 'mobile', 'desktop', 'tablet']) {
    const result = await runCli([...args, '--device-category', device])
    assert.equal(result.code, 0, result.stderr)
    const attributes = JSON.parse(result.stdout).request.body.data.attributes
    assert.deepEqual(attributes.device_categories, device === 'any' ? ['mobile', 'desktop', 'tablet'] : [device])
    assert.equal(attributes.device_category, undefined)
    assert.equal(attributes.new_users_only, true)
  }
  const selected = await runCli([...args.slice(0, 6), '--data', JSON.stringify({ device_categories: ['mobile', 'tablet'] }), '--format', 'json', '--dry-run'])
  assert.equal(selected.code, 0, selected.stderr)
  assert.deepEqual(JSON.parse(selected.stdout).request.body.data.attributes.device_categories, ['mobile', 'tablet'])
  for (const devices of [[], ['any'], ['mobile', 'mobile'], 'mobile']) {
    const result = await runCli(['playtest-requests', 'create', '--game', 'game-1', '--version', 'version-1', '--data', JSON.stringify({ device_categories: devices }), '--format', 'json', '--dry-run'])
    assert.equal(result.code, 2, result.stdout)
  }
})

void test('mutation text limits accept Unicode boundaries and reject oversized flags and data before requests', async t => {
  let requests = 0
  const { directory, env } = await apiHarness(t, (_req, res) => {
    requests++
    res.writeHead(500)
    res.end()
  }, 'mutation-text-limits')
  const build = join(directory, 'build')
  mkdirSync(build)
  writeFileSync(join(build, 'index.html'), '<!doctype html>')
  const notes = '😀'.repeat(16383) + 'abc'
  const oversizedNotes = '😀'.repeat(16384)
  const cases = [
    { command: ['versions', 'update', 'v'], flag: '--label', field: 'label', valid: 'é'.repeat(128), invalid: 'é'.repeat(129), limit: '256 UTF-8 bytes' },
    {
      command: ['player-feedback-questions', 'create'],
      flag: '--question',
      field: 'question',
      base: { start_date: '2026-10-01', end_date: '2026-10-02', feedback_message_types: ['bugreport'] },
      valid: 'é'.repeat(5000),
      invalid: 'é'.repeat(5001),
      limit: '10000 UTF-8 bytes'
    },
    { command: ['playtest-requests', 'create', '--version', 'v'], flag: '--category', field: 'categories', valid: '1'.repeat(512), invalid: '1'.repeat(513), limit: '512 characters' },
    { command: ['player-fit-tests', 'create', '--version', 'v'], flag: '--category', field: 'categories', valid: '1'.repeat(512), invalid: '1'.repeat(513), limit: '512 characters' },
    { command: ['games', 'update', 'g'], flag: '--suggested-description', field: 'suggested_description', valid: notes, invalid: oversizedNotes, limit: '65535 UTF-8 bytes' },
    { command: ['games', 'update', 'g'], flag: '--suggested-category', field: 'suggested_categories', valid: notes, invalid: oversizedNotes, limit: '65535 UTF-8 bytes' },
    ...[
      ['play-store-url', 'play_store_url', 'https://play.google.com/store/apps/details?id=app&x='],
      ['apple-store-url', 'apple_store_url', 'https://apps.apple.com/app/id1?x='],
      ['steam-url', 'steam_url', 'https://store.steampowered.com/app/1/?x=']
    ].map(([flag, field, prefix]) => ({
      command: ['game-change-requests', 'create'],
      flag: `--${flag}`,
      field,
      valid: prefix + '😀'.repeat(2000 - prefix.length),
      invalid: prefix + '😀'.repeat(2001 - prefix.length),
      limit: '2000 characters'
    })),
    { command: ['versions', 'update', 'v'], flag: '--filename', field: 'filename', valid: '😀'.repeat(128), invalid: '😀'.repeat(129), limit: '128 characters' },
    { command: ['versions', 'update', 'v'], flag: '--notes', field: 'notes', valid: notes, invalid: oversizedNotes, limit: '65535 UTF-8 bytes' },
    { command: ['versions', 'upload', '--build-dir', build], flag: '--notes', field: undefined, valid: notes, invalid: oversizedNotes, limit: '65535 UTF-8 bytes' },
    { command: ['reviews', 'request', '--version', 'v'], flag: '--developer-notes', field: 'developer_notes', valid: notes, invalid: oversizedNotes, limit: '65535 UTF-8 bytes' },
    { command: ['reviews', 'update', 'v', 'r'], flag: '--developer-notes', field: 'developer_notes', valid: notes, invalid: oversizedNotes, limit: '65535 UTF-8 bytes' },
    { command: ['playtest-recordings', 'update', 'r'], flag: '--tag', field: 'tags', valid: '  ' + '😀'.repeat(255) + '  ', invalid: '  ' + '😀'.repeat(256) + '  ', limit: '255 characters' }
  ]
  for (const entry of cases) {
    for (const useData of entry.field === undefined ? [false] : [false, true]) {
      const base = 'base' in entry ? entry.base : undefined
      const baseFlags = Object.entries(base ?? {}).filter(([field]) => field !== entry.field).flatMap(([field, value]) => [
        field === 'feedback_message_types' ? '--message-type' : `--${field.replaceAll('_', '-')}`,
        ...(Array.isArray(value) ? value : [value])
      ])
      const input = (value: string): string[] => useData
        ? ['--data', JSON.stringify({ ...base, [entry.field ?? 'notes']: entry.field === 'tags' ? [value] : value })]
        : [...baseFlags, entry.flag, value]
      const args = [...entry.command, '--game', 'g', '--format', 'json']
      const accepted = await runCli([...args, ...input(entry.valid), '--dry-run'], { env })
      assert.equal(accepted.code, 0, accepted.stderr)
      for (const mode of [[], ['--dry-run']]) {
        const rejected = await runCli([...args, ...input(entry.invalid), ...mode], { env })
        assert.equal(rejected.code, 2, rejected.stderr)
        const error = JSON.parse(rejected.stderr).error
        assert.equal(error.code, 'INVALID_INPUT')
        assert.ok(error.message.includes(entry.limit), error.message)
      }
    }
  }
  assert.equal(requests, 0)
})

void test('CSP syntax and normalization are delegated to the backend', async t => {
  const received: unknown[] = []
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  const { env } = await apiHarness(t, async (req, res) => {
    received.push(await requestBody(req))
    res.writeHead(422, { 'Content-Type': 'application/vnd.api+json' })
    res.end(JSON.stringify({ errors: [{ code: 'payload-validation-failed', detail: 'custom_content_security_policy is invalid: must be a valid Content-Security-Policy header value' }] }))
  }, 'csp-validation')
  for (const value of ['  img-src example.com ; ', 'future-directive value']) {
    const args = ['game-change-requests', 'create', '--game', 'g', '--custom-content-security-policy', value, '--format', 'json']
    const preview = await runCli([...args, '--dry-run'], { env })
    assert.equal(preview.code, 0, preview.stderr)
    assert.equal(JSON.parse(preview.stdout).request.body.data.attributes.custom_content_security_policy, value)
    assert.equal(JSON.parse(preview.stdout).validation.backend_mutation_validated, false)
    const result = await runCli(args, { env })
    assert.equal(result.code, 4, result.stderr)
    assert.match(JSON.parse(result.stderr).error.message, /must be a valid Content-Security-Policy/)
    assert.deepEqual(received.at(-1), JSON.parse(preview.stdout).request.body)
  }
  assert.equal(received.length, 2, 'validation errors must not be retried')
})

void test('Player Fit country limits include commas in repeated flags and data', async t => {
  let requests = 0
  const { env } = await apiHarness(t, (_req, res) => { requests++; res.writeHead(500); res.end() }, 'country-limits')
  const args = ['player-fit-tests', 'create', '--game', 'g', '--version', 'v', '--format', 'json']
  for (const useData of [false, true]) {
    const input = (count: number): string[] => useData
      ? ['--data', JSON.stringify({ countries: Array(count).fill('US').join(',') })]
      : Array.from({ length: count }, () => ['--country', 'US']).flat()
    const accepted = await runCli([...args, ...input(171), '--dry-run'], { env })
    assert.equal(accepted.code, 0, accepted.stderr)
    assert.equal(JSON.parse(accepted.stdout).request.body.data.attributes.countries.length, 512)
    for (const mode of [[], ['--dry-run']]) {
      const rejected = await runCli([...args, ...input(172), ...mode], { env })
      assert.equal(rejected.code, 2, rejected.stderr)
      assert.match(JSON.parse(rejected.stderr).error.message, /512 characters/)
    }
  }
  assert.equal(requests, 0)
})

void test('feedback question dates stay within storage bounds before requests', async t => {
  let requests = 0
  const { env } = await apiHarness(t, (_req, res) => { requests++; res.writeHead(500); res.end() }, 'question-date-limits')
  const args = ['player-feedback-questions', 'create', '--game', 'g', '--format', 'json']
  const input = (start: string | number, end: string | number): string[] => ['--data', JSON.stringify({
    question: 'Why?', start_date: start, end_date: end, feedback_message_types: ['thumbs_up']
  })]
  for (const date of [0, 253402300799, '1000-01-01', '9999-12-31']) {
    const accepted = await runCli([...args, ...input(date, date), '--dry-run'], { env })
    assert.equal(accepted.code, 0, accepted.stderr)
  }
  for (const date of [253402300800, Number.MAX_SAFE_INTEGER + 1, 1e100, -1, 0.5, '0000-01-01', '0999-12-31', '10000-01-01']) {
    for (const mode of [[], ['--dry-run']]) {
      const rejected = await runCli([...args, ...input(date, date), ...mode], { env })
      assert.equal(rejected.code, 2, rejected.stderr)
      assert.equal(JSON.parse(rejected.stderr).error.code, 'INVALID_INPUT')
    }
  }
  const invalidEnd = await runCli([...args, ...input(0, 253402300800)], { env })
  assert.equal(invalidEnd.code, 2, invalidEnd.stderr)
  assert.match(JSON.parse(invalidEnd.stderr).error.message, /end_date/)
  for (const date of ['1000-01-01', '9999-12-31', '0000-01-01']) {
    const result = await runCli([...args, '--question', 'Why?', '--start-date', date, '--end-date', date, '--message-type', 'thumbs_up', '--dry-run'], { env })
    assert.equal(result.code, date === '0000-01-01' ? 2 : 0, result.stderr)
  }
  assert.equal(requests, 0)
})

void test('privacy URL syntax is left to the backend without rewriting input', async () => {
  for (const value of ['https://example.com/privacy', ' https://example.com/privacy ', 'custom://example.com/privacy', 'not a URL']) {
    for (const input of [['--privacy-policy-url', value], ['--data', JSON.stringify({ privacy_policy_url: value })]]) {
      const result = await runCli(['games', 'update', 'g', ...input, '--dry-run', '--format', 'json'])
      assert.equal(result.code, 0, result.stderr)
      assert.equal(JSON.parse(result.stdout).request.body.data.attributes.privacy_policy_url, value)
    }
  }
})

void test('thumbnail data requires standard base64 with backend-compatible padding', async t => {
  let requests = 0
  const { env } = await apiHarness(t, (_req, res) => { requests++; res.writeHead(500); res.end() }, 'thumbnail-base64-validation')
  const args = ['game-change-requests', 'create', '--game', 'g', '--format', 'json']
  const input = (thumbnail: string): string[] => ['--data', JSON.stringify({ thumbnail })]
  // Encoding validation is local; the backend separately validates image bytes.
  for (const value of ['TQ==', 'TWE=', 'TWFu', '+/8=', 'T\r\nQ==\n', 'TR==']) {
    const result = await runCli([...args, ...input(value), '--dry-run'], { env })
    assert.equal(result.code, 0, result.stderr)
  }
  for (const value of ['', '%%%', 'TQ', 'TWE', 'TQ=', 'TQ===', '=TQ=', 'TQ==TWFu', '-_8=', 'T Q==', '\r\n', 'data:image/png;base64,TQ==']) {
    for (const mode of [[], ['--dry-run']]) {
      const result = await runCli([...args, ...input(value), ...mode], { env })
      assert.equal(result.code, 2, result.stderr)
      assert.equal(JSON.parse(result.stderr).error.code, 'INVALID_INPUT')
      assert.match(JSON.parse(result.stderr).error.message, /base64/)
    }
  }
  assert.equal(requests, 0)
})
