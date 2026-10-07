import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { apiHarness, authEnvironment, completion, jsonApi, pokiConfigDirectory, repository, requestBody, runCli, spawnCli, temporaryDirectory } from './helpers'

async function documentedExitCodes (): Promise<string[]> {
  const help = await runCli(['help', 'games', 'get', '--format', 'json'])
  assert.equal(help.code, 0, help.stderr)
  return Object.keys(JSON.parse(help.stdout).exit_codes)
}

void test('root version compatibility and token-free auth status remain machine-readable', async t => {
  const version = await runCli(['--version'])
  assert.equal(version.code, 0)
  const packageVersion = (JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8')) as { version: string }).version
  assert.equal(version.stdout, `${packageVersion}\n`)

  const directory = temporaryDirectory(t, 'status')
  const env = authEnvironment(directory)
  const status = await runCli(['auth', 'status', '--format', 'json'], { env })
  assert.equal(status.code, 0, status.stderr)
  assert.deepEqual(JSON.parse(status.stdout), {
    authenticated: true,
    credentials_present: true,
    source: 'stored',
    access_type: 'Bearer',
    refreshable: false
  })
  assert.doesNotMatch(status.stdout, /test-token/)
})

void test('version downloads use a credential-free signed request and write complete bytes', async t => {
  const operations: string[] = []
  const { directory, env } = await apiHarness(t, (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    operations.push(`${req.method ?? ''} ${url.pathname}`)
    if (url.pathname === '/games/game-1/download/version-1/source') {
      assert.equal(req.headers.authorization, 'Bearer test-token')
      jsonApi(res, { location: '/signed/version-1.zip' })
      return
    }
    if (url.pathname === '/signed/version-1.zip') {
      assert.equal(req.headers.authorization, undefined)
      res.writeHead(200, { 'Content-Type': 'application/zip' })
      res.end(Buffer.from([80, 75, 3, 4, 1, 2, 3]))
      return
    }
    res.writeHead(404)
    res.end()
  }, 'version-download')
  const output = join(directory, 'version.zip')

  const result = await runCli([
    'versions', 'download', 'version-1', '--game', 'game-1', '--output', output, '--format', 'json'
  ], { env })
  assert.equal(result.code, 0, result.stderr)
  assert.deepEqual(operations, [
    'GET /games/game-1/download/version-1/source',
    'GET /signed/version-1.zip'
  ])
  assert.deepEqual([...readFileSync(output)], [80, 75, 3, 4, 1, 2, 3])
  assert.equal(JSON.parse(result.stdout).data.bytes, 7)

  const refusesOverwrite = await runCli([
    'versions', 'download', 'version-1', '--game', 'game-1', '--output', output, '--format', 'json'
  ], { env })
  assert.equal(refusesOverwrite.code, 2)
  assert.equal(JSON.parse(refusesOverwrite.stderr).error.code, 'INVALID_INPUT')
  assert.equal(operations.length, 2)
})

void test('review and feedback lists remain game-scoped and feedback date flags use Unix seconds', async t => {
  const observed: Array<{ method: string, path: string, query: URLSearchParams }> = []
  let feedbackBody: Record<string, unknown> | undefined
  // The test server callback intentionally owns its async request lifecycle.
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  const { env } = await apiHarness(t, async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    observed.push({ method: req.method ?? '', path: url.pathname, query: url.searchParams })
    assert.equal(req.headers.authorization, 'Bearer test-token')

    if (req.method === 'GET' && url.pathname === '/games/game-1/versions/version-1/reviews') {
      jsonApi(res, {
        data: [{
          type: 'reviews',
          id: 'review-1',
          relationships: { version: { data: { type: 'game_versions', id: 'version-1' } } }
        }],
        meta: { total: 1 }
      })
      return
    }
    if (req.method === 'GET' && url.pathname === '/games/game-1/player_feedback_questions') {
      jsonApi(res, { data: [{ type: 'player_feedback_questions', id: 'question-1', attributes: {} }], meta: { total: 1 } })
      return
    }
    if (req.method === 'POST' && url.pathname === '/games/game-1/player_feedback_questions') {
      feedbackBody = await requestBody(req)
      jsonApi(res, { data: { type: 'player_feedback_questions', id: 'question-2', attributes: { status: 'pending' } } }, 201)
      return
    }
    res.writeHead(404)
    res.end()
  }, 'global-routes')

  const reviews = await runCli(['reviews', 'list', '--game', 'game-1', '--version', 'version-1', '--format', 'json'], { env })
  assert.equal(reviews.code, 0, reviews.stderr)
  const review = JSON.parse(reviews.stdout).data[0]
  assert.deepEqual(review.version, { type: 'game_versions', id: 'version-1' })
  assert.equal(review.version_id, undefined)
  const questions = await runCli(['player-feedback-questions', 'list', '--game', 'game-1', '--format', 'json'], { env })
  assert.equal(questions.code, 0, questions.stderr)
  const create = await runCli([
    'player-feedback-questions', 'create', '--game', 'game-1',
    '--question', 'What blocks progression?',
    '--start-date', '2026-07-01', '--end-date', '2026-07-31',
    '--message-type', 'thumbs_down', '--message-type', 'bugreport', '--format', 'json'
  ], { env })
  assert.equal(create.code, 0, create.stderr)

  assert.equal(observed[0].path, '/games/game-1/versions/version-1/reviews')
  assert.equal(observed[1].path, '/games/game-1/player_feedback_questions')
  const attributes = (feedbackBody as unknown as { data: { attributes: Record<string, unknown> } }).data.attributes
  assert.equal(attributes.start_date, 1782864000)
  assert.equal(attributes.end_date, 1785456000)
  assert.deepEqual(attributes.feedback_message_types, ['thumbs_down', 'bugreport'])
})

void test('auth logout removes credentials once confirmed and supports an offline dry run', async t => {
  const directory = temporaryDirectory(t, 'logout')
  const env = authEnvironment(directory)
  const authPath = join(pokiConfigDirectory(directory), 'auth.json')

  const preview = await runCli(['auth', 'logout', '--dry-run', '--format', 'json'], { env })
  assert.equal(preview.code, 0, preview.stderr)
  assert.equal(JSON.parse(preview.stdout).dry_run, true)
  assert.equal(existsSync(authPath), true)

  // The generated confirmation suite proves the refusal exit code; only this
  // test can prove the credential file itself survives an unconfirmed logout.
  const unconfirmed = await runCli(['auth', 'logout', '--format', 'json'], { env })
  assert.equal(unconfirmed.code, 2, unconfirmed.stderr)
  assert.equal(existsSync(authPath), true)

  const confirmed = await runCli(['auth', 'logout', '--yes', '--format', 'json'], { env })
  assert.equal(confirmed.code, 0, confirmed.stderr)
  assert.equal(JSON.parse(confirmed.stdout).logged_out, true)
  assert.equal(existsSync(authPath), false)
})

void test('CLI API failures omit backend source, metadata, and arbitrary payload fields', async t => {
  const { env } = await apiHarness(t, (_req, res) => {
    jsonApi(res, {
      errors: [{
        status: '503',
        code: 'unavailable',
        title: 'Temporarily unavailable',
        detail: 'Try again later.',
        source: { pointer: '/private' },
        meta: { required_permissions: ['admin'], internal_acl_result: 'denied' }
      }],
      meta: { granted_permissions: ['developer'], impersonator: { id: 'admin-1' } },
      arbitrary_payload: { secret: true }
    }, 503)
  }, 'safe-api-error')

  const result = await runCli(['games', 'get', 'game-1', '--format', 'json'], { env })
  assert.equal(result.code, 5, result.stderr)
  const error = JSON.parse(result.stderr).error
  assert.equal(error.code, 'UNAVAILABLE')
  assert.deepEqual(error.details, {
    errors: [{
      status: '503',
      code: 'unavailable',
      title: 'Temporarily unavailable',
      detail: 'Try again later.'
    }]
  })
  assert.doesNotMatch(result.stderr, /pointer|required_permissions|internal_acl|granted_permissions|impersonator|secret/)
})

void test('an interrupted command reports INTERRUPTED with a documented exit code', {
  skip: process.platform === 'win32'
    ? 'child_process.kill cannot deliver a catchable POSIX signal on Windows'
    : false
}, async t => {
  // The server accepts the request and never answers it, so the signal
  // provably arrives while the command is still running.
  let accept: () => void = () => {}
  const accepted = new Promise<void>(resolve => { accept = resolve })
  const { env } = await apiHarness(t, () => accept(), 'interrupt')

  const child = spawnCli(['games', 'get', 'game-1', '--format', 'json'], { env })
  const result = completion(child)
  await accepted
  child.kill('SIGINT')

  const { code, stderr } = await result
  assert.equal(code, 130)
  assert.ok((await documentedExitCodes()).includes(String(code)), `exit code ${code} is undocumented`)
  const error = JSON.parse(stderr).error
  assert.equal(error.code, 'INTERRUPTED')
  assert.equal(error.retryable, false)
  assert.deepEqual(error.details, { signal: 'SIGINT' })
  assert.doesNotMatch(stderr, /\n\s+at /)
})

void test('a stdout consumer that stops reading ends the CLI quietly', async () => {
  // `poki help --all --full` is far larger than a pipe buffer, so the CLI is
  // still writing when the reader disappears the way `| head` does.
  const child = spawnCli(['help', '--all', '--full'])
  child.stdout.once('data', () => child.stdout.destroy())

  const { code, stderr } = await completion(child)
  assert.equal(code, 0)
  assert.equal(stderr, '')
})

void test('a failure in the error reporter still emits a structured document', async t => {
  const directory = temporaryDirectory(t, 'top-level')
  // Reporting is the last step a command performs, so breaking its first write
  // is what an unexpected failure past every command-level handler looks like.
  const preload = join(directory, 'break-first-report.mjs')
  writeFileSync(preload, [
    'const write = process.stderr.write.bind(process.stderr)',
    'let broken = false',
    'process.stderr.write = (...args) => {',
    '  if (broken) return write(...args)',
    '  broken = true',
    '  throw new Error("injected reporting failure")',
    '}',
    ''
  ].join('\n'))

  const { code, stderr } = await completion(spawnCli(['games', 'get', 'game-1', '--format', 'json'], { preload }))
  assert.ok((await documentedExitCodes()).includes(String(code)), `exit code ${code} is undocumented`)
  const error = JSON.parse(stderr).error
  assert.equal(error.code, 'UNEXPECTED_ERROR')
  assert.equal(error.retryable, false)
  assert.doesNotMatch(stderr, /\n\s+at /)
})
