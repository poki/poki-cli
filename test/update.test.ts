import assert from 'node:assert/strict'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { delimiter, join } from 'node:path'
import test, { TestContext } from 'node:test'

import { ApiClient } from '../src/api'
import { runInterruptCleanups } from '../src/errors'
import {
  compareSemver,
  stableUpdateAvailable,
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_LOCK_FILENAME,
  UPDATE_LOCK_STALE_MS,
  UpdateCoordinator,
  UpdateNoticeDocument,
  UPDATE_STATE_FILENAME
} from '../src/update'
import { apiHarness, authEnvironment, completion, jsonApi, parseToon, runCli, spawnCli, temporaryDirectory } from './helpers'

interface CapturedNotice {
  document: UpdateNoticeDocument
  format: 'toon' | 'json'
}

function enabledEnvironment (): NodeJS.ProcessEnv {
  return { POKI_CLI_UPDATE_CHECK: '1' }
}

function stateAt (directory: string): Record<string, any> {
  return JSON.parse(readFileSync(join(directory, UPDATE_STATE_FILENAME), 'utf8')) as Record<string, any>
}

function fakeNpmEnvironment (t: TestContext, directory: string, version = '9.0.0', delayMs = 0): NodeJS.ProcessEnv {
  if (process.platform === 'win32') {
    t.skip('the fake npm executable is POSIX-only')
    return {}
  }

  const binaryDirectory = join(directory, 'fake-bin')
  const executable = join(binaryDirectory, 'npm')
  const log = join(directory, 'npm-calls.jsonl')
  mkdirSync(binaryDirectory, { recursive: true })
  writeFileSync(executable, `#!/usr/bin/env node
const { appendFileSync } = require('node:fs')
appendFileSync(process.env.FAKE_NPM_LOG, JSON.stringify(process.argv.slice(2)) + '\\n')
setTimeout(() => process.stdout.write(JSON.stringify(process.env.FAKE_NPM_VERSION)), Number(process.env.FAKE_NPM_DELAY_MS))
`)
  chmodSync(executable, 0o755)
  return {
    PATH: `${binaryDirectory}${delimiter}${process.env.PATH ?? ''}`,
    POKI_CLI_UPDATE_CHECK: '1',
    FAKE_NPM_LOG: log,
    FAKE_NPM_VERSION: version,
    FAKE_NPM_DELAY_MS: String(delayMs)
  }
}

function npmCalls (directory: string): string[][] {
  const path = join(directory, 'npm-calls.jsonl')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as string[])
}

void test('semantic version comparison accepts stable and prerelease precedence and rejects invalid versions', () => {
  assert.equal(compareSemver('1.0.0', '1.0.0'), 0)
  assert.equal(compareSemver('1.0.0-alpha.1', '1.0.0-alpha.2'), -1)
  assert.equal(compareSemver('1.0.0-alpha.2', '1.0.0-alpha.beta'), -1)
  assert.equal(compareSemver('1.0.0-experimental.9', '1.0.0'), -1)
  assert.equal(compareSemver('2.0.0', '1.999.999'), 1)
  assert.equal(compareSemver('1.0.0+build.1', '1.0.0+build.2'), 0)
  assert.equal(compareSemver('1.0', '1.0.0'), undefined)
  assert.equal(compareSemver('1.0.0-01', '1.0.0'), undefined)

  assert.equal(stableUpdateAvailable('1.0.0', '1.0.1'), true)
  assert.equal(stableUpdateAvailable('1.0.0-experimental.0', '1.0.0'), true)
  assert.equal(stableUpdateAvailable('1.0.0-experimental.0', '0.9.0'), false)
  assert.equal(stableUpdateAvailable('1.0.0', '1.1.0-experimental.0'), false)
  assert.equal(stableUpdateAvailable('1.0.0', '1.0.0'), false)
  assert.equal(stableUpdateAvailable('1.0.1', '1.0.0'), false)
  assert.equal(stableUpdateAvailable('not-semver', '1.0.0'), false)
  assert.equal(stableUpdateAvailable('1.0.0', 'not-semver'), false)
})

void test('the lookup and prompt each renew only at the rolling 24-hour boundary', async t => {
  const directory = join(temporaryDirectory(t, 'update-cadence'), 'config')
  const firstInstant = Date.UTC(2026, 7, 16, 12)
  let now = firstInstant
  let lookups = 0
  const notices: CapturedNotice[] = []
  const dependencies = {
    now: () => now,
    configDirectory: () => directory,
    lookupLatest: async () => { lookups += 1; return '1.1.0' },
    writeNotice: (document: UpdateNoticeDocument, format: 'toon' | 'json') => { notices.push({ document, format }) },
    environment: enabledEnvironment()
  }

  const first = new UpdateCoordinator('1.0.0', 'json', dependencies)
  await first.beforeFirstRequest()
  await first.commandSucceeded()
  assert.equal(lookups, 1)
  assert.equal(notices.length, 1)
  assert.equal(stateAt(directory).last_attempt_at, new Date(firstInstant).toISOString())
  assert.equal(stateAt(directory).last_prompt_at, new Date(firstInstant).toISOString())

  now = firstInstant + UPDATE_CHECK_INTERVAL_MS - 1
  const suppressed = new UpdateCoordinator('1.0.0', 'json', dependencies)
  await suppressed.beforeFirstRequest()
  await suppressed.commandSucceeded()
  assert.equal(lookups, 1)
  assert.equal(notices.length, 1)

  now = firstInstant + UPDATE_CHECK_INTERVAL_MS
  const renewed = new UpdateCoordinator('1.0.0', 'json', dependencies)
  await renewed.beforeFirstRequest()
  await renewed.commandSucceeded()
  assert.equal(lookups, 2)
  assert.equal(notices.length, 2)
  assert.equal(stateAt(directory).last_attempt_at, new Date(now).toISOString())
  assert.equal(stateAt(directory).last_prompt_at, new Date(now).toISOString())
})

void test('a failed lookup is silent and suppresses another lookup for 24 hours', async t => {
  const directory = join(temporaryDirectory(t, 'update-failure'), 'config')
  const firstInstant = Date.UTC(2026, 7, 16, 12)
  let now = firstInstant
  let lookups = 0
  const notices: CapturedNotice[] = []
  mkdirSync(directory)
  writeFileSync(join(directory, UPDATE_STATE_FILENAME), JSON.stringify({
    schema_version: 1,
    last_attempt_at: new Date(firstInstant - UPDATE_CHECK_INTERVAL_MS).toISOString(),
    latest_version: '1.1.0',
    last_prompt_at: new Date(firstInstant - UPDATE_CHECK_INTERVAL_MS).toISOString()
  }))
  const dependencies = {
    now: () => now,
    configDirectory: () => directory,
    lookupLatest: async () => { lookups += 1; throw new Error('registry unavailable') },
    writeNotice: (document: UpdateNoticeDocument, format: 'toon' | 'json') => { notices.push({ document, format }) },
    environment: enabledEnvironment()
  }

  const failed = new UpdateCoordinator('1.0.0', 'json', dependencies)
  await failed.beforeFirstRequest()
  await failed.commandSucceeded()
  assert.equal(lookups, 1)
  assert.deepEqual(notices, [])
  assert.equal(stateAt(directory).last_attempt_at, new Date(firstInstant).toISOString())
  assert.equal(stateAt(directory).latest_version, undefined)

  now += UPDATE_CHECK_INTERVAL_MS - 1
  const suppressed = new UpdateCoordinator('1.0.0', 'json', dependencies)
  await suppressed.beforeFirstRequest()
  await suppressed.commandSucceeded()
  assert.equal(lookups, 1)
  assert.deepEqual(notices, [])
})

void test('corrupt and future-dated state recover without suppressing a current check', async t => {
  const base = temporaryDirectory(t, 'update-state-recovery')
  const now = Date.UTC(2026, 7, 16, 12)
  let lookups = 0

  for (const [name, contents] of [
    ['corrupt', '{not-json'],
    ['future', JSON.stringify({
      schema_version: 1,
      last_attempt_at: new Date(now + UPDATE_CHECK_INTERVAL_MS).toISOString(),
      latest_version: '1.1.0',
      last_prompt_at: new Date(now + UPDATE_CHECK_INTERVAL_MS).toISOString()
    })]
  ]) {
    const directory = join(base, name)
    mkdirSync(directory)
    writeFileSync(join(directory, UPDATE_STATE_FILENAME), contents)
    const notices: CapturedNotice[] = []
    const coordinator = new UpdateCoordinator('1.0.0', 'json', {
      now: () => now,
      configDirectory: () => directory,
      lookupLatest: async () => { lookups += 1; return '1.2.0' },
      writeNotice: (document, format) => { notices.push({ document, format }) },
      environment: enabledEnvironment()
    })
    await coordinator.beforeFirstRequest()
    await coordinator.commandSucceeded()

    assert.equal(notices.length, 1, name)
    assert.equal(stateAt(directory).latest_version, '1.2.0', name)
    assert.equal(stateAt(directory).last_attempt_at, new Date(now).toISOString(), name)
    assert.equal(stateAt(directory).last_prompt_at, new Date(now).toISOString(), name)
    assert.deepEqual(readdirSync(directory).filter(entry => entry.endsWith('.tmp')), [], name)
    if (process.platform !== 'win32') assert.equal(statSync(join(directory, UPDATE_STATE_FILENAME)).mode & 0o777, 0o600, name)
  }
  assert.equal(lookups, 2)
})

void test('opt-out performs no lookup, config resolution, state creation, or prompt', async () => {
  let configResolutions = 0
  let lookups = 0
  let notices = 0
  const coordinator = new UpdateCoordinator('1.0.0', 'json', {
    configDirectory: () => { configResolutions += 1; throw new Error('must not resolve') },
    lookupLatest: async () => { lookups += 1; return '2.0.0' },
    writeNotice: () => { notices += 1 },
    environment: { POKI_CLI_UPDATE_CHECK: '0' }
  })

  await coordinator.beforeFirstRequest()
  await coordinator.commandSucceeded()
  assert.equal(configResolutions, 0)
  assert.equal(lookups, 0)
  assert.equal(notices, 0)
})

void test('concurrent coordinators share one lookup and atomically claim one prompt', async t => {
  const directory = join(temporaryDirectory(t, 'update-concurrency'), 'config')
  const now = Date.now()
  let lookups = 0
  const notices: CapturedNotice[] = []
  const dependencies = {
    now: () => now,
    configDirectory: () => directory,
    lookupLatest: async () => {
      lookups += 1
      await new Promise(resolve => setTimeout(resolve, 75))
      return '2.0.0'
    },
    writeNotice: (document: UpdateNoticeDocument, format: 'toon' | 'json') => { notices.push({ document, format }) },
    environment: enabledEnvironment()
  }
  const coordinators = Array.from({ length: 4 }, () => new UpdateCoordinator('1.0.0', 'toon', dependencies))

  await Promise.all(coordinators.map(async coordinator => await coordinator.beforeFirstRequest()))
  await Promise.all(coordinators.map(async coordinator => await coordinator.commandSucceeded()))

  assert.equal(lookups, 1)
  assert.equal(notices.length, 1)
  assert.equal(notices[0].format, 'toon')
  assert.equal(notices[0].document.notice.available_version, '2.0.0')
  assert.equal(notices[0].document.notice.update_commands.global, 'npm install --global --ignore-scripts --no-audit --no-fund @poki/cli@2.0.0')
  assert.equal(notices[0].document.notice.update_commands.project_local, 'npm install --save-dev --ignore-scripts --no-audit --no-fund @poki/cli@2.0.0')
  assert.equal(notices[0].document.notice.completed_command_requires_rerun, false)
  assert.equal(existsSync(join(directory, UPDATE_LOCK_FILENAME)), false)
  assert.deepEqual(readdirSync(directory).filter(entry => entry.endsWith('.tmp')), [])
})

void test('an abandoned ten-minute lock is replaced and interrupt cleanup removes an owned lock', async t => {
  const base = temporaryDirectory(t, 'update-lock-recovery')
  const staleDirectory = join(base, 'stale')
  const now = Date.now()
  mkdirSync(staleDirectory)
  const staleLock = join(staleDirectory, UPDATE_LOCK_FILENAME)
  writeFileSync(staleLock, 'abandoned')
  const old = new Date(now - UPDATE_LOCK_STALE_MS - 1)
  utimesSync(staleLock, old, old)

  let staleLookups = 0
  const staleDependencies = {
    now: () => now,
    configDirectory: () => staleDirectory,
    lookupLatest: async () => {
      staleLookups += 1
      await new Promise(resolve => setTimeout(resolve, 50))
      return '1.0.0'
    },
    environment: enabledEnvironment()
  }
  const recovered = Array.from({ length: 4 }, () => new UpdateCoordinator('1.0.0', 'json', staleDependencies))
  await Promise.all(recovered.map(async coordinator => await coordinator.beforeFirstRequest()))
  await Promise.all(recovered.map(async coordinator => await coordinator.commandSucceeded()))
  assert.equal(staleLookups, 1)
  assert.equal(existsSync(staleLock), false)
  assert.equal(existsSync(`${staleLock}.stale-recovery`), false)

  const interruptedDirectory = join(base, 'interrupted')
  let rejectLookup: ((error: Error) => void) | undefined
  const interrupted = new UpdateCoordinator('1.0.0', 'json', {
    now: () => now,
    configDirectory: () => interruptedDirectory,
    lookupLatest: async () => await new Promise<string>((_resolve, reject) => { rejectLookup = reject }),
    environment: enabledEnvironment()
  })
  const checking = interrupted.beforeFirstRequest()
  const ownedLock = join(interruptedDirectory, UPDATE_LOCK_FILENAME)
  for (let attempts = 0; attempts < 100; attempts += 1) {
    if (rejectLookup !== undefined) break
    await new Promise(resolve => setImmediate(resolve))
  }
  assert.equal(existsSync(ownedLock), true)
  assert.notEqual(rejectLookup, undefined)
  runInterruptCleanups()
  assert.equal(existsSync(ownedLock), false)
  rejectLookup?.(new Error('interrupted'))
  await checking
  assert.deepEqual(readdirSync(interruptedDirectory).filter(entry => entry.endsWith('.tmp')), [])
})

void test('ApiClient runs its before-request hook once and not for an unauthenticated rejection', async () => {
  let hooks = 0
  let requests = 0
  const api = new ApiClient('https://example.invalid', {
    fetch: async () => {
      requests += 1
      return new Response(JSON.stringify({ data: null }), { status: 200 })
    },
    readAuth: () => ({ access_type: 'Bearer', access_token: 'token' }),
    refreshAuth: async config => config,
    beforeFirstRequest: async () => { hooks += 1 }
  })
  await api.request({ path: '/one' })
  await api.request({ path: '/two' })
  assert.equal(hooks, 1)
  assert.equal(requests, 2)

  let unauthenticatedHooks = 0
  const unauthenticated = new ApiClient('https://example.invalid', {
    fetch: async () => { throw new Error('must not fetch') },
    readAuth: () => undefined,
    refreshAuth: async config => config,
    beforeFirstRequest: async () => { unauthenticatedHooks += 1 }
  })
  await assert.rejects(async () => await unauthenticated.request({ path: '/no-auth' }))
  assert.equal(unauthenticatedHooks, 0)
})

void test('concurrent CLI processes make one npm query and emit one successful JSON notice', async t => {
  const handler = (_request: unknown, response: Parameters<typeof jsonApi>[0]): void => {
    jsonApi(response, { data: [] })
  }
  const harness = await apiHarness(t, handler, 'update-process-concurrency')
  const updateEnvironment = fakeNpmEnvironment(t, harness.directory, '9.0.0', 100)
  if (process.platform === 'win32') return
  const env = { ...harness.env, ...updateEnvironment }

  const firstCompletion = completion(spawnCli(['games', 'list', '--format', 'json'], { env }))
  const secondCompletion = completion(spawnCli(['games', 'list', '--format', 'json'], { env }))
  const results = await Promise.all([firstCompletion, secondCompletion])

  assert.ok(results.every(result => result.code === 0), results.map(result => result.stderr).join('\n'))
  assert.ok(results.every(result => JSON.parse(result.stdout).data.length === 0))
  assert.equal(npmCalls(harness.directory).length, 1)
  assert.deepEqual(npmCalls(harness.directory)[0], ['view', '@poki/cli', 'dist-tags.latest', '--json'])
  const prompts = results.filter(result => result.stderr !== '')
  assert.equal(prompts.length, 1)
  const notice = JSON.parse(prompts[0].stderr).notice
  assert.equal(notice.code, 'CLI_UPDATE_AVAILABLE')
  assert.equal(notice.available_version, '9.0.0')
  assert.equal(notice.channel, 'latest')
  assert.equal(notice.blocking, false)
  assert.equal(notice.completed_command_requires_rerun, false)
})

void test('raw and CSV stdout stay byte-identical when an update notice is emitted separately', async t => {
  if (process.platform === 'win32') {
    t.skip('the fake npm executable is POSIX-only')
    return
  }

  const cases: Array<{ name: string, args: string[], parseNotice: (value: string) => Record<string, any> }> = [
    { name: 'raw', args: ['games', 'list', '--raw', '--format', 'json'], parseNotice: value => JSON.parse(value) as Record<string, any> },
    { name: 'csv', args: ['games', 'list', '--format', 'csv'], parseNotice: parseToon }
  ]
  for (const value of cases) {
    const harness = await apiHarness(t, (_req, res) => {
      jsonApi(res, { data: [{ type: 'games', id: 'game-1', attributes: { title: 'Example' } }] })
    }, `update-${value.name}-output`)
    const fake = fakeNpmEnvironment(t, harness.directory)
    const baseline = await runCli(value.args, { env: { ...harness.env, POKI_CLI_UPDATE_CHECK: '0' } })
    const enabled = await runCli(value.args, { env: { ...harness.env, ...fake } })

    assert.equal(baseline.code, 0, baseline.stderr)
    assert.equal(enabled.code, 0, enabled.stderr)
    assert.equal(enabled.stdout, baseline.stdout, value.name)
    assert.equal(value.parseNotice(enabled.stderr).notice.code, 'CLI_UPDATE_AVAILABLE', value.name)
  }
})

void test('a failed API command emits only its structured error and does not claim the update prompt', async t => {
  const harness = await apiHarness(t, (_req, res) => {
    jsonApi(res, { errors: [{ status: '500', code: 'server-error', detail: 'failed' }] }, 500)
  }, 'update-api-failure')
  const fake = fakeNpmEnvironment(t, harness.directory)
  if (process.platform === 'win32') return
  const result = await runCli(['games', 'list', '--format', 'json'], { env: { ...harness.env, ...fake } })

  assert.equal(result.code, 5)
  assert.equal(result.stdout, '')
  const error = JSON.parse(result.stderr)
  assert.equal(error.error.code, 'SERVER_ERROR')
  assert.equal(error.notice, undefined)
  assert.equal(stateAt(join(harness.directory, 'poki')).last_prompt_at, undefined)
})

void test('offline, auth, preview, validation, and legacy invocations never run npm or create update state', async t => {
  if (process.platform === 'win32') {
    t.skip('the fake npm executable is POSIX-only')
    return
  }
  const directory = temporaryDirectory(t, 'update-exclusions')
  const project = join(directory, 'project')
  mkdirSync(project)
  writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'example' }))
  const configRoot = join(directory, 'config-root')
  const env = {
    ...authEnvironment(configRoot),
    ...fakeNpmEnvironment(t, directory)
  }
  const invocations: Array<{ args: string[], cwd?: string }> = [
    { args: ['help', 'updates', '--format', 'json'] },
    { args: ['--version'] },
    { args: ['context', '--format', 'json'], cwd: project },
    { args: ['audiences', 'list', '--format', 'json'] },
    { args: ['games', 'create', '--title', 'Example', '--team', 'team-1', '--dry-run', '--format', 'json'] },
    { args: ['data', 'run', 'game-users', '--team', 'team-1', '--game', 'game-1', '--last-days', '7', '--validate-only', '--format', 'json'] },
    { args: ['auth', 'status', '--format', 'json'] },
    { args: ['auth', 'login', '--format', 'json'] },
    { args: ['upload', '--game', 'game-1', '--build-dir', 'missing'], cwd: project }
  ]

  for (const invocation of invocations) {
    await runCli(invocation.args, { env, ...(invocation.cwd === undefined ? {} : { cwd: invocation.cwd }) })
  }

  assert.deepEqual(npmCalls(directory), [])
  assert.equal(existsSync(join(configRoot, 'poki', UPDATE_STATE_FILENAME)), false)
  assert.equal(existsSync(join(configRoot, 'poki', UPDATE_LOCK_FILENAME)), false)
})
