import assert from 'node:assert/strict'
import { decode } from '@toon-format/toon'
import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { createServer, IncomingMessage, RequestListener, Server, ServerResponse } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { TestContext } from 'node:test'

import { getConfigDir } from '../src/config'

export interface RunResult {
  code: number
  stdout: string
  stderr: string
}

export const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const entry = join(repository, 'test/cli-entry.ts')
const productEntry = join(repository, 'src/index.ts')
const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx', { paths: [repository] })).href

// Spawned CLIs must never observe a developer's exported service configuration
// or their real platform config directory, so tests stay hermetic on any machine.
// The private entry point injects unroutable API/auth URLs by default; the
// production executable has no corresponding environment override.
export const UNROUTABLE_URL = 'http://127.0.0.1:1'

export const configHomeEnvironmentVariable = process.platform === 'win32'
  ? 'LOCALAPPDATA'
  : 'XDG_CONFIG_HOME'

export function configHomeEnvironment (root: string): NodeJS.ProcessEnv {
  return { [configHomeEnvironmentVariable]: root }
}

export function pokiConfigDirectory (root: string): string {
  return getConfigDir(configHomeEnvironment(root))
}

// The private config directory only exists for the lifetime of the CLI process
// it belongs to, so `discard` is the moment it is provably unobservable.
function hermeticEnvironment (): { environment: NodeJS.ProcessEnv, discard: () => void } {
  const environment: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('POKI_') || key === 'SERVICE_ENV' || key === 'XDG_CONFIG_HOME' || key === 'LOCALAPPDATA') continue
    environment[key] = value
  }
  const configHome = mkdtempSync(join(tmpdir(), 'poki-cli-test-'))
  Object.assign(environment, configHomeEnvironment(configHome))
  environment.POKI_CLI_TEST_API_URL = UNROUTABLE_URL
  environment.POKI_CLI_TEST_AUTH_URL = UNROUTABLE_URL
  // Update checks are tested explicitly. Every other test stays offline and
  // cannot accidentally contact npm merely because it executes an API command.
  environment.POKI_CLI_UPDATE_CHECK = '0'
  return { environment, discard: () => rmSync(configHome, { recursive: true, force: true }) }
}

async function runEntry (entryPath: string, args: string[], options: { env?: NodeJS.ProcessEnv, cwd?: string, stdin?: string }): Promise<RunResult> {
  const hermetic = hermeticEnvironment()
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', tsx, entryPath, ...args], {
        cwd: options.cwd ?? repository,
        env: { ...hermetic.environment, ...options.env },
        stdio: 'pipe'
      })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', chunk => { stdout += String(chunk) })
      child.stderr.on('data', chunk => { stderr += String(chunk) })
      child.on('error', reject)
      child.on('close', code => resolve({ code: code ?? -1, stdout, stderr }))
      child.stdin.end(options.stdin)
    })
  } finally {
    hermetic.discard()
  }
}

export async function runCli (args: string[], options: { env?: NodeJS.ProcessEnv, cwd?: string, stdin?: string } = {}): Promise<RunResult> {
  return await runEntry(entry, args, options)
}

export async function runProductCli (args: string[], options: { env?: NodeJS.ProcessEnv, cwd?: string, stdin?: string } = {}): Promise<RunResult> {
  return await runEntry(productEntry, args, options)
}

// Process-level tests need the child itself - to signal it, or to close its
// stdout pipe - so they spawn the CLI instead of awaiting runCli. The
// environment stays hermetic in exactly the same way, and the child's own exit
// - not a call the test has to remember - releases its config directory.
export function spawnCli (args: string[], options: { env?: NodeJS.ProcessEnv, preload?: string } = {}): ChildProcessWithoutNullStreams {
  const hermetic = hermeticEnvironment()
  const preload = options.preload === undefined ? [] : ['--import', pathToFileURL(options.preload).href]
  const child = spawn(process.execPath, ['--import', tsx, ...preload, entry, ...args], {
    cwd: repository,
    env: { ...hermetic.environment, ...options.env },
    stdio: 'pipe'
  })
  child.on('close', hermetic.discard)
  child.on('error', hermetic.discard)
  return child
}

// Attaches the output collectors synchronously so a caller can still interact
// with the running child before awaiting its result.
export async function completion (child: ChildProcessWithoutNullStreams): Promise<RunResult> {
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += String(chunk) })
  child.stderr.on('data', chunk => { stderr += String(chunk) })
  return await new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', code => resolve({ code: code ?? -1, stdout, stderr }))
  })
}

export function jsonApi (res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/vnd.api+json' })
  res.end(JSON.stringify(data))
}

export async function requestBody (req: IncomingMessage): Promise<Record<string, unknown>> {
  let body = ''
  for await (const chunk of req) body += String(chunk)
  return JSON.parse(body) as Record<string, unknown>
}

// Starts the server on an ephemeral loopback port, closes it when the test
// ends, and returns the base URL for the private test client.
export async function listen (t: TestContext, server: Server): Promise<string> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const address = server.address()
  assert.ok(address !== null && typeof address !== 'string')
  return `http://127.0.0.1:${address.port}`
}

export function authEnvironment (root: string, apiUrl?: string): NodeJS.ProcessEnv {
  const config = pokiConfigDirectory(root)
  mkdirSync(config, { recursive: true })
  writeFileSync(join(config, 'auth.json'), JSON.stringify({ access_type: 'Bearer', access_token: 'test-token' }))
  return {
    ...configHomeEnvironment(root),
    ...(apiUrl === undefined ? {} : { POKI_CLI_TEST_API_URL: apiUrl })
  }
}

// A scratch directory that lives exactly as long as the test. The slug only
// has to identify the test in a directory listing while it exists.
export function temporaryDirectory (t: TestContext, slug: string): string {
  const directory = mkdtempSync(join(tmpdir(), `poki-cli-${slug}-`))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}

export interface ApiHarness {
  directory: string
  env: NodeJS.ProcessEnv
}

// The setup nearly every CLI test wants: an authenticated config directory and
// a stub API on a loopback port, both released when the test ends. Tests that
// need the pieces apart - two servers, no credentials, a handler that needs its
// own base URL - should keep composing listen and authEnvironment by hand.
export async function apiHarness (t: TestContext, handler: RequestListener, slug: string): Promise<ApiHarness> {
  const directory = temporaryDirectory(t, slug)
  const apiUrl = await listen(t, createServer(handler))
  return { directory, env: authEnvironment(directory, apiUrl) }
}

export function parseToon (value: string): Record<string, any> {
  return decode(value) as Record<string, any>
}
