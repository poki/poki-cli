import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, request as httpRequest, IncomingMessage, RequestOptions } from 'node:http'
import { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { helpDocument } from '../src/docs/commands'
import { CliError, errorDocument } from '../src/errors'
import { legacyHumanUpload, readLegacyProjectConfig } from '../src/legacy'
import { finalizeP4dResponse, LegacyTransport, LegacyUploadError, legacyUploadTimeoutMs, postToP4D } from '../src/p4d'
import { CLI_USER_AGENT } from '../src/version'
import { createZip } from '../src/zipfile'
import { parseToon, repository, runCli, temporaryDirectory } from './helpers'

const packageVersion = (JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8')) as { version: string }).version

void test('legacy upload retains the inherited --version probe after the command', async () => {
  const result = await runCli(['upload', '--version'])

  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.stdout, `${packageVersion}\n`)
  assert.equal(result.stderr, '')
})

void test('legacy upload retains the global --version probe before the command', async () => {
  const result = await runCli(['--version', 'upload'])

  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.stdout, `${packageVersion}\n`)
  assert.equal(result.stderr, '')
})

void test('legacy upload retains the inherited true --version forms', async () => {
  const invocations = [
    ['upload', '--version=true'],
    ['upload', '--version', 'true'],
    ['--version=true', 'upload'],
    ['--version', 'true', 'upload'],
    ['upload', '--version=false', '--version'],
    ['--game', 'g', 'upload', '--version'],
    ['--game', 'g', '--version', 'upload']
  ]

  for (const args of invocations) {
    const result = await runCli(args)
    assert.equal(result.code, 0, `${args.join(' ')}: ${result.stderr}`)
    assert.equal(result.stdout, `${packageVersion}\n`, args.join(' '))
    assert.equal(result.stderr, '', args.join(' '))
  }
})

void test('legacy upload retains false --version forms and the option terminator', {
  skip: process.platform === 'win32' || process.getuid?.() === 0
    ? 'requires POSIX directory permissions enforced for a non-root user'
    : false
}, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'poki-cli-legacy-version-false-'))
  t.after(() => {
    chmodSync(directory, 0o700)
    rmSync(directory, { recursive: true, force: true })
  })
  const build = join(directory, 'build')
  mkdirSync(build)
  writeFileSync(join(build, 'index.html'), '<!doctype html>')
  // Force the timestamped archive creation to fail before authentication or a
  // request. What each invocation proves is that the --version probe did not
  // short-circuit the upload, so the archive failure and its exit 2 are the
  // evidence that the command actually ran.
  chmodSync(directory, 0o500)
  const buildOptions = ['--build-dir', build]
  const uploadOptions = ['--game', 'g', ...buildOptions]
  const invocations = [
    ['upload', '--version=false', ...uploadOptions],
    ['upload', '--version=anything', ...uploadOptions],
    ['upload', '--version', 'false', ...uploadOptions],
    ['upload', '--no-version', ...uploadOptions],
    ['--version=false', 'upload', ...uploadOptions],
    ['--version', 'false', 'upload', ...uploadOptions],
    ['--no-version', 'upload', ...uploadOptions],
    ['--game', 'g', '--version=false', 'upload', ...buildOptions],
    ['--game', 'g', '--no-version', 'upload', ...buildOptions],
    ['upload', '--version', '--version=false', ...uploadOptions],
    ['upload', ...uploadOptions, '--', '--version']
  ]

  for (const args of invocations) {
    const result = await runCli(args, {
      cwd: directory,
      env: { XDG_CONFIG_HOME: directory, POKI_UPLOAD_TOKEN: 'tok' }
    })
    assert.equal(result.code, 2, `${args.join(' ')}: ${result.stderr}`)
    assert.equal(result.stdout, '', args.join(' '))
    assert.match(result.stderr, /EACCES/, args.join(' '))
  }
})

void test('a false global version probe does not consume a modern resource version', async () => {
  const result = await runCli([
    '--version=false',
    'player-fit-tests', 'create',
    '--game', 'game-1',
    '--version', 'version-1',
    '--dry-run',
    '--format', 'json'
  ])

  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.stderr, '')
  const preview = JSON.parse(result.stdout)
  assert.equal(preview.request.body.data.attributes.version_id, 'version-1')
})

void test('P4D response errors preserve human compatibility', () => {
  const privateBody = JSON.stringify({ message: 'private backend text', secret: 'do-not-expose' })
  const legacyResponse = { statusCode: 400, data: privateBody }

  assert.throws(
    () => finalizeP4dResponse(legacyResponse),
    error => {
      assert.ok(error instanceof Error)
      assert.equal(error.message, JSON.stringify(legacyResponse))
      return true
    }
  )
})

// 0.1.x logged this failure and still exited 0, so a pipeline could not tell a
// build that was never produced from one that published. The human detail on
// stderr is unchanged; the exit status and the structured document are new.
void test('legacy upload reports ZIP creation failures with a non-zero exit', {
  skip: process.platform === 'win32' || process.getuid?.() === 0
    ? 'requires POSIX directory permissions enforced for a non-root user'
    : false
}, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'poki-cli-legacy-upload-'))
  t.after(() => {
    chmodSync(directory, 0o700)
    rmSync(directory, { recursive: true, force: true })
  })
  const build = join(directory, 'build')
  mkdirSync(build)
  writeFileSync(join(build, 'index.html'), '<!doctype html>')
  chmodSync(directory, 0o500)

  const result = await runCli([
    'upload', '--game', 'g', '--build-dir', build
  ], {
    cwd: directory,
    env: { XDG_CONFIG_HOME: directory, POKI_UPLOAD_TOKEN: 'tok' }
  })
  assert.equal(result.code, 2, result.stderr)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /EACCES/)
  assert.doesNotMatch(result.stderr, /uploading/)
  const error = parseToon(result.stderr.slice(result.stderr.indexOf('error:'))).error
  assert.equal(error.code, 'INVALID_INPUT')
  assert.equal(error.retryable, false)
  assert.match(error.message, /Could not create the upload archive/)
})

void test('legacy upload is human-only and help directs structured callers to versions upload', async t => {
  const directory = temporaryDirectory(t, 'legacy-human-only')
  const result = await runCli(['upload', '--game', 'g', '--format', 'json'], { cwd: directory })
  assert.equal(result.code, 2, result.stderr)
  assert.equal(result.stdout, '')
  const error = JSON.parse(result.stderr).error
  assert.equal(error.code, 'INVALID_INPUT')
  assert.match(error.message, /Unknown argument: --format/)
  assert.match(error.hint, /poki help upload/)

  const help = helpDocument(['upload']) as Record<string, any>
  assert.equal(help.deprecated, true)
  assert.deepEqual(help.output_schema, { default_format: 'human', formats: ['human'] })
  assert.equal(help.input_schema.options.some((option: { name: string }) => option.name === '--format'), false)
  assert.match(help.behavior.join(' '), /versions upload/)
  assert.match(help.behavior.join(' '), /allows an existing empty build directory/i)
  assert.match(
    help.input_schema.options.find((option: { name: string }) => option.name === '--build-dir')?.description ?? '',
    /existing empty directories/i
  )
})

void test('createZip archives a directory into a ZIP file', async t => {
  const directory = temporaryDirectory(t, 'zip')
  const source = join(directory, 'build')
  mkdirSync(source)
  writeFileSync(join(source, 'index.html'), '<!doctype html><title>Example</title>')
  writeFileSync(join(source, 'game.js'), 'console.log("ready")')

  const archive = join(directory, 'build.zip')
  await createZip(archive, source)
  assert.equal(existsSync(archive), true)
  const bytes = readFileSync(archive)
  // Local file header magic: PK\x03\x04.
  assert.deepEqual([...bytes.subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04])
  const contents = bytes.toString('latin1')
  assert.match(contents, /index\.html/)
  assert.match(contents, /game\.js/)
})

void test('legacy upload archives and posts an existing empty directory', async t => {
  const directory = temporaryDirectory(t, 'legacy-empty-build')
  const source = join(directory, 'dist')
  mkdirSync(source)
  const archive = join(directory, 'legacy-empty.zip')
  const originalLog = console.log
  const logs: unknown[] = []
  console.log = (...values: unknown[]) => { logs.push(...values) }
  t.after(() => { console.log = originalLog })

  let posts = 0
  await legacyHumanUpload('game-1', source, archive, 'Empty build', undefined, false, false, async () => {
    posts++
    assert.equal(existsSync(archive), true, 'the empty legacy archive exists during the upload')
    const bytes = readFileSync(archive)
    assert.equal(bytes.length, 22)
    assert.deepEqual([...bytes.subarray(0, 4)], [0x50, 0x4b, 0x05, 0x06])
    return { id: 'version-1', game_id: 'game-1' }
  })

  assert.equal(posts, 1)
  assert.equal(existsSync(archive), false, 'the empty legacy archive is deleted after upload')
  assert.match(logs.join(' '), /Version uploaded successfully/)
})

void test('legacy upload keeps its cwd archive, notes, flags, cleanup, and human failure detail', async t => {
  const directory = temporaryDirectory(t, 'legacy-contract')
  const source = join(directory, 'dist')
  mkdirSync(source)
  writeFileSync(join(source, 'index.html'), '<!doctype html>')
  const archive = join(directory, 'legacy.zip')
  let observed: unknown[] = []
  const originalError = console.error
  const errors: unknown[] = []
  console.error = (...values: unknown[]) => { errors.push(...values) }
  t.after(() => { console.error = originalError })

  await assert.rejects(legacyHumanUpload('game-1', source, archive, 'Release', 'Notes', true, true, async (...args) => {
    observed = args
    assert.equal(existsSync(archive), true, 'the legacy archive exists during the upload')
    throw new Error('remote rejected')
  }), (error: unknown) => {
    assert.ok(error instanceof CliError)
    assert.equal(error.code, 'NETWORK_ERROR')
    assert.equal(error.exitCode, 5)
    assert.equal(error.retryable, false, 'an upload that may have been accepted is never retryable')
    assert.match(error.hint ?? '', /versions list/)
    return true
  })

  assert.deepEqual(observed.slice(0, 3), ['game-1', archive, 'Release'])
  assert.equal(observed[3], 'Notes\n\nUploaded using poki-cli')
  assert.deepEqual(observed.slice(4), [true, true])
  assert.equal(existsSync(archive), false, 'the legacy archive is deleted after the upload attempt')
  // The raw transport detail keeps reaching stderr the way it always has; the
  // structured document above is added to it rather than replacing it.
  assert.equal(errors.length, 1)
  assert.match(String(errors[0]), /remote rejected/)
})

// Every mapped outcome is non-retryable: the request may already have been
// accepted, so the recovery is an inspection rather than a second upload.
void test('legacy upload maps transport and response failures to documented exit codes', async t => {
  const directory = temporaryDirectory(t, 'legacy-exit-codes')
  const source = join(directory, 'dist')
  mkdirSync(source)
  writeFileSync(join(source, 'index.html'), '<!doctype html>')
  const originalError = console.error
  console.error = () => {}
  t.after(() => { console.error = originalError })

  // Every injected message carries the same sentinel, so the leak assertion
  // below cannot be satisfied by the CLI's own generic wording.
  const secret = 'private-backend-upload-detail'
  const cases: Array<{ failure: Error, code: string, exitCode: number, hint: RegExp }> = [
    { failure: new LegacyUploadError(secret, 'timeout'), code: 'API_TIMEOUT', exitCode: 5, hint: /versions list/ },
    { failure: new LegacyUploadError(secret, 'network'), code: 'NETWORK_ERROR', exitCode: 5, hint: /versions list/ },
    { failure: new LegacyUploadError(secret, 'response', 401), code: 'AUTH_REQUIRED', exitCode: 3, hint: /auth login|POKI_UPLOAD_TOKEN/ },
    { failure: new LegacyUploadError(secret, 'response', 403), code: 'HTTP_403', exitCode: 4, hint: /versions list/ },
    { failure: new LegacyUploadError(secret, 'response', 422), code: 'HTTP_422', exitCode: 4, hint: /versions list/ },
    { failure: new LegacyUploadError(secret, 'response', 503), code: 'HTTP_503', exitCode: 5, hint: /versions list/ },
    // A 201 whose body cannot be parsed created the version anyway.
    { failure: new LegacyUploadError(secret, 'response', 201), code: 'INVALID_API_RESPONSE', exitCode: 5, hint: /do not upload the build again/i },
    // A transport error that is not a LegacyUploadError still fails closed.
    { failure: new Error(secret), code: 'NETWORK_ERROR', exitCode: 5, hint: /versions list/ }
  ]

  for (const expected of cases) {
    const archive = join(directory, `legacy-${expected.code}.zip`)
    await assert.rejects(legacyHumanUpload('game-1', source, archive, 'Release', undefined, false, false, async () => {
      throw expected.failure
    }), (error: unknown) => {
      assert.ok(error instanceof CliError, expected.code)
      assert.equal(error.code, expected.code)
      assert.equal(error.exitCode, expected.exitCode, expected.code)
      assert.equal(error.retryable, false, expected.code)
      assert.match(error.hint ?? '', expected.hint, expected.code)
      // Backend response text belongs on stderr above, never in the document.
      assert.doesNotMatch(JSON.stringify(errorDocument(error)), new RegExp(secret), expected.code)
      return true
    })
    assert.equal(existsSync(archive), false, `${expected.code}: the archive is removed after the attempt`)
  }
})

// The 0.1.x request had no deadline of any kind, so an origin that accepted the
// connection and then went quiet stalled until the operating system gave up -
// and then still exited 0. This drives the real Node request machinery.
void test('legacy upload bounds an unanswered request with an inactivity deadline', async t => {
  const directory = temporaryDirectory(t, 'legacy-timeout')
  const archive = join(directory, 'build.zip')
  writeFileSync(archive, 'archive-bytes')

  const connections: Socket[] = []
  let userAgent: string | undefined
  const server = createServer(req => {
    userAgent = req.headers['user-agent']
    // Consume the upload and never answer it.
    req.resume()
  })
  server.on('connection', socket => connections.push(socket))
  t.after(() => {
    for (const socket of connections) socket.destroy()
    server.close()
  })
  const port = await new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    assert.ok(address !== null && typeof address !== 'string')
    resolve(address.port)
  }))

  const transport = ((options: RequestOptions, callback?: (res: IncomingMessage) => void) => httpRequest({
    ...options,
    protocol: 'http:',
    hostname: '127.0.0.1',
    port,
    agent: false
  }, callback)) as LegacyTransport

  const originalLog = console.log
  console.log = () => {}
  const previousTimeout = process.env.POKI_API_TIMEOUT_MS
  const previousToken = process.env.POKI_UPLOAD_TOKEN
  process.env.POKI_API_TIMEOUT_MS = '150'
  process.env.POKI_UPLOAD_TOKEN = 'tok'
  t.after(() => {
    console.log = originalLog
    if (previousTimeout === undefined) delete process.env.POKI_API_TIMEOUT_MS
    else process.env.POKI_API_TIMEOUT_MS = previousTimeout
    if (previousToken === undefined) delete process.env.POKI_UPLOAD_TOKEN
    else process.env.POKI_UPLOAD_TOKEN = previousToken
  })

  assert.equal(legacyUploadTimeoutMs(), 150, 'POKI_API_TIMEOUT_MS sets the inactivity deadline')
  const started = Date.now()
  await assert.rejects(
    postToP4D('game-1', archive, 'Release', undefined, false, false, transport),
    (error: unknown) => {
      assert.ok(error instanceof LegacyUploadError)
      assert.equal(error.kind, 'timeout')
      return true
    }
  )
  assert.equal(CLI_USER_AGENT, `poki-cli/${packageVersion}`)
  assert.equal(userAgent, CLI_USER_AGENT)
  // Far below any operating-system connection timeout, which is the point.
  assert.ok(Date.now() - started < 10000, 'the request stops waiting at its own deadline')
})

void test('legacy project config still falls back to package.json when poki.json is malformed', t => {
  const directory = temporaryDirectory(t, 'legacy-config')
  writeFileSync(join(directory, 'poki.json'), '{malformed')
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ poki: { game_id: 'package-game', build_dir: 'public' } }))
  const previous = process.cwd()
  process.chdir(directory)
  try {
    assert.deepEqual(readLegacyProjectConfig(), { game_id: 'package-game', build_dir: 'public' })
  } finally {
    process.chdir(previous)
  }
})

void test('init creates poki.json exactly once and --force replaces it', async t => {
  const directory = temporaryDirectory(t, 'init-force')

  const created = await runCli(['init', '--game', 'g'], { cwd: directory })
  assert.equal(created.code, 0, created.stderr)
  assert.equal(
    readFileSync(join(directory, 'poki.json'), 'utf8'),
    JSON.stringify({ game_id: 'g', build_dir: 'dist' }, null, 2) + '\n'
  )
  assert.deepEqual(parseToon(created.stdout), { created: true, path: 'poki.json', game_id: 'g', build_dir: 'dist' })

  const rerun = await runCli(['init', '--game', 'g'], { cwd: directory })
  assert.equal(rerun.code, 2)
  assert.equal(rerun.stdout, '')
  const error = parseToon(rerun.stderr).error
  assert.equal(error.code, 'INVALID_INPUT')
  assert.match(error.message, /--force/)
  assert.deepEqual(JSON.parse(readFileSync(join(directory, 'poki.json'), 'utf8')), { game_id: 'g', build_dir: 'dist' })

  const forced = await runCli(['init', '--game', 'g', '--build-dir', 'public', '--force', '--format', 'json'], { cwd: directory })
  assert.equal(forced.code, 0, forced.stderr)
  assert.deepEqual(JSON.parse(forced.stdout), { created: true, path: 'poki.json', game_id: 'g', build_dir: 'public' })
  assert.deepEqual(JSON.parse(readFileSync(join(directory, 'poki.json'), 'utf8')), { game_id: 'g', build_dir: 'public' })
})

// init wrote poki.json as ASCII while every reader parses UTF-8, so a non-ASCII
// build_dir was reported back correctly and then persisted as bytes no command
// could resolve. The writer and both readers have to agree on one encoding.
void test('init round-trips a non-ASCII build directory through every project reader', async t => {
  const directory = temporaryDirectory(t, 'init-utf8')
  const buildDir = 'bü ild/ünité'

  const created = await runCli(['init', '--game', 'g', '--build-dir', buildDir, '--format', 'json'], { cwd: directory })
  assert.equal(created.code, 0, created.stderr)
  assert.equal(JSON.parse(created.stdout).build_dir, buildDir)

  // The bytes on disk decode as UTF-8, so the value survives a round trip
  // rather than becoming latin1 mojibake the success document never showed.
  assert.deepEqual(JSON.parse(readFileSync(join(directory, 'poki.json'), 'utf8')), { game_id: 'g', build_dir: buildDir })

  // The modern reader resolves it, and so does the legacy upload reader.
  const context = await runCli(['context', '--format', 'json'], { cwd: directory })
  assert.equal(context.code, 0, context.stderr)
  assert.equal(JSON.parse(context.stdout).project.build_dir, buildDir)

  const previous = process.cwd()
  process.chdir(directory)
  try {
    assert.deepEqual(readLegacyProjectConfig(), { game_id: 'g', build_dir: buildDir })
  } finally {
    process.chdir(previous)
  }
})
