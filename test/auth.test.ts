import assert from 'node:assert/strict'
import { createServer, IncomingMessage, ServerResponse } from 'node:http'
import { chmodSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test, { TestContext } from 'node:test'

import { launchBrowser, login, refreshStoredAuth } from '../src/auth'
import { getConfigDir } from '../src/config'
import { AUTH_LOGIN_USER_ACTION_HINT, AUTH_REQUIRED_HINT, CliError } from '../src/errors'
import { CLI_USER_AGENT } from '../src/version'
import { configHomeEnvironment, configHomeEnvironmentVariable, pokiConfigDirectory, runCli, temporaryDirectory } from './helpers'

void test('browser launch dynamically loads and calls the packaged opener', async () => {
  let imports = 0
  let openedTarget: string | undefined

  await launchBrowser('https://example.test/sign-in', async () => {
    imports += 1
    return {
      default: async target => {
        openedTarget = target
      }
    }
  })

  assert.equal(imports, 1)
  assert.equal(openedTarget, 'https://example.test/sign-in')
})

function fabricatedJwt (claims: Record<string, unknown>): string {
  const part = (value: Record<string, unknown>): string => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${part({ alg: 'HS256', typ: 'JWT' })}.${part(claims)}.fabricated-signature`
}

void test('missing credentials tell the agent to ask the user to complete browser sign-in', async t => {
  const directory = temporaryDirectory(t, 'auth-missing')
  const result = await runCli(['games', 'list', '--format', 'json'], {
    env: configHomeEnvironment(directory)
  })

  assert.equal(result.code, 3, result.stderr)
  assert.equal(result.stdout, '')
  assert.deepEqual(JSON.parse(result.stderr), {
    error: {
      code: 'AUTH_REQUIRED',
      message: 'Authentication is required.',
      status: 401,
      retryable: false,
      hint: AUTH_REQUIRED_HINT
    }
  })
})

// Points refreshStoredAuth at a temporary directory and a local auth server
// for the duration of one test, restoring the environment afterwards.
function isolateAuthEnvironment (t: TestContext, slug: string): string {
  const original = {
    configHome: process.env[configHomeEnvironmentVariable],
    serviceEnv: process.env.SERVICE_ENV,
    timeoutMs: process.env.POKI_API_TIMEOUT_MS
  }
  t.after(() => {
    if (original.configHome === undefined) Reflect.deleteProperty(process.env, configHomeEnvironmentVariable); else process.env[configHomeEnvironmentVariable] = original.configHome
    if (original.serviceEnv === undefined) delete process.env.SERVICE_ENV; else process.env.SERVICE_ENV = original.serviceEnv
    if (original.timeoutMs === undefined) delete process.env.POKI_API_TIMEOUT_MS; else process.env.POKI_API_TIMEOUT_MS = original.timeoutMs
  })
  const directory = temporaryDirectory(t, slug)
  process.env[configHomeEnvironmentVariable] = directory
  delete process.env.SERVICE_ENV
  return directory
}

async function withAuthServer (
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  run: (baseUrl: string) => Promise<void>
): Promise<void> {
  const server = createServer(handler)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address !== null && typeof address !== 'string')
  try {
    await run(`http://127.0.0.1:${address.port}`)
  } finally {
    server.close()
  }
}

void test('unusable credentials fail without opening a browser and upload tokens are never accepted', async t => {
  const directory = temporaryDirectory(t, 'auth-corrupt')
  const config = pokiConfigDirectory(directory)
  mkdirSync(config, { recursive: true })
  writeFileSync(join(config, 'auth.json'), '{invalid')

  // A corrupt credential file must become the standard auth-required envelope
  // instead of a crash, and the legacy POKI_UPLOAD_TOKEN must not satisfy
  // generic API commands.
  const result = await runCli(['games', 'list', '--format', 'json'], {
    env: { ...configHomeEnvironment(directory), POKI_UPLOAD_TOKEN: 'upload-only-token' }
  })
  assert.equal(result.code, 3, result.stderr)
  assert.equal(result.stdout, '')
  assert.deepEqual(JSON.parse(result.stderr), {
    error: {
      code: 'AUTH_REQUIRED',
      message: 'Authentication is required.',
      status: 401,
      retryable: false,
      hint: AUTH_REQUIRED_HINT
    }
  })
})

void test('stored credentials are decoded before use and invalid files remain untouched', async t => {
  const directory = temporaryDirectory(t, 'auth-invalid-values')
  const config = pokiConfigDirectory(directory)
  mkdirSync(config, { recursive: true })
  const authPath = join(config, 'auth.json')
  const invalidCredentials: unknown[] = [
    { access_type: 'Bearer', access_token: null, refresh_token: 'refresh-1' },
    { access_type: 'Bearer', access_token: 42, refresh_token: 'refresh-1' },
    { access_type: 'Bearer', access_token: 'bad\u0000token', refresh_token: 'refresh-1' },
    { access_type: 'Bearer', access_token: 'access-1', refresh_token: null },
    { access_type: 'Bearer', access_token: 'access-1', refresh_token: 'réfresh' },
    { access_type: 'Unexpected', access_token: 'access-1' }
  ]

  for (const credentials of invalidCredentials) {
    const storedText = JSON.stringify(credentials)
    writeFileSync(authPath, storedText, 'utf8')
    const result = await runCli(['auth', 'status', '--format', 'json'], { env: configHomeEnvironment(directory) })
    assert.equal(result.code, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout), {
      authenticated: false,
      credentials_present: false,
      source: 'none',
      refreshable: false
    })
    assert.equal(readFileSync(authPath, 'utf8'), storedText)
  }
})

void test('auth status decodes stored JWT expiry offline and reports refreshability', async t => {
  const directory = temporaryDirectory(t, 'auth-expired')
  const config = pokiConfigDirectory(directory)
  mkdirSync(config, { recursive: true })
  const token = fabricatedJwt({ sub: 'user-1', exp: 1000000000 })

  writeFileSync(join(config, 'auth.json'), JSON.stringify({
    access_type: 'Bearer',
    access_token: token,
    refresh_token: 'refresh-1'
  }))
  const refreshable = await runCli(['auth', 'status', '--format', 'json'], { env: configHomeEnvironment(directory) })
  assert.equal(refreshable.code, 0, refreshable.stderr)
  assert.deepEqual(JSON.parse(refreshable.stdout), {
    authenticated: false,
    credentials_present: true,
    source: 'stored',
    access_type: 'Bearer',
    expires_at: '2001-09-09T01:46:40.000Z',
    expired: true,
    refreshable: true
  })

  writeFileSync(join(config, 'auth.json'), JSON.stringify({ access_type: 'Bearer', access_token: token }))
  const unrefreshable = await runCli(['auth', 'status', '--format', 'json'], { env: configHomeEnvironment(directory) })
  assert.equal(unrefreshable.code, 0, unrefreshable.stderr)
  assert.equal(JSON.parse(unrefreshable.stdout).expired, true)
  assert.equal(JSON.parse(unrefreshable.stdout).refreshable, false)

  const invalidExpiry = fabricatedJwt({ sub: 'user-1', exp: 'not-a-number' })
  writeFileSync(join(config, 'auth.json'), JSON.stringify({ access_type: 'Bearer', access_token: invalidExpiry }))
  const withoutExpiry = await runCli(['auth', 'status', '--format', 'json'], { env: configHomeEnvironment(directory) })
  assert.equal(withoutExpiry.code, 0, withoutExpiry.stderr)
  assert.deepEqual(JSON.parse(withoutExpiry.stdout), {
    authenticated: true,
    credentials_present: true,
    source: 'stored',
    access_type: 'Bearer',
    refreshable: false
  })
})

void test('auth logout --yes returns a structured result when nothing is stored', async t => {
  const directory = temporaryDirectory(t, 'auth-logout')
  const result = await runCli(['auth', 'logout', '--yes', '--format', 'json'], { env: configHomeEnvironment(directory) })
  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.stderr, '')
  assert.deepEqual(JSON.parse(result.stdout), { logged_out: false })
})

void test('acceptance authentication is isolated from production credentials', async t => {
  const directory = temporaryDirectory(t, 'auth-acceptance-scope')
  const applicationDirectory = pokiConfigDirectory(directory)
  const acceptanceDirectory = join(applicationDirectory, 'acceptance')
  mkdirSync(acceptanceDirectory, { recursive: true })
  const productionPath = join(applicationDirectory, 'auth.json')
  const acceptancePath = join(acceptanceDirectory, 'auth.json')
  const productionCredentials = JSON.stringify({ access_type: 'Bearer', access_token: 'production-token' })
  writeFileSync(productionPath, productionCredentials)
  writeFileSync(acceptancePath, JSON.stringify({ access_type: 'Bearer', access_token: 'acceptance-token' }))
  const configEnvironment = configHomeEnvironment(directory)
  const env = { ...configEnvironment, SERVICE_ENV: 'acceptance' }

  const status = await runCli(['auth', 'status', '--format', 'json'], { env })
  assert.equal(status.code, 0, status.stderr)
  assert.equal(JSON.parse(status.stdout).authenticated, true)

  const logout = await runCli(['auth', 'logout', '--yes', '--format', 'json'], { env })
  assert.equal(logout.code, 0, logout.stderr)
  assert.deepEqual(JSON.parse(logout.stdout), { logged_out: true })
  assert.equal(existsSync(acceptancePath), false)
  assert.equal(readFileSync(productionPath, 'utf8'), productionCredentials)
})

void test('refreshStoredAuth merges the response over the stored config and persists it', async t => {
  const directory = isolateAuthEnvironment(t, 'auth-refresh')

  let requestBody = ''
  let contentType: string | undefined
  let userAgent: string | undefined
  await withAuthServer((req, res) => {
    assert.equal(req.method, 'POST')
    assert.equal(req.url, '/auth/refresh')
    contentType = req.headers['content-type']
    userAgent = req.headers['user-agent']
    let body = ''
    req.on('data', chunk => { body += String(chunk) })
    req.on('end', () => {
      requestBody = body
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        access_token: 'new-access-token',
        game_id: 'response-must-not-overwrite-project-settings',
        future_private_field: 'not-a-credential'
      }))
    })
  }, async baseUrl => {
    const refreshed = await refreshStoredAuth({
      access_type: 'Bearer',
      access_token: 'stale-token',
      refresh_token: 'refresh-1',
      game_id: 'stored-project-setting'
    }, baseUrl)
    assert.deepEqual(refreshed, {
      access_type: 'Bearer',
      access_token: 'new-access-token',
      refresh_token: 'refresh-1'
    })
    assert.equal(contentType, 'application/json')
    assert.equal(userAgent, CLI_USER_AGENT)
    assert.deepEqual(JSON.parse(requestBody), { refresh_token: 'refresh-1' })
    assert.deepEqual(JSON.parse(readFileSync(join(pokiConfigDirectory(directory), 'auth.json'), 'utf8')), refreshed)
  })
})

void test('acceptance refresh cannot replace production credentials', async t => {
  const directory = isolateAuthEnvironment(t, 'auth-acceptance-refresh')
  process.env.SERVICE_ENV = 'acceptance'
  const productionDirectory = pokiConfigDirectory(directory)
  const acceptanceDirectory = join(productionDirectory, 'acceptance')
  mkdirSync(acceptanceDirectory, { recursive: true })
  const productionPath = join(productionDirectory, 'auth.json')
  const acceptancePath = join(acceptanceDirectory, 'auth.json')
  const productionCredentials = JSON.stringify({ access_type: 'Bearer', access_token: 'production-token', refresh_token: 'production-refresh' })
  const acceptanceCredentials = { access_type: 'Bearer', access_token: 'stale-acceptance-token', refresh_token: 'acceptance-refresh' }
  writeFileSync(productionPath, productionCredentials)
  writeFileSync(acceptancePath, JSON.stringify(acceptanceCredentials))

  await withAuthServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ access_token: 'fresh-acceptance-token' }))
    })
  }, async authUrl => {
    await refreshStoredAuth(acceptanceCredentials, authUrl)
  })

  assert.equal(readFileSync(productionPath, 'utf8'), productionCredentials)
  assert.deepEqual(JSON.parse(readFileSync(acceptancePath, 'utf8')), {
    access_type: 'Bearer',
    access_token: 'fresh-acceptance-token',
    refresh_token: 'acceptance-refresh'
  })
})

void test('a 200 refresh response with a non-JSON body rejects instead of crashing', async t => {
  isolateAuthEnvironment(t, 'auth-refresh-html')

  await withAuthServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end('<html>sign-in moved</html>')
  }, async baseUrl => {
    await assert.rejects(
      refreshStoredAuth({ access_type: 'Bearer', access_token: 'stale-token', refresh_token: 'refresh-1' }, baseUrl),
      /invalid JSON/
    )
  })
})

void test('malformed successful refresh credentials are rejected without changing stored authentication', async t => {
  const directory = isolateAuthEnvironment(t, 'auth-refresh-malformed')

  const configDirectory = pokiConfigDirectory(directory)
  mkdirSync(configDirectory, { recursive: true })
  const stored = {
    access_type: 'Bearer',
    access_token: 'stale-token',
    refresh_token: 'refresh-1'
  }
  const storedText = JSON.stringify(stored)
  const authPath = join(configDirectory, 'auth.json')
  writeFileSync(authPath, storedText)

  const privateMarker = 'private-malformed-refresh-detail'
  const responses: unknown[] = [
    null,
    [],
    {},
    { access_token: '' },
    { access_token: '   ' },
    { access_token: 'fresh token' },
    { access_token: ' fresh-token ' },
    { access_token: 'fresh\u0000token' },
    { access_token: 'fresh\u001ftoken' },
    { access_token: 'fresh\u007ftoken' },
    { access_token: 'frésh-token' },
    { access_token: 123, private: privateMarker },
    { access_token: 'fresh-token', refresh_token: null },
    { access_token: 'fresh-token', refresh_token: '' },
    { access_token: 'fresh-token', refresh_token: 'bad refresh-token' },
    { access_token: 'fresh-token', refresh_token: 'refresh\u0000token' },
    { access_token: 'fresh-token', refresh_token: 'réfresh-token' },
    { access_token: 'fresh-token', access_type: 'Token' },
    { access_token: 'fresh-token', access_type: 42 }
  ]
  let responseIndex = 0
  await withAuthServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(responses[responseIndex++]))
    })
  }, async baseUrl => {
    for (let attempt = 0; attempt < responses.length; attempt++) {
      await assert.rejects(
        refreshStoredAuth(stored, baseUrl),
        (error: unknown) => error instanceof Error &&
          error.message === 'The authentication refresh returned invalid credentials.' &&
          !error.message.includes(privateMarker)
      )
      assert.equal(readFileSync(authPath, 'utf8'), storedText)
      assert.equal(responseIndex, attempt + 1)
    }
  })
  assert.equal(responseIndex, responses.length)
})

void test('a rejected refresh uses a generic public message and a missing token fails locally', async t => {
  isolateAuthEnvironment(t, 'auth-refresh-denied')

  await withAuthServer((_req, res) => {
    res.writeHead(401)
    res.end('refresh denied with private backend detail')
  }, async baseUrl => {
    await assert.rejects(
      refreshStoredAuth({ access_type: 'Bearer', access_token: 'stale-token', refresh_token: 'refresh-1' }, baseUrl),
      (error: unknown) => error instanceof Error &&
        error.message === 'Authentication refresh failed with status 401.' &&
        !error.message.includes('private backend detail')
    )
  })

  await assert.rejects(refreshStoredAuth({}), /No refresh token found/)
})

void test('a stalled refresh is bounded by the configured request timeout', async t => {
  isolateAuthEnvironment(t, 'auth-refresh-timeout')

  await withAuthServer((req, _res) => {
    req.resume()
  }, async baseUrl => {
    process.env.POKI_API_TIMEOUT_MS = '25'
    const startedAt = Date.now()
    await assert.rejects(
      refreshStoredAuth({ access_type: 'Bearer', access_token: 'stale-token', refresh_token: 'refresh-1' }, baseUrl),
      (error: unknown) => error instanceof Error &&
        error.message === 'The authentication refresh request exceeded 25 ms.'
    )
    assert.ok(Date.now() - startedAt < 1000)
  })
})

void test('an oversized refresh response is rejected without exposing its contents', async t => {
  const directory = isolateAuthEnvironment(t, 'auth-refresh-large')

  const privateMarker = 'private-response-marker'
  await withAuthServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    const payload = JSON.stringify({
      access_token: 'new-access-token',
      private: `${privateMarker}${'x'.repeat(70 * 1024)}`
    })
    // Two writes force chunked transfer so the streaming byte ceiling, not
    // only a declared Content-Length, protects the client.
    res.write(payload.slice(0, 1024))
    res.end(payload.slice(1024))
  }, async baseUrl => {
    await assert.rejects(
      refreshStoredAuth({ access_type: 'Bearer', access_token: 'stale-token', refresh_token: 'refresh-1' }, baseUrl),
      (error: unknown) => error instanceof Error &&
        error.message === 'The authentication refresh response was too large.' &&
        !error.message.includes(privateMarker)
    )
    assert.equal(existsSync(join(pokiConfigDirectory(directory), 'auth.json')), false)
  })
})

// Seeds a refreshable credential document and answers one /auth/refresh call
// with a fresh access token, so the persistence tests below only have to assert
// how writeStoredAuth publishes it.
async function withRefreshedCredentials (
  configDirectory: string,
  mode: number,
  run: (stored: Record<string, string>, storedText: string, authUrl: string) => Promise<void>
): Promise<void> {
  const stored = { access_type: 'Bearer', access_token: 'stale-token', refresh_token: 'refresh-1' }
  const storedText = JSON.stringify(stored)
  mkdirSync(configDirectory, { recursive: true })
  writeFileSync(join(configDirectory, 'auth.json'), storedText, 'utf8')
  chmodSync(join(configDirectory, 'auth.json'), mode)

  await withAuthServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ access_token: 'fresh-token' }))
    })
  }, async baseUrl => {
    await run(stored, storedText, baseUrl)
  })
}

void test('refreshed credentials are published atomically into an owner-only file', async t => {
  const directory = isolateAuthEnvironment(t, 'auth-atomic')

  const configDirectory = pokiConfigDirectory(directory)
  const authPath = join(configDirectory, 'auth.json')
  await withRefreshedCredentials(configDirectory, 0o644, async (stored, storedText, authUrl) => {
    const before = statSync(authPath).ino

    if (process.platform === 'win32') {
      // Windows does not let rename replace a destination while Node holds an
      // open descriptor for it. readStoredAuth reads and closes synchronously,
      // so publish after that reader has completed while still checking that
      // the destination inode is replaced instead of rewritten in place.
      await refreshStoredAuth(stored, authUrl)
    } else {
      // A descriptor opened before the refresh stands in for a concurrent
      // invocation that is already reading auth.json. Rewriting the destination
      // in place would truncate it and expose the fresh token through the
      // pre-existing world-readable inode, so that inode must keep both the
      // complete previous document and its old mode.
      const concurrentReader = openSync(authPath, 'r')
      try {
        await refreshStoredAuth(stored, authUrl)
        assert.equal(readFileSync(concurrentReader, 'utf8'), storedText)
        assert.equal(fstatSync(concurrentReader).mode & 0o777, 0o644)
      } finally {
        closeSync(concurrentReader)
      }
    }

    assert.equal(JSON.parse(readFileSync(authPath, 'utf8')).access_token, 'fresh-token')
    assert.notEqual(statSync(authPath).ino, before)
    assert.deepEqual(readdirSync(configDirectory), ['auth.json'])
    if (process.platform !== 'win32') {
      assert.equal(statSync(authPath).mode & 0o777, 0o600)
    }
  })
})

void test('a failed credential write returns the refreshed credentials and keeps the previous file usable', {
  skip: process.platform === 'win32' || process.getuid?.() === 0
    ? 'needs POSIX directory permissions enforced against a non-root user'
    : false
}, async t => {
  const directory = isolateAuthEnvironment(t, 'auth-write-denied')

  const configDirectory = pokiConfigDirectory(directory)
  const authPath = join(configDirectory, 'auth.json')
  await withRefreshedCredentials(configDirectory, 0o600, async (stored, storedText, authUrl) => {
    // A directory that forbids creating names blocks the temporary file. An
    // in-place rewrite would instead have succeeded here, because writing an
    // existing file needs no directory permission, and the reported failure
    // would have left destroyed credentials behind.
    chmodSync(configDirectory, 0o500)
    try {
      const refreshed = await refreshStoredAuth(stored, authUrl)
      assert.deepEqual(refreshed, { ...stored, access_token: 'fresh-token' })
      assert.equal(readFileSync(authPath, 'utf8'), storedText)
    } finally {
      chmodSync(configDirectory, 0o700)
    }
    assert.deepEqual(readdirSync(configDirectory), ['auth.json'])
  })
})

void test('a failed credential publication returns the refreshed credentials and leaves no temporary file behind', async t => {
  const directory = isolateAuthEnvironment(t, 'auth-publish-failure')

  const configDirectory = pokiConfigDirectory(directory)
  const authPath = join(configDirectory, 'auth.json')
  await withRefreshedCredentials(configDirectory, 0o600, async (stored, _storedText, authUrl) => {
    // Publication is the last step, so a destination that cannot be replaced
    // fails after the temporary file already holds the fresh token.
    rmSync(authPath)
    mkdirSync(authPath)
    const refreshed = await refreshStoredAuth(stored, authUrl)
    assert.deepEqual(refreshed, { ...stored, access_token: 'fresh-token' })
    assert.deepEqual(readdirSync(configDirectory), ['auth.json'])
    rmSync(authPath, { recursive: true })
  })
})

void test('login reads interactivity from stdin and stderr, not from the structured stdout channel', { timeout: 30000 }, async t => {
  const directory = isolateAuthEnvironment(t, 'auth-login-tty')

  const streams = [process.stdin, process.stdout, process.stderr]
  const original = streams.map(stream => stream.isTTY)
  t.after(() => streams.forEach((stream, index) => { stream.isTTY = original[index] }))

  // getConfigDir() resolves under a regular file, so interactiveLogin fails
  // while creating it: reaching that failure is what proves the guard accepted
  // the session instead of refusing it, and no browser or callback listener is
  // started on the way there.
  const blocked = join(directory, 'not-a-directory')
  writeFileSync(blocked, '')
  process.env[configHomeEnvironmentVariable] = blocked
  assert.equal(getConfigDir(), join(blocked, process.platform === 'win32' ? 'Poki' : 'poki'))

  // Redirecting stdout is how an agent captures the structured result, so it
  // must not decide whether a human can complete the browser flow.
  process.stdin.isTTY = false
  process.stdout.isTTY = false
  process.stderr.isTTY = true
  await assert.rejects(login(() => {}), (error: unknown) => error instanceof Error && !(error instanceof CliError))

  process.stdin.isTTY = true
  process.stderr.isTTY = false
  await assert.rejects(login(() => {}), (error: unknown) => error instanceof Error && !(error instanceof CliError))

  process.stdin.isTTY = false
  await assert.rejects(login(() => {}), (error: unknown) => error instanceof CliError &&
    error.code === 'AUTH_REQUIRED' &&
    error.hint === AUTH_LOGIN_USER_ACTION_HINT)
})
