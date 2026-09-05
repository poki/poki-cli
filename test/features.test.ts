import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { apiHarness, jsonApi, runCli } from './helpers'

void test('versions upload --wait polls the created version until its state is done', async t => {
  let polls = 0
  const { directory, env } = await apiHarness(t, (req, res) => {
    if (req.method === 'POST') {
      assert.equal(req.url, '/games/g/versions')
      req.resume()
      req.on('end', () => {
        res.writeHead(201, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ id: 'V', game_id: 'g', state: 'processing' }))
      })
      return
    }
    assert.equal(req.method, 'GET')
    assert.equal(req.url, '/versions/V')
    polls++
    jsonApi(res, { data: { type: 'game_versions', id: 'V', attributes: { state: polls === 1 ? 'processing' : 'done' } } })
  }, 'features-upload-wait')
  const build = join(directory, 'build')
  mkdirSync(build)
  writeFileSync(join(build, 'index.html'), '<!doctype html>')

  const result = await runCli([
    'versions', 'upload', '--game', 'g', '--build-dir', build,
    '--wait', '--poll-interval-ms', '25', '--wait-timeout-ms', '5000', '--format', 'json'
  ], { env })
  assert.equal(result.code, 0, result.stderr)
  const output = JSON.parse(result.stdout)
  assert.equal(output.data.state, 'done')
  assert.equal(output.meta.wait.final_state, 'done')
  assert.ok(output.meta.wait.polls >= 2, `expected at least two polls, saw ${String(output.meta.wait.polls)}`)
})

void test('versions get --wait reports WAIT_TIMEOUT when the state never becomes terminal', async t => {
  let requests = 0
  const { env } = await apiHarness(t, (req, res) => {
    requests++
    assert.equal(req.method, 'GET')
    assert.equal(req.url, '/versions/V')
    jsonApi(res, { data: { type: 'game_versions', id: 'V', attributes: { state: 'processing' } } })
  }, 'features-wait-timeout')

  const result = await runCli([
    // Leave enough time for at least one local HTTP round trip even while the
    // full test suite is running many CLI subprocesses concurrently.
    'versions', 'get', 'V', '--wait', '--poll-interval-ms', '40', '--wait-timeout-ms', '500', '--format', 'json'
  ], { env })
  assert.equal(result.code, 5)
  assert.equal(result.stdout, '')
  const error = JSON.parse(result.stderr).error
  assert.equal(error.code, 'WAIT_TIMEOUT')
  assert.equal(error.retryable, true)
  assert.equal(error.details.last_state, 'processing')
  assert.equal(error.details.resource.data.state, 'processing')
  assert.equal(typeof error.hint, 'string')
  assert.ok(requests >= 1)

  // --wait --raw is rejected locally before any request is made.
  requests = 0
  const rejected = await runCli(['versions', 'get', 'V', '--wait', '--raw', '--format', 'json'], { env })
  assert.equal(rejected.code, 2)
  assert.equal(rejected.stdout, '')
  assert.equal(JSON.parse(rejected.stderr).error.code, 'INVALID_INPUT')
  assert.equal(requests, 0)
})

void test('--wait rejects terminal resources whose identities do not match the requested resource', async t => {
  const requests: string[] = []
  const { env } = await apiHarness(t, (req, res) => {
    requests.push(req.url ?? '')
    if (req.url === '/versions/V') {
      jsonApi(res, { data: { type: 'game_versions', id: 'OTHER-VERSION', attributes: { state: 'done', filename: 'version-poll-secret' } } })
      return
    }
    if (req.url === '/games/g/player_feedback_questions/Q') {
      jsonApi(res, { data: { type: 'player_feedback_questions', id: 'OTHER-QUESTION', attributes: { status: 'completed', response: 'question-poll-secret' } } })
      return
    }
    res.writeHead(404)
    res.end()
  }, 'features-wait-identity')

  const cases = [
    ['versions', 'get', 'V'],
    ['player-feedback-questions', 'get', 'Q', '--game', 'g']
  ]
  for (const args of cases) {
    const result = await runCli([
      ...args, '--wait', '--poll-interval-ms', '1', '--wait-timeout-ms', '5000', '--format', 'json'
    ], { env })
    assert.equal(result.code, 5, result.stderr)
    assert.equal(result.stdout, '')
    const error = JSON.parse(result.stderr).error
    assert.equal(error.code, 'INVALID_API_RESPONSE')
    assert.equal(error.retryable, false)
    assert.doesNotMatch(result.stderr, /OTHER-|poll-secret/)
  }
  assert.deepEqual(requests, ['/versions/V', '/games/g/player_feedback_questions/Q'])
})

void test('--wait reports version and feedback terminal failures as non-retryable errors', async t => {
  const { env } = await apiHarness(t, (req, res) => {
    if (req.method === 'GET' && req.url === '/versions/V') {
      jsonApi(res, { data: { type: 'game_versions', id: 'V', attributes: { state: 'error', error: 'invalid archive' } } })
      return
    }
    if (req.method === 'GET' && req.url === '/games/g/player_feedback_questions/Q') {
      jsonApi(res, { data: { type: 'player_feedback_questions', id: 'Q', attributes: { status: 'failed', response: 'model unavailable' } } })
      return
    }
    res.writeHead(404)
    res.end()
  }, 'features-wait-failed')

  const cases = [
    { args: ['versions', 'get', 'V'], state: 'error', resourceState: 'error' },
    { args: ['player-feedback-questions', 'get', 'Q', '--game', 'g'], state: 'failed', resourceState: 'failed' }
  ]
  for (const testCase of cases) {
    const result = await runCli([
      ...testCase.args, '--wait', '--poll-interval-ms', '20', '--wait-timeout-ms', '5000', '--format', 'json'
    ], { env })
    assert.equal(result.code, 5)
    assert.equal(result.stdout, '')
    const error = JSON.parse(result.stderr).error
    assert.equal(error.code, 'ASYNC_OPERATION_FAILED')
    assert.equal(error.retryable, false)
    assert.equal(error.details.final_state, testCase.state)
    assert.equal(error.details.resource.data.state ?? error.details.resource.data.status, testCase.resourceState)
  }
})

void test('versions current reports the public version and the full track allocation', async t => {
  const tracks = [
    { track: 'public', version_id: 'V1', weight: 100 },
    { track: 'weighted', version_id: 'V2', weight: 100 }
  ]
  const { env } = await apiHarness(t, (req, res) => {
    assert.equal(req.method, 'GET')
    assert.equal(req.url, '/games/g')
    jsonApi(res, { data: { type: 'games', id: 'g', attributes: { title: 'T', public_version: 'V1', tracks } } })
  }, 'features-current')

  const result = await runCli(['versions', 'current', '--game', 'g', '--format', 'json'], { env })
  assert.equal(result.code, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), {
    data: { game_id: 'g', public_version: 'V1', tracks },
    meta: {}
  })
})

void test('games list --format csv escapes per RFC 4180 and takes the union of columns', async t => {
  let requests = 0
  let empty = false
  const { env } = await apiHarness(t, (req, res) => {
    requests++
    assert.equal(req.method, 'GET')
    jsonApi(res, {
      data: empty
        ? []
        : [
            { type: 'games', id: '1', attributes: { title: 'Say "hi", world' } },
            { type: 'games', id: '2', attributes: { title: 'Second', approved: true } }
          ]
    })
  }, 'features-csv')

  // --raw is rejected locally before any request is made. The error document
  // arrives in the default toon encoding because csv is not an error format.
  const rejected = await runCli(['games', 'list', '--format', 'csv', '--raw'], { env })
  assert.equal(rejected.code, 2)
  assert.equal(rejected.stdout, '')
  assert.match(rejected.stderr, /INVALID_INPUT/)
  assert.match(rejected.stderr, /--format csv cannot be combined with --raw/)
  assert.equal(requests, 0)

  const result = await runCli(['games', 'list', '--format', 'csv', '--full'], { env })
  assert.equal(result.code, 0, result.stderr)
  const lines = result.stdout.replace(/\n$/, '').split('\n')
  assert.equal(lines.length, 3)
  // The header is the union of row columns; the second resource contributes
  // a field the first lacks.
  assert.deepEqual(lines[0].split(',').sort(), ['approved', 'id', 'title', 'type'].sort())
  // RFC 4180: the field containing a comma and quotes is wrapped in quotes
  // with the inner quotes doubled.
  assert.ok(lines[1].includes('"Say ""hi"", world"'), lines[1])
  assert.ok(!lines[1].includes('true'))
  assert.ok(lines[2].includes('Second'))
  assert.ok(lines[2].includes('true'))

  empty = true
  const none = await runCli(['games', 'list', '--format', 'csv'], { env })
  assert.equal(none.code, 0, none.stderr)
  // An empty collection has no rows to derive a header from, so the export
  // declares the columns the view projects. A zero-byte success would be
  // indistinguishable from a killed process.
  assert.deepEqual(none.stdout.replace(/\n$/, '').split('\n'), ['type,id,title,team_id,approved,public_version,updated_at'])
})

void test('data run --last-days fills the recipe date range offline', async () => {
  const result = await runCli([
    'data', 'run', 'game-users', '--team', 'T', '--game', 'G', '--last-days', '7', '--validate-only', '--format', 'json'
  ])
  assert.equal(result.code, 0, result.stderr)
  const output = JSON.parse(result.stdout)
  assert.equal(output.local_structure_valid, true)
  assert.equal(output.api_validated, false)
  assert.equal(output.executable, 'unknown')
  assert.equal(output.valid, undefined)
  assert.equal(output.meta.contacted_api, false)
  const expressions = output.query.where.expressions as Array<[string, string, string]>
  const fromDate = expressions.find(([field, operator]) => field === 'date' && operator === '>=')?.[2]
  const toDate = expressions.find(([field, operator]) => field === 'date' && operator === '<=')?.[2]
  assert.ok(fromDate !== undefined && toDate !== undefined, JSON.stringify(expressions))
  assert.match(fromDate, /^\d{4}-\d{2}-\d{2}$/)
  assert.match(toDate, /^\d{4}-\d{2}-\d{2}$/)
  assert.ok(fromDate <= toDate, `${fromDate} <= ${toDate}`)
  const bound = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10)
  assert.ok(toDate < bound, `${toDate} < ${bound}`)
  // --last-days 7 means seven complete days: TO_DATE - FROM_DATE = 6 days.
  const spanDays = (Date.parse(`${toDate}T12:00:00Z`) - Date.parse(`${fromDate}T12:00:00Z`)) / 86400000
  assert.equal(spanDays, 6, `${fromDate}..${toDate}`)
})

void test('data run --last-days fills a datetime recipe with complete local calendar days', async () => {
  const result = await runCli([
    'data', 'run', 'game-errors', '--team', 'T', '--game', 'G', '--last-days', '8', '--validate-only', '--format', 'json'
  ])
  assert.equal(result.code, 0, result.stderr)
  const output = JSON.parse(result.stdout)
  const expressions = output.query.where.expressions as Array<[string, string, string]>
  const fromDateTime = expressions.find(([field, operator]) => field === 'date_hour' && operator === '>=')?.[2]
  const toDateTime = expressions.find(([field, operator]) => field === 'date_hour' && operator === '<=')?.[2]
  assert.match(fromDateTime ?? '', /^\d{4}-\d{2}-\d{2} 00:00:00$/)
  assert.match(toDateTime ?? '', /^\d{4}-\d{2}-\d{2} 23:59:59$/)
  const fromDate = String(fromDateTime).slice(0, 10)
  const toDate = String(toDateTime).slice(0, 10)
  const spanDays = (Date.parse(`${toDate}T12:00:00Z`) - Date.parse(`${fromDate}T12:00:00Z`)) / 86400000
  assert.equal(spanDays, 7, `${String(fromDateTime)}..${String(toDateTime)}`)
})

void test('data run rejects conflicting or invalid date-range parameters', async () => {
  const combined = await runCli([
    'data', 'run', 'game-users', '--team', 'T', '--game', 'G', '--last-days', '7', '--from-date', '2026-07-01', '--validate-only', '--format', 'json'
  ])
  assert.equal(combined.code, 2)
  assert.equal(JSON.parse(combined.stderr).error.code, 'INVALID_INPUT')

  const combinedDateTime = await runCli([
    'data', 'run', 'game-errors', '--team', 'T', '--game', 'G', '--last-days', '8', '--from-datetime', '2026-07-01 00:00:00', '--validate-only', '--format', 'json'
  ])
  assert.equal(combinedDateTime.code, 2)
  assert.equal(JSON.parse(combinedDateTime.stderr).error.code, 'INVALID_INPUT')

  const inverted = await runCli([
    'data', 'run', 'game-users', '--team', 'T', '--game', 'G', '--from-date', '2026-07-31', '--to-date', '2026-07-01', '--validate-only', '--format', 'json'
  ])
  assert.equal(inverted.code, 2)
  const invertedError = JSON.parse(inverted.stderr).error
  assert.equal(invertedError.code, 'INVALID_INPUT')
  assert.match(invertedError.message, /FROM_DATE must not be after TO_DATE/)

  const zero = await runCli([
    'data', 'run', 'game-users', '--team', 'T', '--game', 'G', '--last-days', '0', '--validate-only', '--format', 'json'
  ])
  assert.equal(zero.code, 2)
  assert.equal(JSON.parse(zero.stderr).error.code, 'INVALID_INPUT')
})

void test('player-feedback-questions create --wait polls until generation completes', async t => {
  let polls = 0
  const { env } = await apiHarness(t, (req, res) => {
    if (req.method === 'POST') {
      assert.equal(req.url, '/games/g/player_feedback_questions')
      req.resume()
      req.on('end', () => {
        jsonApi(res, { data: { type: 'player_feedback_questions', id: 'Q', attributes: { status: 'pending' } } }, 201)
      })
      return
    }
    assert.equal(req.method, 'GET')
    assert.equal(req.url, '/games/g/player_feedback_questions/Q')
    polls++
    jsonApi(res, { data: { type: 'player_feedback_questions', id: 'Q', attributes: { status: polls === 1 ? 'processing' : 'completed' } } })
  }, 'features-question-wait')

  const result = await runCli([
    'player-feedback-questions', 'create', '--game', 'g',
    '--question', 'Why?', '--start-date', '2026-07-01', '--end-date', '2026-07-31', '--message-type', 'bugreport',
    '--wait', '--poll-interval-ms', '25', '--wait-timeout-ms', '5000', '--format', 'json'
  ], { env })
  assert.equal(result.code, 0, result.stderr)
  const output = JSON.parse(result.stdout)
  assert.equal(output.data.status, 'completed')
  assert.equal(output.meta.wait.final_state, 'completed')
  assert.ok(output.meta.wait.polls >= 2, `expected at least two polls, saw ${String(output.meta.wait.polls)}`)
})

void test('player-feedback-questions create preserves the created question when subsequent polling fails', async t => {
  let creates = 0
  let polls = 0
  const { env } = await apiHarness(t, (req, res) => {
    if (req.method === 'POST') {
      creates++
      assert.equal(req.url, '/games/g/player_feedback_questions')
      req.resume()
      req.on('end', () => {
        jsonApi(res, { data: { type: 'player_feedback_questions', id: 'Q', attributes: { status: 'pending' } } }, 201)
      })
      return
    }
    assert.equal(req.method, 'GET')
    assert.equal(req.url, '/games/g/player_feedback_questions/Q')
    polls++
    if (polls === 1) {
      jsonApi(res, { errors: [{ code: 'unavailable', title: 'Polling unavailable' }] }, 503)
      return
    }
    jsonApi(res, { data: { type: 'player_feedback_questions', id: 'Q', attributes: { status: 'completed', response: 'Recovered' } } })
  }, 'features-question-poll-failure')

  const result = await runCli([
    'player-feedback-questions', 'create', '--game', 'g',
    '--question', 'Why?', '--start-date', '2026-07-01', '--end-date', '2026-07-31', '--message-type', 'bugreport',
    '--wait', '--poll-interval-ms', '25', '--wait-timeout-ms', '5000', '--format', 'json'
  ], { env })
  assert.equal(result.code, 5)
  assert.equal(result.stdout, '')
  assert.equal(creates, 1)
  assert.equal(polls, 1)

  const error = JSON.parse(result.stderr).error
  assert.equal(error.code, 'PLAYER_FEEDBACK_QUESTION_CREATE_WAIT_FAILED')
  assert.equal(error.status, 503)
  assert.equal(error.retryable, false)
  assert.equal(error.details.question_created, true)
  assert.equal(error.details.created_question_id, 'Q')
  assert.deepEqual(error.details.created_question, { type: 'player_feedback_questions', id: 'Q', status: 'pending' })
  assert.equal(error.details.cause.code, 'UNAVAILABLE')
  assert.equal(error.details.cause.retryable, true)
  assert.deepEqual(error.details.recovery.resume_poll, {
    action: 'poll_existing_player_feedback_question',
    command: 'poki',
    arguments: [
      'player-feedback-questions', 'get', 'Q',
      '--game', 'g',
      '--wait',
      '--poll-interval-ms', '25',
      '--wait-timeout-ms', '5000',
      '--format', 'json'
    ]
  })
  assert.match(error.hint, /Do not create the question again/)

  const resumed = await runCli(error.details.recovery.resume_poll.arguments, { env })
  assert.equal(resumed.code, 0, resumed.stderr)
  assert.equal(JSON.parse(resumed.stdout).data.status, 'completed')
  assert.equal(creates, 1)
  assert.equal(polls, 2)
})
