import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { apiHarness, authEnvironment, jsonApi, parseToon, runCli, temporaryDirectory } from './helpers'

interface CliErrorBody {
  code: string
  message: string
  details?: Record<string, any>
  retryable?: boolean
  hint?: string
}

function parseError (stderr: string): CliErrorBody {
  return (JSON.parse(stderr) as { error: CliErrorBody }).error
}

void test('an extra token after a leaf command returns the root command index instead of crashing', async () => {
  const result = await runCli(['whoami', 'foo', '--format', 'json'])
  assert.equal(result.code, 2, result.stderr)
  const error = parseError(result.stderr)
  assert.equal(error.code, 'INVALID_INPUT')
  assert.match(error.message, /Unknown command/)
  assert.doesNotMatch(error.message, /Cannot read properties/)
  const commands = error.details?.available_commands
  assert.ok(Array.isArray(commands))
  assert.ok(commands.length > 0)
})

void test('a near-miss subcommand suggests the correction and lists the group actions', async () => {
  const result = await runCli(['versions', 'activatee', 'X', '--format', 'json'])
  assert.equal(result.code, 2, result.stderr)
  const error = parseError(result.stderr)
  assert.equal(error.code, 'INVALID_INPUT')
  const suggestions = error.details?.suggestions
  assert.ok(Array.isArray(suggestions))
  assert.ok(suggestions.includes('poki versions activate'))
  const commands = error.details?.available_commands as Array<{ path: string }>
  assert.ok(Array.isArray(commands))
  assert.ok(commands.length > 0)
  for (const command of commands) assert.match(command.path, /^poki versions/)
})

void test('an unknown flag suggests the near-miss option and lists the legal option set', async () => {
  const result = await runCli(['versions', 'list', '--archive', 'all', '--game', 'g', '--format', 'json'])
  assert.equal(result.code, 2, result.stderr)
  const error = parseError(result.stderr)
  assert.equal(error.code, 'INVALID_INPUT')
  assert.equal(error.message, 'Unknown argument: --archive')
  const suggestions = error.details?.suggestions
  assert.ok(Array.isArray(suggestions))
  assert.ok(suggestions.includes('--archived'))
  const options = error.details?.available_options
  assert.ok(Array.isArray(options))
  assert.ok(options.length > 0)
  assert.ok(options.includes('--archived'))
  assert.match(error.hint ?? '', /poki help versions list/)
})

void test('-h consumed as an option value is rejected as input rather than answered with help', async () => {
  const rejected = await runCli(['playtest-recordings', 'update', 'REC', '--game', 'g', '--tag', '-h', '--format', 'json'])
  assert.equal(rejected.code, 2, rejected.stderr)
  assert.equal(parseError(rejected.stderr).code, 'INVALID_INPUT')
  assert.doesNotMatch(rejected.stdout, /usage/)

  const help = await runCli(['versions', 'list', '-h', '--format', 'json'])
  assert.equal(help.code, 0, help.stderr)
  const document = JSON.parse(help.stdout) as { command: string, usage: string }
  assert.equal(document.command, 'poki versions list')
  assert.ok(document.usage.length > 0)
})

void test('help with junk after a leaf topic still returns the available command index', async () => {
  const result = await runCli(['help', 'version', 'zzz', '--format', 'json'])
  assert.equal(result.code, 2, result.stderr)
  const error = parseError(result.stderr)
  assert.equal(error.code, 'INVALID_INPUT')
  const commands = error.details?.available_commands
  assert.ok(Array.isArray(commands))
  assert.ok(commands.length > 0)
})

void test('a filesystem fault inside a handler surfaces as exit 5 UNEXPECTED_ERROR, not INVALID_INPUT', async t => {
  const directory = temporaryDirectory(t, 'eisdir')
  mkdirSync(join(directory, 'poki.json'))
  const result = await runCli(['init', '--game', 'g', '--force', '--format', 'json'], { cwd: directory })
  assert.equal(result.code, 5, result.stderr)
  assert.equal(parseError(result.stderr).code, 'UNEXPECTED_ERROR')
})

void test('a grammar violation embeds the legal aggregate set and points at data describe', async () => {
  const result = await runCli([
    'data', 'query',
    '--query', '{"from":"dbt_p4d_gameplays","select":[{"field":"g","aggregate":"total"}]}',
    '--validate-only', '--format', 'json'
  ])
  assert.equal(result.code, 2, result.stderr)
  const error = parseError(result.stderr)
  assert.equal(error.code, 'INVALID_INPUT')
  const aggregates = error.details?.supported_aggregates
  assert.ok(Array.isArray(aggregates))
  assert.ok(aggregates.includes('sum'))
  assert.match(error.hint ?? '', /data describe select/)
})

void test('unresolved recipe placeholders name the recipe to inspect', async () => {
  const result = await runCli(['data', 'run', 'game-users', '--validate-only', '--format', 'json'])
  assert.equal(result.code, 2, result.stderr)
  const error = parseError(result.stderr)
  assert.equal(error.code, 'INVALID_INPUT')
  const placeholders = error.details?.unresolved_placeholders
  assert.ok(Array.isArray(placeholders))
  assert.ok(placeholders.length > 0)
  assert.match(error.hint ?? '', /poki data recipe game-users/)
})

void test('a missing resource id returns NOT_FOUND with a hint to list visible IDs', async t => {
  const { env } = await apiHarness(t, (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (req.method === 'GET' && url.pathname === '/games/g/playtest-recordings') {
      jsonApi(res, { data: [] })
      return
    }
    res.writeHead(404)
    res.end()
  }, 'not-found')
  const result = await runCli(['playtest-recordings', 'get', 'missing-id', '--game', 'g', '--format', 'json'], { env })
  assert.equal(result.code, 4, result.stderr)
  const error = parseError(result.stderr)
  assert.equal(error.code, 'NOT_FOUND')
  assert.match(error.hint ?? '', /playtest-recordings list/)
})

void test('an explicit backend permission denial includes command requirements without a preflight request', async t => {
  let requests = 0
  const { env } = await apiHarness(t, (_req, res) => {
    requests++
    jsonApi(res, {
      errors: [{
        status: '403',
        code: 'permission-denied',
        title: 'Permission denied',
        detail: 'This credential cannot access the requested resource.',
        source: { pointer: '/data/id' },
        meta: {
          required_permissions: ['can_read_owned_games'],
          granted_permissions: ['can_read_owned_versions'],
          internal_acl_result: 'denied'
        }
      }],
      meta: {
        required_permissions: ['can_read_owned_games'],
        granted_permissions: ['can_read_owned_versions']
      }
    }, 403)
  }, 'permission-denied')
  const result = await runCli(['games', 'get', 'game-1', '--format', 'json'], { env })

  assert.equal(result.code, 4, result.stderr)
  assert.equal(result.stdout, '')
  assert.equal(requests, 1)
  const error = parseError(result.stderr)
  assert.equal(error.code, 'PERMISSION_DENIED')
  assert.match(error.message, /current credentials do not have permission/)
  assert.equal(error.details?.command, 'poki games get')
  assert.deepEqual(error.details?.permission_codes, ['can_read_owned_games'])
  assert.deepEqual(
    error.details?.permission_requirements?.map((permission: { code: string }) => permission.code),
    ['can_read_owned_games']
  )
  assert.deepEqual(error.details?.api_response, {
    errors: [{
      status: '403',
      code: 'permission-denied',
      title: 'Permission denied',
      detail: 'This credential cannot access the requested resource.'
    }]
  })
  assert.doesNotMatch(JSON.stringify(error), /required_permissions|granted_permissions|internal_acl_result|pointer/)
  assert.match(error.hint ?? '', /poki whoami/)
  assert.match(error.hint ?? '', /poki help games get/)
})

void test('auth login refuses promptly without an interactive terminal', { timeout: 30000 }, async () => {
  const result = await runCli(['auth', 'login', '--format', 'json'])
  assert.equal(result.code, 3, result.stderr)
  const error = parseError(result.stderr)
  assert.equal(error.code, 'AUTH_REQUIRED')
  assert.match(error.hint ?? '', /interactive terminal/)
})

void test('whoami returns normalized user data and sends the stored bearer token', async t => {
  let authorization: string | undefined
  const { env } = await apiHarness(t, (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (req.method === 'GET' && url.pathname === '/users/@me') {
      authorization = req.headers.authorization
      jsonApi(res, {
        data: {
          type: 'users',
          id: 'u1',
          attributes: {
            name: 'Erik',
            team_id: 'team-1',
            role: 'admin',
            disabled_at: 123,
            last_seen: 456
          }
        },
        meta: {
          total: 1,
          failed: [],
          permissions: ['can_read_self', 'can_read_owned_games', 'can_read_all_games', 'can_read_owned_ab_tests', 'can_request_web_fit_test'],
          impersonator: { id: 'admin-1', name: 'Support' },
          new: true,
          has_custom_csp: true,
          future_internal_key: { secret: true }
        }
      })
      return
    }
    res.writeHead(404)
    res.end()
  }, 'whoami')
  const result = await runCli(['whoami', '--format', 'json'], { env })
  assert.equal(result.code, 0, result.stderr)
  const parsed = JSON.parse(result.stdout) as { data: Record<string, unknown>, meta: { total: number, failed: unknown[], permissions: string[] } }
  assert.equal(parsed.data.id, 'u1')
  assert.deepEqual(parsed.data, { type: 'users', id: 'u1', name: 'Erik', team_id: 'team-1' })
  assert.equal(parsed.meta.total, 1)
  assert.deepEqual(parsed.meta.failed, [])
  assert.deepEqual(parsed.meta.permissions, ['can_read_self', 'can_read_owned_games'])
  assert.deepEqual(Object.keys(parsed.meta).sort(), ['failed', 'permissions', 'total'])

  const raw = await runCli(['whoami', '--raw', '--format', 'json'], { env })
  assert.equal(raw.code, 0, raw.stderr)
  const rawDocument = JSON.parse(raw.stdout) as Record<string, any>
  assert.equal(rawDocument.data.attributes.role, 'admin')
  assert.ok(rawDocument.meta.permissions.includes('can_read_all_games'))
  assert.equal(rawDocument.meta.impersonator.id, 'admin-1')
  assert.equal(rawDocument.meta.new, true)
  assert.equal(rawDocument.meta.has_custom_csp, true)
  assert.deepEqual(rawDocument.meta.future_internal_key, { secret: true })
  assert.equal(authorization, 'Bearer test-token')
})

void test('a non-base64 analytics CSV body fails as INVALID_API_RESPONSE instead of emitting garbage', async t => {
  const { env } = await apiHarness(t, (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (req.method === 'POST' && url.pathname === '/_data') {
      res.writeHead(200, { 'Content-Type': 'text/csv;base64' })
      res.end('this is not base64!!')
      return
    }
    res.writeHead(404)
    res.end()
  }, 'csv')
  const result = await runCli([
    'data', 'query',
    '--query', '{"from":"dbt_p4d_gameplays","select":[{"field":"date"}]}',
    '--format', 'csv'
  ], { env })
  assert.equal(result.code, 5, result.stderr)
  assert.ok(result.stderr.includes('INVALID_API_RESPONSE'), result.stderr)
  assert.doesNotMatch(result.stderr, /this is not base64/)
  assert.deepEqual(parseToon(result.stderr).error.details, {
    expected: 'base64_text',
    received: { kind: 'string', length: 20 }
  })
})

void test('an analytics network failure is reported as retryable', async t => {
  const directory = temporaryDirectory(t, 'analytics-network')
  const env = authEnvironment(directory)
  const result = await runCli([
    'data', 'query',
    '--query', '{"from":"dbt_p4d_gameplays","select":[{"field":"date"}]}',
    '--format', 'json'
  ], { env })
  assert.equal(result.code, 5, result.stderr)
  const error = parseError(result.stderr)
  assert.equal(error.code, 'NETWORK_ERROR')
  assert.equal(error.retryable, true)
})
