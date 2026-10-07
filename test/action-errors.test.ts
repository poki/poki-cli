import assert from 'node:assert/strict'
import { ServerResponse } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { apiHarness, jsonApi, runCli } from './helpers'

const sensitivePermissionDenial = {
  errors: [{
    status: '403',
    code: 'permission-denied',
    title: 'Permission denied',
    detail: 'The current credential cannot access this resource.',
    source: { pointer: '/data/id' },
    meta: {
      required_permissions: ['internal-required'],
      granted_permissions: ['internal-granted'],
      internal_acl_result: 'denied'
    }
  }],
  meta: {
    required_permissions: ['internal-required'],
    granted_permissions: ['internal-granted']
  },
  internal_acl_result: 'denied'
}

function permissionDenied (res: ServerResponse): void {
  res.writeHead(403, {
    'Content-Type': 'application/vnd.api+json',
    'X-Request-Id': 'request-public',
    'Retry-After': '17'
  })
  res.end(JSON.stringify(sensitivePermissionDenial))
}

function playtestGame (): Record<string, unknown> {
  return {
    data: {
      type: 'games',
      id: 'g',
      relationships: {
        versions: { data: [{ type: 'game_versions', id: 'V' }] },
        playtest_requests: { data: [{ type: 'playtest_requests', id: 'R' }] }
      }
    },
    included: [
      { type: 'game_versions', id: 'V', attributes: { game_id: 'g' } },
      {
        type: 'playtest_requests',
        id: 'R',
        attributes: {
          game_id: 'g',
          version_id: 'V',
          recordings: 3,
          pending: 2,
          device_category: 'any',
          categories: '',
          orientation: 'both',
          new_users_only: false,
          normal_tile: false
        }
      }
    ]
  }
}

void test('action-level errors recursively sanitize nested permission denials in every wrapper', async t => {
  const mutations = { versions: 0, questions: 0, replacements: 0, cancellations: 0 }
  const { directory, env } = await apiHarness(t, (req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    if (req.method === 'POST' && path === '/games/g/versions') {
      mutations.versions++
      req.resume()
      req.on('end', () => jsonApi(res, { data: { type: 'game_versions', id: 'V', attributes: { game_id: 'g', state: 'processing' } } }, 201))
      return
    }
    if (req.method === 'GET' && path === '/versions/V') return permissionDenied(res)
    if (req.method === 'POST' && path === '/games/g/player_feedback_questions') {
      mutations.questions++
      req.resume()
      req.on('end', () => jsonApi(res, { data: { type: 'player_feedback_questions', id: 'Q', attributes: { status: 'pending' } } }, 201))
      return
    }
    if (req.method === 'GET' && path === '/games/g/player_feedback_questions/Q') return permissionDenied(res)
    if (req.method === 'GET' && path === '/games/g') return jsonApi(res, playtestGame())
    if (req.method === 'DELETE' && path === '/games/g/playtest-requests/R') {
      mutations.cancellations++
      res.writeHead(202)
      res.end()
      return
    }
    if (req.method === 'POST' && path === '/games/g/playtest-requests') {
      mutations.replacements++
      req.resume()
      req.on('end', () => permissionDenied(res))
      return
    }
    res.writeHead(404)
    res.end()
  }, 'nested-denials')
  const build = join(directory, 'build')
  mkdirSync(build)
  writeFileSync(join(build, 'index.html'), '<!doctype html>')

  const invocations = [
    {
      code: 'VERSION_UPLOAD_WAIT_FAILED',
      args: ['versions', 'upload', '--game', 'g', '--build-dir', build, '--wait', '--poll-interval-ms', '1', '--format', 'json']
    },
    {
      code: 'PLAYER_FEEDBACK_QUESTION_CREATE_WAIT_FAILED',
      args: ['player-feedback-questions', 'create', '--game', 'g', '--question', 'Why?', '--start-date', '2026-07-01', '--end-date', '2026-07-31', '--message-type', 'bugreport', '--wait', '--poll-interval-ms', '1', '--format', 'json']
    },
    {
      code: 'PLAYTEST_REQUEST_REPLACEMENT_FAILED',
      args: ['playtest-requests', 'replace', 'R', '--game', 'g', '--recordings', '4', '--yes', '--format', 'json']
    }
  ]

  for (const invocation of invocations) {
    const result = await runCli(invocation.args, { env })
    assert.equal(result.code, 4, result.stderr)
    assert.equal(result.stdout, '')
    const error = JSON.parse(result.stderr).error
    assert.equal(error.code, invocation.code)
    assert.equal(error.status, 403)
    assert.equal(error.retryable, false)
    assert.equal(error.request_id, 'request-public')
    assert.equal(error.retry_after, '17')
    assert.deepEqual(error.details.cause, {
      code: 'PERMISSION_DENIED',
      message: 'The current credential cannot access this resource.',
      status: 403,
      retryable: false,
      request_id: 'request-public',
      retry_after: '17',
      api_response: {
        errors: [{
          status: '403',
          code: 'permission-denied',
          title: 'Permission denied',
          detail: 'The current credential cannot access this resource.'
        }]
      }
    })
    assert.doesNotMatch(JSON.stringify(error), /required_permissions|granted_permissions|internal_acl_result|pointer/)
  }

  assert.deepEqual(mutations, { versions: 1, questions: 1, replacements: 1, cancellations: 1 })
})

void test('malformed successful create bodies use action-level list recovery and never replay mutations', async t => {
  const mutations = { versions: 0, questions: 0 }
  const { directory, env } = await apiHarness(t, (req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    const kind = path === '/games/g/versions'
      ? 'versions'
      : path === '/games/g/player_feedback_questions'
        ? 'questions'
        : undefined
    if (req.method === 'POST' && kind !== undefined) {
      mutations[kind]++
      req.resume()
      req.on('end', () => {
        res.writeHead(201, { 'Content-Type': 'application/json', 'X-Request-Id': `malformed-${kind}` })
        res.end('not json and not safe to expose')
      })
      return
    }
    res.writeHead(404)
    res.end()
  }, 'malformed-create-success')
  const build = join(directory, 'build')
  mkdirSync(build)
  writeFileSync(join(build, 'index.html'), '<!doctype html>')

  const invocations = [
    {
      code: 'VERSION_UPLOAD_WAIT_FAILED',
      recovery: 'inspect_created_version',
      requestId: 'malformed-versions',
      args: ['versions', 'upload', '--game', 'g', '--build-dir', build, '--wait', '--format', 'json']
    },
    {
      code: 'PLAYER_FEEDBACK_QUESTION_CREATE_WAIT_FAILED',
      recovery: 'inspect_created_question',
      requestId: 'malformed-questions',
      args: ['player-feedback-questions', 'create', '--game', 'g', '--question', 'Why?', '--start-date', '2026-07-01', '--end-date', '2026-07-31', '--message-type', 'bugreport', '--wait', '--format', 'json']
    }
  ]

  for (const invocation of invocations) {
    const result = await runCli(invocation.args, { env })
    assert.equal(result.code, 5, result.stderr)
    assert.equal(result.stdout, '')
    const error = JSON.parse(result.stderr).error
    assert.equal(error.code, invocation.code)
    assert.equal(error.status, 201)
    assert.equal(error.retryable, false)
    assert.equal(error.request_id, invocation.requestId)
    assert.equal(error.details.cause.code, 'INVALID_API_RESPONSE')
    assert.equal(error.details.cause.status, 201)
    assert.equal(error.details.cause.retryable, false)
    assert.match(error.details.cause.hint, /may already have committed/i)
    assert.match(error.details.cause.hint, /do not replay/i)
    assert.equal(error.details.recovery[invocation.recovery].command, 'poki')
    assert.doesNotMatch(JSON.stringify(error), /not json and not safe to expose/)
  }

  assert.deepEqual(mutations, { versions: 1, questions: 1 })
})

void test('successful uploads and creates with missing IDs preserve filtered results and provide list recovery without replay', async t => {
  const mutations = { versions: 0, questions: 0 }
  const { directory, env } = await apiHarness(t, (req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    if (req.method === 'POST' && path === '/games/g/versions') {
      mutations.versions++
      req.resume()
      req.on('end', () => jsonApi(res, {
        data: { type: 'game_versions', attributes: { game_id: 'g', label: 'Release', state: 'processing', internal_secret: 'hidden' } },
        meta: { new: true }
      }, 201))
      return
    }
    if (req.method === 'GET' && path === '/games/g/versions') {
      jsonApi(res, { data: [{ type: 'game_versions', id: 'V-existing', attributes: { label: 'Release', state: 'processing', created_at: '2026-08-13T00:00:00Z' } }] })
      return
    }
    if (req.method === 'POST' && path === '/games/g/player_feedback_questions') {
      mutations.questions++
      req.resume()
      req.on('end', () => jsonApi(res, {
        data: { type: 'player_feedback_questions', attributes: { question: 'Why?', status: 'pending', internal_secret: 'hidden' } },
        meta: { new: true }
      }, 201))
      return
    }
    if (req.method === 'GET' && path === '/games/g/player_feedback_questions') {
      jsonApi(res, { data: [{ type: 'player_feedback_questions', id: 'Q-existing', attributes: { question: 'Why?', status: 'pending', created_at: '2026-08-13T00:00:00Z' } }] })
      return
    }
    res.writeHead(404)
    res.end()
  }, 'missing-created-ids')
  const build = join(directory, 'build')
  mkdirSync(build)
  writeFileSync(join(build, 'index.html'), '<!doctype html>')

  const version = await runCli(['versions', 'upload', '--game', 'g', '--build-dir', build, '--wait', '--format', 'json'], { env })
  assert.equal(version.code, 5, version.stderr)
  const versionError = JSON.parse(version.stderr).error
  assert.equal(versionError.code, 'VERSION_UPLOAD_WAIT_FAILED')
  assert.equal(versionError.status, 201)
  assert.deepEqual(versionError.details.created_version, { type: 'game_versions', game_id: 'g', label: 'Release', state: 'processing' })
  assert.equal(versionError.details.created_version_id, undefined)
  assert.equal(versionError.details.cause.code, 'INVALID_API_RESPONSE')
  assert.match(versionError.hint, /Do not upload the build again/)
  assert.doesNotMatch(JSON.stringify(versionError), /internal_secret|"new"/)
  const versionRecovery = versionError.details.recovery.inspect_created_version
  const listedVersions = await runCli(versionRecovery.arguments, { env })
  assert.equal(listedVersions.code, 0, listedVersions.stderr)

  const question = await runCli([
    'player-feedback-questions', 'create', '--game', 'g',
    '--question', 'Why?', '--start-date', '2026-07-01', '--end-date', '2026-07-31', '--message-type', 'bugreport',
    '--wait', '--format', 'json'
  ], { env })
  assert.equal(question.code, 5, question.stderr)
  const questionError = JSON.parse(question.stderr).error
  assert.equal(questionError.code, 'PLAYER_FEEDBACK_QUESTION_CREATE_WAIT_FAILED')
  assert.equal(questionError.status, 201)
  assert.deepEqual(questionError.details.created_question, { type: 'player_feedback_questions', question: 'Why?', status: 'pending' })
  assert.equal(questionError.details.created_question_id, undefined)
  assert.match(questionError.hint, /Do not create the question again/)
  assert.doesNotMatch(JSON.stringify(questionError), /internal_secret|"new"/)
  const listedQuestions = await runCli(questionError.details.recovery.inspect_created_question.arguments, { env })
  assert.equal(listedQuestions.code, 0, listedQuestions.stderr)

  assert.deepEqual(mutations, { versions: 1, questions: 1 })
})

void test('a poll bounded by the request timeout keeps the created-version recovery envelope', async t => {
  let polls = 0
  const harness = await apiHarness(t, (req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    if (req.method === 'POST' && path === '/games/g/versions') {
      req.resume()
      req.on('end', () => jsonApi(res, {
        data: { type: 'game_versions', id: 'V', attributes: { game_id: 'g', label: 'Release', state: 'processing' } }
      }, 201))
      return
    }
    // The version poll never answers, so the request timeout expires long
    // before the much larger wait deadline.
    if (req.method === 'GET' && path === '/versions/V') {
      polls++
      req.resume()
      return
    }
    res.writeHead(404)
    res.end()
  }, 'poll-request-timeout')
  const build = join(harness.directory, 'build')
  mkdirSync(build)
  writeFileSync(join(build, 'index.html'), '<!doctype html>')
  const env = { ...harness.env, POKI_API_TIMEOUT_MS: '150' }

  const result = await runCli([
    'versions', 'upload', '--game', 'g', '--build-dir', build,
    '--wait', '--poll-interval-ms', '10', '--wait-timeout-ms', '30000', '--format', 'json'
  ], { env })
  assert.equal(result.code, 5, result.stderr)
  assert.equal(result.stdout, '')
  const error = JSON.parse(result.stderr).error

  // The wait deadline was nowhere near, so this is a request timeout inside a
  // wait, not the wait expiring: the upload already committed and must keep
  // its non-retryable, inspect-before-replay boundary.
  assert.equal(error.code, 'VERSION_UPLOAD_WAIT_FAILED')
  assert.equal(error.retryable, false)
  assert.equal(error.details.version_created, true)
  assert.equal(error.details.created_version_id, 'V')
  assert.equal(error.details.cause.code, 'API_TIMEOUT')
  assert.match(error.hint, /Do not upload the build again/)
  assert.deepEqual(error.details.recovery.resume_poll.arguments.slice(0, 4), ['versions', 'get', 'V', '--wait'])
  assert.ok(polls >= 1)
})
