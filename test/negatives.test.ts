import assert from 'node:assert/strict'
import test, { TestContext } from 'node:test'

import { authEnvironment, parseToon, runCli, temporaryDirectory } from './helpers'

interface CliErrorBody {
  code: string
  message: string
}

function jsonError (stderr: string): CliErrorBody {
  return (JSON.parse(stderr) as { error: CliErrorBody }).error
}

function toonError (stderr: string): CliErrorBody {
  return (parseToon(stderr) as { error: CliErrorBody }).error
}

// Stored credentials plus the harness's unroutable default API URL: if a case
// under test failed to validate locally, the CLI would proceed to a request
// and die with NETWORK_ERROR (exit 5), so asserting exit 2 proves the local
// validation fired before any network activity.
function offlineAuth (t: TestContext): NodeJS.ProcessEnv {
  const directory = temporaryDirectory(t, 'negatives')
  return authEnvironment(directory)
}

void test('invalid enum values are rejected locally with the valid choices named', async t => {
  const env = offlineAuth(t)
  const cases: Array<{ args: string[], toon?: boolean, pattern: RegExp }> = [
    {
      args: ['versions', 'list', '--archived', 'bogus', '--game', 'g', '--format', 'json'],
      pattern: /Choices:.*"active".*"archived".*"all"/s
    },
    {
      args: ['playtest-requests', 'create', '--version', 'v', '--device-category', 'console', '--game', 'g', '--format', 'json'],
      pattern: /Choices:.*"any".*"mobile".*"desktop".*"tablet"/s
    },
    {
      args: ['playtest-requests', 'create', '--version', 'v', '--orientation', 'sideways', '--game', 'g', '--format', 'json'],
      pattern: /Choices:.*"both".*"portrait".*"landscape"/s
    },
    {
      args: ['versions', 'download', 'VER', '--type', 'neither', '--game', 'g', '--format', 'json'],
      pattern: /Choices:.*"source".*"hosted"/s
    },
    // The invalid value under test is the --format itself, so the error falls
    // back to the default TOON encoding on stderr.
    { args: ['help', '--format', 'yaml'], toon: true, pattern: /toon or json/ },
    { args: ['upload', '--game', 'g', '--format', 'weird'], toon: true, pattern: /Unknown argument: --format/ }
  ]
  await Promise.all(cases.map(async ({ args, toon, pattern }) => {
    const label = args.join(' ')
    const result = await runCli(args, { env })
    assert.equal(result.code, 2, `${label}: ${result.stderr}`)
    const error = toon === true ? toonError(result.stderr) : jsonError(result.stderr)
    assert.equal(error.code, 'INVALID_INPUT', label)
    assert.match(error.message, pattern, `${label}: ${error.message}`)
  }))
})

void test('malformed --filter values fail before any request with the field=value contract', async t => {
  const env = offlineAuth(t)
  const filters = ['title', '=value', 'bad field=x', 'title=']
  await Promise.all(filters.map(async filter => {
    const result = await runCli(['versions', 'list', '--game', 'g', '--filter', filter, '--format', 'json'], { env })
    assert.equal(result.code, 2, `--filter ${filter}: ${result.stderr}`)
    const error = jsonError(result.stderr)
    assert.equal(error.code, 'INVALID_INPUT', filter)
    assert.match(error.message, /Use field=value/, filter)
  }))
})

void test('an invalid --fields list fails locally', async t => {
  const env = offlineAuth(t)
  const result = await runCli(['versions', 'list', '--game', 'g', '--fields', 'id,bad field', '--format', 'json'], { env })
  assert.equal(result.code, 2, result.stderr)
  const error = jsonError(result.stderr)
  assert.equal(error.code, 'INVALID_INPUT')
  assert.match(error.message, /--fields/)
})

void test('out-of-bounds numeric options fail locally and name the offending flag', async t => {
  const env = offlineAuth(t)
  const cases: Array<{ args: string[], flag: string }> = [
    { args: ['versions', 'get', 'VER', '--timeout-ms', '0'], flag: '--timeout-ms' },
    { args: ['versions', 'get', 'VER', '--timeout-ms', '2147483648'], flag: '--timeout-ms' },
    { args: ['data', 'run', 'game-users', '--timeout-ms', '2147483648'], flag: '--timeout-ms' },
    { args: ['versions', 'list', '--game', 'g', '--page-size', '0'], flag: '--page-size' },
    { args: ['versions', 'list', '--game', 'g', '--max-pages', '0'], flag: '--max-pages' },
    { args: ['versions', 'list', '--game', 'g', '--max-items', '0'], flag: '--max-items' },
    { args: ['versions', 'list', '--game', 'g', '--page', '0'], flag: '--page' },
    { args: ['versions', 'get', 'VER', '--wait', '--poll-interval-ms', '0'], flag: '--poll-interval-ms' },
    { args: ['versions', 'get', 'VER', '--wait', '--poll-interval-ms', '2147483648'], flag: '--poll-interval-ms' },
    { args: ['versions', 'get', 'VER', '--wait', '--wait-timeout-ms', '0'], flag: '--wait-timeout-ms' },
    { args: ['versions', 'get', 'VER', '--wait', '--wait-timeout-ms', '2147483648'], flag: '--wait-timeout-ms' },
    { args: ['data', 'run', 'game-users', '--limit', '0'], flag: '--limit' },
    { args: ['data', 'run', 'game-users', '--limit', '1e30'], flag: '--limit' },
    { args: ['data', 'run', 'game-users', '--offset', '1e30'], flag: '--offset' },
    { args: ['data', 'run', 'game-users', '--offset', '-1'], flag: '--offset' }
  ]
  await Promise.all(cases.map(async ({ args, flag }) => {
    const label = args.join(' ')
    const result = await runCli([...args, '--format', 'json'], { env })
    assert.equal(result.code, 2, `${label}: ${result.stderr}`)
    const error = jsonError(result.stderr)
    assert.equal(error.code, 'INVALID_INPUT', label)
    assert.ok(error.message.includes(flag), `${label}: ${error.message}`)
  }))
})

void test('conflicting flag combinations fail before any request', async t => {
  const env = offlineAuth(t)

  // --format csv is the flag under test, so this error arrives as TOON.
  const csv = await runCli(['data', 'query', '--query', '{}', '--validate-only', '--format', 'csv'], { env })
  assert.equal(csv.code, 2, csv.stderr)
  const csvError = toonError(csv.stderr)
  assert.equal(csvError.code, 'INVALID_INPUT')
  assert.match(csvError.message, /requires query execution/)

  const full = await runCli(['help', '--full', '--format', 'json'], { env })
  assert.equal(full.code, 2, full.stderr)
  const fullError = jsonError(full.stderr)
  assert.equal(fullError.code, 'INVALID_INPUT')
  assert.match(fullError.message, /--full requires --all/)

  const allPage = await runCli(['versions', 'list', '--game', 'g', '--all', '--page', '2', '--format', 'json'], { env })
  assert.equal(allPage.code, 2, allPage.stderr)
  const allPageError = jsonError(allPage.stderr)
  assert.equal(allPageError.code, 'INVALID_INPUT')
  assert.match(allPageError.message, /cannot be combined with --page/)
})

void test('unsupported list fields and filter values fail before requests', async t => {
  const env = offlineAuth(t)
  for (const args of [
    ['versions', 'list', '--game', 'g', '--filter', 'activated_at=null'],
    ['versions', 'list', '--game', 'g', '--filter', 'label=full_like:example'],
    ['versions', 'list', '--game', 'g', '--sort', 'activated_at'],
    ['netlib-lobbies', 'list', '--game', 'g', '--filter', 'id=g-code'],
    ['netlib-lobbies', 'list', '--game', 'g', '--sort', 'id'],
    ['versions', 'list', '--game', 'g', '--filter', 'label=release:beta']
  ]) {
    const result = await runCli([...args, '--format', 'json'], { env })
    assert.equal(result.code, 2, result.stderr)
    assert.equal(jsonError(result.stderr).code, 'INVALID_INPUT')
  }
})

void test('invalid analytics grouping, function arguments, and integer ranges fail offline', async t => {
  const env = offlineAuth(t)
  const queries = [
    { select: [{ field: 'date' }, { aggregate: 'count', alias: 'n' }] },
    { select: [{ alias: 'bad', function: { name: 'number', args: [{ constant: '1' }, { constant: '2' }, { constant: '3' }] } }] },
    { select: [{ alias: 'bad', function: { name: 'lower', args: [{ field: 'gameplays' }] } }] },
    { select: [{ field: 'date' }], limit: 1e30 },
    { select: [{ field: 'date' }], offset: 1e30 },
    { select: [{ aggregate: 'sum', alias: 'n', function: { name: 'number', args: [{ aggregate: 'count' }] } }] },
    { select: [{ field: 'date' }], where: { expressions: [[{ aggregate: 'count', alias: 'n' }, '>', 0]] } },
    { select: [{ field: 'date' }], where: { expressions: [['country_id', 'has', 'US']] } },
    { select: [{ aggregate: 'count', alias: 'metrics.total' }] }
  ]
  for (const query of queries) {
    const result = await runCli(['data', 'query', '--query', JSON.stringify({ from: 'dbt_p4d_gameplays', ...query }), '--format', 'json'], { env })
    assert.equal(result.code, 2, result.stderr)
    assert.equal(jsonError(result.stderr).code, 'INVALID_INPUT')
  }
})
