import assert from 'node:assert/strict'
import { createServer, ServerResponse } from 'node:http'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { apiHarness, authEnvironment, jsonApi, listen, runCli, temporaryDirectory } from './helpers'

function plainJson (response: ServerResponse, body: unknown, status = 200): void {
  response.writeHead(status, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(body))
}

void test('versions upload posts the zipped build and label as multipart form data', async t => {
  let contentType: string | undefined
  let rawBody = Buffer.alloc(0)
  const { directory, env } = await apiHarness(t, (req, res) => {
    assert.equal(req.method, 'POST')
    assert.equal(req.url, '/games/g/versions')
    assert.equal(req.headers.authorization, 'Bearer test-token')
    contentType = req.headers['content-type']
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      rawBody = Buffer.concat(chunks)
      plainJson(res, {
        id: 'version-9',
        game_id: 'g',
        label: 'L',
        state: 'created',
        internal_secret: 'not-normalized'
      }, 201)
    })
  }, 'versions-upload')
  const build = join(directory, 'build')
  mkdirSync(build)
  writeFileSync(join(build, 'index.html'), '<!doctype html><title>Example</title>')

  const result = await runCli([
    'versions', 'upload', '--game', 'g', '--build-dir', build, '--label', 'L', '--yes', '--format', 'json'
  ], { env })
  assert.equal(result.code, 0, result.stderr)
  assert.match(contentType ?? '', /^multipart\/form-data; boundary=/)
  const body = rawBody.toString('latin1')
  assert.match(body, /Content-Disposition: form-data; name="file"; filename="build.zip"/)
  assert.match(body, /Content-Type: application\/zip/)
  assert.match(body, /Content-Disposition: form-data; name="label"\r\n\r\nL\r\n/)
  // The file part carries the ZIP local file header magic.
  assert.ok(body.includes('PK'))
  const output = JSON.parse(result.stdout)
  assert.equal(output.data.type, 'game_versions')
  assert.equal(output.data.id, 'version-9')
  assert.equal(output.data.game_id, 'g')
  assert.equal(output.data.label, 'L')
  assert.equal(output.data.internal_secret, undefined)
})

void test('versions upload preserves a validated plain response for --raw and accepts JSON:API for forward compatibility', async t => {
  const plain = { id: 'plain-version', game_id: 'g', state: 'created', internal_secret: 'raw-only' }
  let uploads = 0
  const { directory, env } = await apiHarness(t, (req, res) => {
    assert.equal(req.method, 'POST')
    req.resume()
    req.on('end', () => {
      uploads++
      if (uploads === 1) {
        plainJson(res, plain, 201)
        return
      }
      jsonApi(res, {
        data: {
          type: 'game_versions',
          id: 'jsonapi-version',
          attributes: { game_id: 'g', state: 'created', internal_secret: 'not-normalized' }
        }
      }, 201)
    })
  }, 'versions-upload-response-shapes')
  const build = join(directory, 'build')
  mkdirSync(build)
  writeFileSync(join(build, 'index.html'), '<!doctype html>')

  const raw = await runCli([
    'versions', 'upload', '--game', 'g', '--build-dir', build, '--raw', '--format', 'json'
  ], { env })
  assert.equal(raw.code, 0, raw.stderr)
  assert.deepEqual(JSON.parse(raw.stdout), plain)

  const forwardCompatible = await runCli([
    'versions', 'upload', '--game', 'g', '--build-dir', build, '--format', 'json'
  ], { env })
  assert.equal(forwardCompatible.code, 0, forwardCompatible.stderr)
  assert.deepEqual(JSON.parse(forwardCompatible.stdout), {
    data: { type: 'game_versions', id: 'jsonapi-version', game_id: 'g', state: 'created' },
    meta: {}
  })
})

void test('versions upload rejects unusable identity and malformed plain fields before raw rendering', async t => {
  let uploads = 0
  const { directory, env } = await apiHarness(t, (req, res) => {
    assert.equal(req.method, 'POST')
    req.resume()
    req.on('end', () => {
      uploads++
      plainJson(res, uploads === 1
        ? { id: 123, game_id: 'g', state: 'created' }
        : uploads === 2
          ? { id: 'foreign-version', game_id: 'other-game', state: 'created', internal_secret: 'not-raw' }
          : { id: 'malformed-version', game_id: 'g', state: { secret: 'malformed-plain-secret' } }, 201)
    })
  }, 'versions-upload-identity')
  const build = join(directory, 'build')
  mkdirSync(build)
  writeFileSync(join(build, 'index.html'), '<!doctype html>')

  // An unusable ID and a foreign game both make the created resource
  // unidentifiable, so the upload cannot be reported as a success it may not be.
  for (const args of [
    ['versions', 'upload', '--game', 'g', '--build-dir', build, '--format', 'json'],
    ['versions', 'upload', '--game', 'g', '--build-dir', build, '--raw', '--format', 'json']
  ]) {
    const result = await runCli(args, { env })
    assert.equal(result.code, 5, result.stderr)
    assert.equal(result.stdout, '')
    const error = JSON.parse(result.stderr).error
    assert.equal(error.code, 'INVALID_API_RESPONSE')
    assert.equal(error.status, 201)
    assert.equal(error.retryable, false)
    assert.match(error.hint, /may already have committed/i)
    assert.match(error.hint, /do not replay/i)
    assert.doesNotMatch(result.stderr, /foreign-version|other-game|not-raw|malformed-version|malformed-plain-secret/)
  }

  // A malformed unrelated field is not an identity failure. The upload
  // committed with a usable ID, so rejecting it here would tell an agent to
  // inspect-before-replay over a version that was created successfully; --raw
  // returns the untouched backend document either way.
  const degraded = await runCli(['versions', 'upload', '--game', 'g', '--build-dir', build, '--raw', '--format', 'json'], { env })
  assert.equal(degraded.code, 0, degraded.stderr)
  assert.deepEqual(JSON.parse(degraded.stdout), {
    id: 'malformed-version',
    game_id: 'g',
    state: { secret: 'malformed-plain-secret' }
  })
  assert.equal(uploads, 3)
})

void test('versions upload preserves the created version when subsequent polling fails', async t => {
  let uploads = 0
  let polls = 0
  const { directory, env } = await apiHarness(t, (req, res) => {
    if (req.method === 'POST') {
      uploads++
      req.resume()
      req.on('end', () => {
        plainJson(res, { id: 'V', game_id: 'g', state: 'processing' }, 201)
      })
      return
    }
    polls++
    assert.equal(req.method, 'GET')
    assert.equal(req.url, '/versions/V')
    if (polls === 1) {
      jsonApi(res, { errors: [{ code: 'unavailable', title: 'Polling unavailable' }] }, 503)
      return
    }
    jsonApi(res, { data: { type: 'game_versions', id: 'V', attributes: { state: 'done' } } })
  }, 'versions-upload-poll-failure')
  const build = join(directory, 'build')
  mkdirSync(build)
  writeFileSync(join(build, 'index.html'), '<!doctype html>')

  const result = await runCli([
    'versions', 'upload', '--game', 'g', '--build-dir', build,
    '--wait', '--poll-interval-ms', '25', '--wait-timeout-ms', '5000', '--format', 'json'
  ], { env })
  assert.equal(result.code, 5)
  assert.equal(result.stdout, '')
  assert.equal(uploads, 1)
  assert.equal(polls, 1)

  const error = JSON.parse(result.stderr).error
  assert.equal(error.code, 'VERSION_UPLOAD_WAIT_FAILED')
  assert.equal(error.status, 503)
  assert.equal(error.retryable, false)
  assert.equal(error.details.version_created, true)
  assert.equal(error.details.created_version_id, 'V')
  assert.deepEqual(error.details.created_version, { type: 'game_versions', id: 'V', game_id: 'g', state: 'processing' })
  assert.deepEqual(error.details.recovery.resume_poll, {
    action: 'poll_existing_version',
    command: 'poki',
    arguments: [
      'versions', 'get', 'V', '--wait',
      '--poll-interval-ms', '25',
      '--wait-timeout-ms', '5000',
      '--format', 'json'
    ]
  })
  assert.equal(error.details.cause.code, 'UNAVAILABLE')
  assert.equal(error.details.cause.retryable, true)
  assert.match(error.hint, /Do not upload the build again/)

  const resumed = await runCli(error.details.recovery.resume_poll.arguments, { env })
  assert.equal(resumed.code, 0, resumed.stderr)
  assert.equal(JSON.parse(resumed.stdout).data.state, 'done')
  assert.equal(uploads, 1)
  assert.equal(polls, 2)
})

void test('versions activate replaces a single existing track and reports the prior allocation', async t => {
  let requests = 0
  const observed: Array<{ method?: string, path?: string, body?: unknown }> = []
  const previousTracks = [
    { track: 'public', version_id: 'OLD', weight: 100 }
  ]
  // The test server callback intentionally owns its async request lifecycle.
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  const { env } = await apiHarness(t, async (req, res) => {
    requests++
    let body = ''
    for await (const chunk of req) body += String(chunk)
    observed.push({ method: req.method, path: req.url, body: body === '' ? undefined : JSON.parse(body) })
    jsonApi(res, { data: { type: 'games', id: 'g', attributes: { title: 'Example', tracks: previousTracks } } })
  }, 'versions-activate')

  const confirmed = await runCli(['versions', 'activate', 'V', '--game', 'g', '--yes', '--format', 'json'], { env })
  assert.equal(confirmed.code, 0, confirmed.stderr)
  assert.equal(requests, 2)
  assert.deepEqual(observed[0], { method: 'GET', path: '/games/g', body: undefined })
  assert.equal(observed[1]?.method, 'PATCH')
  assert.equal(observed[1]?.path, '/games/g')
  assert.deepEqual(observed[1]?.body, {
    data: {
      type: 'games',
      id: 'g',
      attributes: {
        tracks: [{ track: 'public', version_id: 'V', weight: 100 }]
      }
    }
  })
  assert.deepEqual(JSON.parse(confirmed.stdout).meta.previous_tracks, previousTracks)

  // The dry run stays offline and previews only the public track replacement.
  requests = 0
  const preview = await runCli(['versions', 'activate', 'V', '--game', 'g', '--dry-run', '--format', 'json'], { env })
  assert.equal(preview.code, 0, preview.stderr)
  assert.equal(requests, 0)
  const previewDocument = JSON.parse(preview.stdout)
  assert.equal(previewDocument.dry_run, true)
  assert.equal(previewDocument.non_atomic, true)
  assert.equal(previewDocument.contacted_api, false)
  assert.equal(previewDocument.validation.scope, 'local_input_only')
  assert.equal(previewDocument.validation.resource_state_validated, false)
  assert.equal(previewDocument.executable, 'unknown')
  assert.deepEqual(previewDocument.request.body.data.attributes.tracks, [{ track: 'public', version_id: 'V', weight: 100 }])
})

void test('versions activate treats an omitted tracks attribute as the legitimate empty allocation', async t => {
  const operations: string[] = []
  const { env } = await apiHarness(t, (req, res) => {
    operations.push(`${req.method ?? ''} ${req.url ?? ''}`)
    if (req.method === 'GET') {
      jsonApi(res, { data: { type: 'games', id: 'g', attributes: { title: 'Example' } } })
      return
    }
    jsonApi(res, {
      data: {
        type: 'games',
        id: 'g',
        attributes: { tracks: [{ track: 'public', version_id: 'V', weight: 100 }] }
      }
    })
  }, 'versions-activate-empty-tracks')

  const result = await runCli(['versions', 'activate', 'V', '--game', 'g', '--yes', '--format', 'json'], { env })
  assert.equal(result.code, 0, result.stderr)
  assert.deepEqual(operations, ['GET /games/g', 'PATCH /games/g'])
  assert.deepEqual(JSON.parse(result.stdout).meta.previous_tracks, [])
})

void test('versions activate rejects a wrong game identity or malformed raw game state before PATCH', async t => {
  const scenarios = [
    {
      name: 'wrong game identity',
      response: { data: { type: 'games', id: 'other-game', attributes: { tracks: [], title: 'wrong-game-secret' } } },
      secret: 'wrong-game-secret',
      raw: false
    },
    {
      name: 'malformed tracks',
      response: {
        data: {
          type: 'games',
          id: 'g',
          attributes: {
            tracks: [
              { track: 'public', version_id: 'OLD', weight: 100 },
              { track: 'weighted', version_id: 'OTHER', weight: 'malformed-track-secret' }
            ]
          }
        }
      },
      secret: 'malformed-track-secret',
      raw: true
    },
    {
      name: 'tracks relationship uses the wrong provenance',
      response: {
        data: {
          type: 'games',
          id: 'g',
          attributes: { title: 'Example' },
          relationships: {
            tracks: {
              data: [{ type: 'game_versions', id: 'wrong-source-secret' }]
            }
          }
        }
      },
      secret: 'wrong-source-secret',
      raw: false
    },
    {
      name: 'null relationships container',
      response: {
        data: {
          type: 'games',
          id: 'g',
          relationships: null
        }
      },
      secret: 'null-relationships-secret',
      raw: false
    },
    {
      name: 'array relationships container',
      response: {
        data: {
          type: 'games',
          id: 'g',
          relationships: ['array-relationships-secret']
        }
      },
      secret: 'array-relationships-secret',
      raw: true
    }
  ]

  for (const scenario of scenarios) {
    await t.test(scenario.name, async t => {
      let requests = 0
      const { env } = await apiHarness(t, (req, res) => {
        requests++
        assert.equal(req.method, 'GET')
        assert.equal(req.url, '/games/g')
        jsonApi(res, scenario.response)
      }, 'versions-activate-invalid-preflight')
      const args = ['versions', 'activate', 'V', '--game', 'g', '--yes', ...(scenario.raw ? ['--raw'] : []), '--format', 'json']

      const result = await runCli(args, { env })
      assert.equal(result.code, 5, result.stderr)
      assert.equal(result.stdout, '')
      assert.equal(requests, 1)
      const error = JSON.parse(result.stderr).error
      assert.equal(error.code, 'INVALID_API_RESPONSE')
      assert.doesNotMatch(result.stderr, new RegExp(scenario.secret))
    })
  }
})

void test('versions current fails closed instead of reporting an unreadable allocation as empty', async t => {
  // A malformed known attribute collapses normalized output to identity-only.
  // `versions current` is the mandated post-activation inspection, so reporting
  // tracks: [] here would state an allocation that was never observed.
  const scenarios = [
    {
      name: 'malformed tracks',
      response: {
        data: {
          type: 'games',
          id: 'g',
          attributes: {
            tracks: [{ track: 'public', version_id: 'OLD', weight: 'malformed-track-secret' }]
          }
        }
      },
      secret: 'malformed-track-secret'
    },
    {
      name: 'tracks relationship uses the wrong provenance',
      response: {
        data: {
          type: 'games',
          id: 'g',
          attributes: { title: 'Example' },
          relationships: { tracks: { data: [{ type: 'game_versions', id: 'wrong-source-secret' }] } }
        }
      },
      secret: 'wrong-source-secret'
    },
    {
      name: 'array relationships container',
      response: { data: { type: 'games', id: 'g', relationships: ['array-relationships-secret'] } },
      secret: 'array-relationships-secret'
    }
  ]

  for (const scenario of scenarios) {
    await t.test(scenario.name, async t => {
      const { env } = await apiHarness(t, (req, res) => {
        assert.equal(req.method, 'GET')
        assert.equal(req.url, '/games/g')
        jsonApi(res, scenario.response)
      }, 'versions-current-invalid')

      const result = await runCli(['versions', 'current', '--game', 'g', '--format', 'json'], { env })
      assert.equal(result.code, 5, result.stdout)
      assert.equal(result.stdout, '')
      assert.equal(JSON.parse(result.stderr).error.code, 'INVALID_API_RESPONSE')
      assert.doesNotMatch(result.stderr, new RegExp(scenario.secret))
    })
  }
})

void test('versions current reports a genuinely empty allocation and the public version', async t => {
  const tracks = [{ track: 'public', version_id: 'V1', weight: 100 }]
  const { directory, env } = await apiHarness(t, (req, res) => {
    jsonApi(res, { data: { type: 'games', id: 'g', attributes: { tracks, public_version: 'V1' } } })
  }, 'versions-current-ok')

  const populated = await runCli(['versions', 'current', '--game', 'g', '--format', 'json'], { env })
  assert.equal(populated.code, 0, populated.stderr)
  assert.deepEqual(JSON.parse(populated.stdout).data, { game_id: 'g', public_version: 'V1', tracks })

  const emptyServer = createServer((req, res) => {
    jsonApi(res, { data: { type: 'games', id: 'g', attributes: { title: 'Example' } } })
  })
  const emptyEnv = authEnvironment(directory, await listen(t, emptyServer))
  const empty = await runCli(['versions', 'current', '--game', 'g', '--format', 'json'], { env: emptyEnv })
  assert.equal(empty.code, 0, empty.stderr)
  assert.deepEqual(JSON.parse(empty.stdout).data, { game_id: 'g', tracks: [] })
})

void test('versions activate preserves allocation snapshots when the PATCH outcome is unknown', async t => {
  const previousTracks = [{ track: 'public', version_id: 'OLD', weight: 100 }]
  let patches = 0
  const { env } = await apiHarness(t, (req, res) => {
    if (req.method === 'GET') {
      jsonApi(res, { data: { type: 'games', id: 'g', attributes: { tracks: previousTracks } } })
      return
    }
    patches++
    jsonApi(res, {
      errors: [{ code: 'unavailable', title: 'Unknown outcome', meta: { secret: 'per-error-secret' } }],
      meta: { secret: 'document-secret' }
    }, 503)
  }, 'versions-activate-unknown')

  const result = await runCli(['versions', 'activate', 'NEW', '--game', 'g', '--yes', '--format', 'json'], { env })
  assert.equal(result.code, 5)
  assert.equal(result.stdout, '')
  assert.equal(patches, 1)
  assert.doesNotMatch(result.stderr, /per-error-secret|document-secret/)

  const error = JSON.parse(result.stderr).error
  assert.equal(error.code, 'VERSION_ACTIVATION_OUTCOME_UNKNOWN')
  assert.equal(error.status, 503)
  assert.equal(error.retryable, false)
  assert.equal(error.details.activation_state, 'unknown')
  assert.equal(error.details.game_id, 'g')
  assert.equal(error.details.requested_version_id, 'NEW')
  assert.deepEqual(error.details.previous_tracks, previousTracks)
  assert.deepEqual(error.details.requested_tracks, [{ track: 'public', version_id: 'NEW', weight: 100 }])
  assert.deepEqual(error.details.recovery.inspect_current_allocation.arguments, [
    'versions', 'current', '--game', 'g', '--format', 'json'
  ])
  assert.equal(error.details.recovery.inspect_current_allocation.required_before_next_mutation, true)
  assert.deepEqual(error.details.recovery.restore_previous_allocation, {
    available_via_cli: true,
    condition: 'only_after_inspection_confirms_the_requested_allocation_is_active_and_rollback_is_desired',
    command: 'poki',
    arguments: ['versions', 'activate', 'OLD', '--game', 'g', '--yes', '--format', 'json']
  })
  assert.equal(error.details.cause.code, 'UNAVAILABLE')
  assert.match(error.hint, /Do not replay the activation blindly/)
})

void test('a redirected activation PATCH keeps the full recovery snapshot', async t => {
  const previousTracks = [{ track: 'public', version_id: 'OLD', weight: 100 }]
  let patches = 0
  const { env } = await apiHarness(t, (req, res) => {
    if (req.method === 'GET') {
      jsonApi(res, { data: { type: 'games', id: 'g', attributes: { tracks: previousTracks } } })
      return
    }
    patches++
    // The redirect target is never contacted, so the activation outcome there
    // is unobserved.
    res.writeHead(307, { Location: 'https://redirect-target-secret.invalid/games/g' })
    res.end()
  }, 'versions-activate-redirect')

  const result = await runCli(['versions', 'activate', 'NEW', '--game', 'g', '--yes', '--format', 'json'], { env })
  assert.equal(result.code, 4)
  assert.equal(result.stdout, '')
  assert.equal(patches, 1)
  assert.doesNotMatch(result.stderr, /redirect-target-secret/)

  const error = JSON.parse(result.stderr).error
  assert.equal(error.code, 'VERSION_ACTIVATION_OUTCOME_UNKNOWN')
  assert.equal(error.status, 307)
  assert.equal(error.retryable, false)
  assert.equal(error.details.activation_state, 'unknown')
  assert.deepEqual(error.details.previous_tracks, previousTracks)
  assert.deepEqual(error.details.requested_tracks, [{ track: 'public', version_id: 'NEW', weight: 100 }])
  assert.deepEqual(error.details.recovery.inspect_current_allocation.arguments, [
    'versions', 'current', '--game', 'g', '--format', 'json'
  ])
  assert.equal(error.details.recovery.inspect_current_allocation.required_before_next_mutation, true)
  assert.deepEqual(error.details.recovery.restore_previous_allocation.arguments, [
    'versions', 'activate', 'OLD', '--game', 'g', '--yes', '--format', 'json'
  ])
  assert.equal(error.details.cause.code, 'HTTP_307')
  assert.match(error.hint, /Do not replay the activation blindly/)
})

void test('versions activate rejects multiple existing tracks before sending a PATCH', async t => {
  let requests = 0
  const tracks = [
    { track: 'weighted', version_id: 'W', weight: 100 },
    { track: 'public', version_id: 'OLD', weight: 100 }
  ]
  const { env } = await apiHarness(t, (req, res) => {
    requests++
    assert.equal(req.method, 'GET')
    assert.equal(req.url, '/games/g')
    jsonApi(res, { data: { type: 'games', id: 'g', attributes: { title: 'Example', tracks } } })
  }, 'versions-multiple-tracks')

  const result = await runCli(['versions', 'activate', 'V', '--game', 'g', '--yes', '--format', 'json'], { env })
  assert.equal(result.code, 4)
  assert.equal(result.stdout, '')
  assert.equal(requests, 1)
  const error = JSON.parse(result.stderr).error
  assert.equal(error.code, 'ACTIVE_VERSION_MULTIPLE_TRACKS')
  assert.equal(error.status, 409)
  assert.deepEqual(error.details, { game_id: 'g', track_count: 2, tracks })
})

void test('versions archive needs no confirmation and renders the null-body fallback', async t => {
  const { env } = await apiHarness(t, (req, res) => {
    assert.equal(req.method, 'POST')
    assert.equal(req.url, '/games/g/versions/V/_archive')
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end('null')
  }, 'versions-archive')

  const result = await runCli(['versions', 'archive', 'V', '--game', 'g', '--format', 'json'], { env })
  assert.equal(result.code, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), {
    data: { type: 'game_versions', id: 'V', action: 'archived' },
    meta: {}
  })
})

void test('versions upload --dry-run performs zero requests', async t => {
  let requests = 0
  const { directory, env } = await apiHarness(t, (_req, res) => {
    requests++
    res.writeHead(500)
    res.end()
  }, 'versions-dry-run')
  const build = join(directory, 'build')
  mkdirSync(build)
  writeFileSync(join(build, 'index.html'), '<!doctype html>')

  const result = await runCli([
    'versions', 'upload', '--game', 'g', '--build-dir', build, '--label', 'L', '--dry-run', '--format', 'json'
  ], { env })
  assert.equal(result.code, 0, result.stderr)
  const preview = JSON.parse(result.stdout)
  assert.equal(preview.dry_run, true)
  assert.equal(preview.request.method, 'POST')
  assert.equal(preview.request.path, '/games/g/versions')
  assert.equal(requests, 0)
})

void test('versions upload rejects empty and non-directory build paths before dry-run', async t => {
  const directory = temporaryDirectory(t, 'versions-invalid-build')
  const emptyConfigProject = join(directory, 'empty-config')
  const explicitProject = join(directory, 'explicit')
  mkdirSync(emptyConfigProject)
  mkdirSync(explicitProject)
  writeFileSync(join(emptyConfigProject, 'poki.json'), JSON.stringify({ game_id: 'g', build_dir: '' }))
  const emptyBuild = join(explicitProject, 'empty-build')
  mkdirSync(emptyBuild)
  const regularFile = join(explicitProject, 'index.html')
  writeFileSync(regularFile, '<!doctype html>')

  const cases = [
    {
      args: ['versions', 'upload', '--game', 'g', '--dry-run', '--format', 'json'],
      cwd: emptyConfigProject,
      message: /--build-dir must be a non-empty directory path/
    },
    {
      args: ['versions', 'upload', '--game', 'g', '--build-dir', '', '--dry-run', '--format', 'json'],
      cwd: explicitProject,
      message: /--build-dir must be a non-empty directory path/
    },
    {
      args: ['versions', 'upload', '--game', 'g', '--build-dir', regularFile, '--dry-run', '--format', 'json'],
      cwd: explicitProject,
      message: /is not a directory/
    },
    {
      args: ['versions', 'upload', '--game', 'g', '--build-dir', emptyBuild, '--dry-run', '--format', 'json'],
      cwd: explicitProject,
      message: /is empty/
    }
  ]

  for (const example of cases) {
    const result = await runCli(example.args, { cwd: example.cwd })
    assert.equal(result.code, 2, result.stderr)
    assert.equal(result.stdout, '')
    const error = JSON.parse(result.stderr).error
    assert.equal(error.code, 'INVALID_INPUT')
    assert.match(error.message, example.message)
    if (example.args.includes(emptyBuild)) assert.deepEqual(error.details, { build_dir: emptyBuild })
  }
})

void test('versions download reports only structural diagnostics for a malformed location response', async t => {
  const { directory, env } = await apiHarness(t, (req, res) => {
    assert.equal(req.method, 'GET')
    assert.equal(req.url, '/games/g/download/V/source')
    jsonApi(res, { location: 42, private_secret: 'do-not-expose' })
  }, 'version-download-invalid-location')

  const result = await runCli([
    'versions', 'download', 'V', '--game', 'g', '--output', join(directory, 'version.zip'), '--format', 'json'
  ], { env })
  assert.equal(result.code, 5)
  assert.equal(result.stdout, '')
  assert.doesNotMatch(result.stderr, /do-not-expose/)
  const error = JSON.parse(result.stderr).error
  assert.equal(error.code, 'INVALID_API_RESPONSE')
  assert.deepEqual(error.details, { expected: 'object_with_string_location', received_kind: 'object' })
})

void test('versions download rejects an unusable destination before transferring anything', async t => {
  let requests = 0
  const { directory, env } = await apiHarness(t, (_req, res) => {
    requests++
    jsonApi(res, { location: '/signed/version.zip' })
  }, 'version-download-destination')
  const archives = join(directory, 'archives')
  mkdirSync(archives)

  const cases = [
    { args: ['--output', archives], message: /is not a regular file/ },
    // --force publishes over a completed file, never over a directory.
    { args: ['--output', archives, '--force'], message: /is not a regular file/ },
    { args: ['--output', ''], message: /--output must be a non-empty file path/ },
    { args: ['--output', '   ', '--force'], message: /--output must be a non-empty file path/ }
  ]

  for (const example of cases) {
    const result = await runCli([
      'versions', 'download', 'V', '--game', 'g', ...example.args, '--format', 'json'
    ], { env, cwd: archives })
    assert.equal(result.code, 2, result.stderr)
    assert.equal(result.stdout, '')
    const error = JSON.parse(result.stderr).error
    assert.equal(error.code, 'INVALID_INPUT')
    assert.match(error.message, example.message)
  }
  assert.equal(requests, 0)
  // An explicitly empty --output must not resolve to the working directory.
  assert.deepEqual(readdirSync(archives), [])
})

void test('versions download writes the signed archive and replaces an existing file only with --force', async t => {
  const { directory, env } = await apiHarness(t, (req, res) => {
    if (req.url === '/games/g/download/V/source') {
      jsonApi(res, { location: '/signed/version.zip' })
      return
    }
    assert.equal(req.url, '/signed/version.zip')
    assert.equal(req.headers.authorization, undefined)
    res.writeHead(200, { 'Content-Type': 'application/zip' })
    res.end('archive-bytes')
  }, 'version-download')
  const destination = join(directory, 'version.zip')
  const args = ['versions', 'download', 'V', '--game', 'g', '--output', destination, '--format', 'json']

  const written = await runCli(args, { env })
  assert.equal(written.code, 0, written.stderr)
  assert.deepEqual(JSON.parse(written.stdout).data, {
    version_id: 'V',
    type: 'source',
    path: destination,
    filename: 'version.zip',
    bytes: Buffer.byteLength('archive-bytes')
  })
  assert.equal(readFileSync(destination, 'utf8'), 'archive-bytes')

  const blocked = await runCli(args, { env })
  assert.equal(blocked.code, 2)
  assert.match(JSON.parse(blocked.stderr).error.message, /already exists/)

  const forced = await runCli([...args, '--force'], { env })
  assert.equal(forced.code, 0, forced.stderr)
  assert.equal(readFileSync(destination, 'utf8'), 'archive-bytes')
})

void test('an explicit --timeout-ms still bounds the signed archive transfer', async t => {
  const { directory, env } = await apiHarness(t, (req, res) => {
    if (req.url === '/games/g/download/V/source') {
      jsonApi(res, { location: '/signed/version.zip' })
      return
    }
    // Headers and a first chunk arrive, then the transfer stalls: only the
    // explicit deadline can end it.
    res.writeHead(200, { 'Content-Type': 'application/zip' })
    res.write('partial')
  }, 'version-download-timeout')
  const destination = join(directory, 'version.zip')

  const result = await runCli([
    'versions', 'download', 'V', '--game', 'g', '--output', destination, '--timeout-ms', '100', '--format', 'json'
  ], { env })
  assert.equal(result.code, 5, result.stderr)
  assert.equal(result.stdout, '')
  const error = JSON.parse(result.stderr).error
  assert.equal(error.code, 'API_TIMEOUT')
  assert.equal(error.retryable, true)
  assert.deepEqual(error.details, { timeout_ms: 100 })
  assert.equal(existsSync(destination), false)
  assert.deepEqual(readdirSync(directory).filter(name => name.includes('.poki-download-')), [])
})
