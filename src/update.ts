import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'

import { getConfigDir } from './config'
import { registerInterruptCleanup } from './errors'
import { StructuredFormat, structuredString } from './output'

export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
export const UPDATE_LOCK_STALE_MS = 10 * 60 * 1000
export const UPDATE_STATE_FILENAME = 'update-check.json'
export const UPDATE_LOCK_FILENAME = 'update-check.lock'

const UPDATE_LOCK_WAIT_MS = 6_000
const UPDATE_LOCK_POLL_MS = 25
const NPM_LOOKUP_TIMEOUT_MS = 5_000
const MAX_NPM_OUTPUT_BYTES = 64 * 1024
const MAX_STATE_BYTES = 64 * 1024

interface ParsedSemver {
  major: bigint
  minor: bigint
  patch: bigint
  prerelease: string[]
}

export interface UpdateState {
  schema_version: 1
  last_attempt_at?: string
  latest_version?: string
  last_prompt_at?: string
}

export interface UpdateNoticeDocument {
  notice: {
    code: 'CLI_UPDATE_AVAILABLE'
    message: 'A newer stable Poki CLI is available.'
    blocking: false
    current_version: string
    available_version: string
    channel: 'latest'
    update_commands: {
      global: string
      project_local: string
    }
    verify_commands: {
      global: 'poki --version'
      project_local: 'npx @poki/cli --version'
    }
    completed_command_requires_rerun: false
  }
}

export interface UpdateCoordinatorDependencies {
  now: () => number
  configDirectory: () => string
  lookupLatest: () => Promise<string>
  writeNotice: (document: UpdateNoticeDocument, format: StructuredFormat) => void
  environment: NodeJS.ProcessEnv
  sleep: (milliseconds: number) => Promise<void>
  lockToken: () => string
}

function parseSemver (version: string): ParsedSemver | undefined {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(version)
  if (match === null) return undefined

  const prerelease = match[4]?.split('.') ?? []
  if (prerelease.some(identifier => /^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith('0'))) return undefined

  return {
    major: BigInt(match[1]),
    minor: BigInt(match[2]),
    patch: BigInt(match[3]),
    prerelease
  }
}

function compareIdentifier (left: string, right: string): number {
  const leftNumeric = /^\d+$/.test(left)
  const rightNumeric = /^\d+$/.test(right)
  if (leftNumeric && rightNumeric) {
    const leftNumber = BigInt(left)
    const rightNumber = BigInt(right)
    return leftNumber < rightNumber ? -1 : leftNumber > rightNumber ? 1 : 0
  }
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
  return left < right ? -1 : left > right ? 1 : 0
}

export function compareSemver (left: string, right: string): number | undefined {
  const parsedLeft = parseSemver(left)
  const parsedRight = parseSemver(right)
  if (parsedLeft === undefined || parsedRight === undefined) return undefined

  for (const field of ['major', 'minor', 'patch'] as const) {
    if (parsedLeft[field] < parsedRight[field]) return -1
    if (parsedLeft[field] > parsedRight[field]) return 1
  }

  if (parsedLeft.prerelease.length === 0 || parsedRight.prerelease.length === 0) {
    if (parsedLeft.prerelease.length === parsedRight.prerelease.length) return 0
    return parsedLeft.prerelease.length === 0 ? 1 : -1
  }

  const identifiers = Math.max(parsedLeft.prerelease.length, parsedRight.prerelease.length)
  for (let index = 0; index < identifiers; index += 1) {
    const leftIdentifier = parsedLeft.prerelease[index]
    const rightIdentifier = parsedRight.prerelease[index]
    if (leftIdentifier === undefined || rightIdentifier === undefined) {
      return leftIdentifier === rightIdentifier ? 0 : leftIdentifier === undefined ? -1 : 1
    }
    const compared = compareIdentifier(leftIdentifier, rightIdentifier)
    if (compared !== 0) return compared
  }
  return 0
}

export function stableUpdateAvailable (currentVersion: string, latestVersion: string): boolean {
  const latest = parseSemver(latestVersion)
  if (latest === undefined || latest.prerelease.length > 0) return false
  return compareSemver(currentVersion, latestVersion) === -1
}

async function npmLatestVersion (): Promise<string> {
  return await new Promise((resolve, reject) => {
    let unregisterInterrupt = (): void => {}
    const executable = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    const child = execFile(executable, ['view', '@poki/cli', 'dist-tags.latest', '--json'], {
      encoding: 'utf8',
      maxBuffer: MAX_NPM_OUTPUT_BYTES,
      shell: false,
      timeout: NPM_LOOKUP_TIMEOUT_MS,
      windowsHide: true
    }, (error, stdout) => {
      unregisterInterrupt()
      if (error !== null) {
        reject(error)
        return
      }
      try {
        const value: unknown = JSON.parse(stdout)
        if (typeof value !== 'string') throw new Error('npm returned a non-string latest tag')
        resolve(value)
      } catch (parseError) {
        reject(parseError)
      }
    })
    unregisterInterrupt = registerInterruptCleanup(() => { child.kill('SIGTERM') })
  })
}

function defaultWriteNotice (document: UpdateNoticeDocument, format: StructuredFormat): void {
  process.stderr.write(structuredString(document, format))
}

function timestamp (value: unknown, now: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds) || milliseconds > now) return undefined
  return new Date(milliseconds).toISOString()
}

function normalizedState (value: unknown, now: number): UpdateState {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { schema_version: 1 }
  const source = value as Record<string, unknown>
  const lastAttempt = timestamp(source.last_attempt_at, now)
  const lastPrompt = timestamp(source.last_prompt_at, now)
  const latest = typeof source.latest_version === 'string' && parseSemver(source.latest_version)?.prerelease.length === 0
    ? source.latest_version
    : undefined
  return {
    schema_version: 1,
    ...(lastAttempt === undefined ? {} : { last_attempt_at: lastAttempt }),
    ...(latest === undefined ? {} : { latest_version: latest }),
    ...(lastPrompt === undefined ? {} : { last_prompt_at: lastPrompt })
  }
}

function readState (statePath: string, now: number): UpdateState {
  try {
    if (statSync(statePath).size > MAX_STATE_BYTES) return { schema_version: 1 }
    return normalizedState(JSON.parse(readFileSync(statePath, 'utf8')), now)
  } catch {
    return { schema_version: 1 }
  }
}

function recent (value: string | undefined, now: number): boolean {
  if (value === undefined) return false
  const milliseconds = Date.parse(value)
  return Number.isFinite(milliseconds) && milliseconds <= now && now - milliseconds < UPDATE_CHECK_INTERVAL_MS
}

interface UpdatePaths {
  directory: string
  state: string
  lock: string
  staleRecoveryLock: string
}

function updatePaths (directory: string): UpdatePaths {
  return {
    directory,
    state: join(directory, UPDATE_STATE_FILENAME),
    lock: join(directory, UPDATE_LOCK_FILENAME),
    staleRecoveryLock: join(directory, `${UPDATE_LOCK_FILENAME}.stale-recovery`)
  }
}

function removeOwnedLock (path: string, token: string): void {
  try {
    if (readFileSync(path, 'utf8') === token) rmSync(path, { force: true })
  } catch {
    // A missing or replaced lock is no longer ours to remove.
  }
}

interface HeldLock {
  release: () => void
}

function breakStaleLock (paths: UpdatePaths, dependencies: UpdateCoordinatorDependencies): boolean {
  const token = dependencies.lockToken()
  let descriptor: number | undefined
  try {
    descriptor = openSync(paths.staleRecoveryLock, 'wx', 0o600)
    writeFileSync(descriptor, token, 'utf8')
    closeSync(descriptor)
    descriptor = undefined
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor) } catch {}
      rmSync(paths.staleRecoveryLock, { force: true })
    }
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error

    // Recovery itself is synchronous, so this file can be old only when the
    // breaker process died between its exclusive create and cleanup.
    try {
      if (dependencies.now() - statSync(paths.staleRecoveryLock).mtimeMs >= UPDATE_LOCK_STALE_MS) {
        rmSync(paths.staleRecoveryLock, { force: true })
      }
    } catch (recoveryError) {
      if ((recoveryError as NodeJS.ErrnoException).code !== 'ENOENT') throw recoveryError
    }
    return false
  }

  try {
    const age = dependencies.now() - statSync(paths.lock).mtimeMs
    if (age >= UPDATE_LOCK_STALE_MS) rmSync(paths.lock, { force: true })
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
    throw error
  } finally {
    removeOwnedLock(paths.staleRecoveryLock, token)
  }
}

async function acquireLock (paths: UpdatePaths, dependencies: UpdateCoordinatorDependencies): Promise<HeldLock | undefined> {
  mkdirSync(paths.directory, { recursive: true, mode: 0o700 })
  const waitDeadline = Date.now() + UPDATE_LOCK_WAIT_MS
  const token = dependencies.lockToken()

  while (true) {
    let descriptor: number | undefined
    try {
      descriptor = openSync(paths.lock, 'wx', 0o600)
      writeFileSync(descriptor, token, 'utf8')
      closeSync(descriptor)
      descriptor = undefined

      let released = false
      const unregisterInterrupt = registerInterruptCleanup(() => { removeOwnedLock(paths.lock, token) })
      return {
        release: () => {
          if (released) return
          released = true
          unregisterInterrupt()
          removeOwnedLock(paths.lock, token)
        }
      }
    } catch (error) {
      if (descriptor !== undefined) {
        try { closeSync(descriptor) } catch {}
        rmSync(paths.lock, { force: true })
      }
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error

      try {
        const age = dependencies.now() - statSync(paths.lock).mtimeMs
        if (age >= UPDATE_LOCK_STALE_MS) {
          if (!breakStaleLock(paths, dependencies)) await dependencies.sleep(UPDATE_LOCK_POLL_MS)
          continue
        }
      } catch (lockError) {
        if ((lockError as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw lockError
      }

      if (Date.now() >= waitDeadline) return undefined
      await dependencies.sleep(UPDATE_LOCK_POLL_MS)
    }
  }
}

function writeStateAtomically (paths: UpdatePaths, state: UpdateState, token: string): void {
  const temporary = join(paths.directory, `${UPDATE_STATE_FILENAME}.${process.pid}.${token}.tmp`)
  let unregisterInterrupt = (): void => {}
  try {
    const descriptor = openSync(temporary, 'wx', 0o600)
    closeSync(descriptor)
    unregisterInterrupt = registerInterruptCleanup(() => { rmSync(temporary, { force: true }) })
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    renameSync(temporary, paths.state)
  } finally {
    unregisterInterrupt()
    rmSync(temporary, { force: true })
  }
}

function noticeDocument (currentVersion: string, availableVersion: string): UpdateNoticeDocument {
  return {
    notice: {
      code: 'CLI_UPDATE_AVAILABLE',
      message: 'A newer stable Poki CLI is available.',
      blocking: false,
      current_version: currentVersion,
      available_version: availableVersion,
      channel: 'latest',
      update_commands: {
        global: `npm install --global --ignore-scripts --no-audit --no-fund @poki/cli@${availableVersion}`,
        project_local: `npm install --save-dev --ignore-scripts --no-audit --no-fund @poki/cli@${availableVersion}`
      },
      verify_commands: {
        global: 'poki --version',
        project_local: 'npx @poki/cli --version'
      },
      completed_command_requires_rerun: false
    }
  }
}

export class UpdateCoordinator {
  private readonly dependencies: UpdateCoordinatorDependencies
  private check: Promise<void> | undefined
  private availableVersion: string | undefined
  private contactedApi = false

  constructor (
    private readonly currentVersion: string,
    private readonly format: StructuredFormat,
    dependencies: Partial<UpdateCoordinatorDependencies> = {}
  ) {
    this.dependencies = {
      now: dependencies.now ?? Date.now,
      configDirectory: dependencies.configDirectory ?? getConfigDir,
      lookupLatest: dependencies.lookupLatest ?? npmLatestVersion,
      writeNotice: dependencies.writeNotice ?? defaultWriteNotice,
      environment: dependencies.environment ?? process.env,
      sleep: dependencies.sleep ?? (async milliseconds => await new Promise(resolve => setTimeout(resolve, milliseconds))),
      lockToken: dependencies.lockToken ?? randomUUID
    }
  }

  readonly beforeFirstRequest = async (): Promise<void> => {
    this.contactedApi = true
    if (this.dependencies.environment.POKI_CLI_UPDATE_CHECK === '0') return
    this.check ??= this.checkForUpdate()
    await this.check
  }

  async commandSucceeded (): Promise<void> {
    if (!this.contactedApi || this.dependencies.environment.POKI_CLI_UPDATE_CHECK === '0') return
    await this.check
    if (this.availableVersion === undefined) return

    let notice: UpdateNoticeDocument | undefined
    try {
      const paths = updatePaths(this.dependencies.configDirectory())
      const held = await acquireLock(paths, this.dependencies)
      if (held === undefined) return
      try {
        const now = this.dependencies.now()
        const state = readState(paths.state, now)
        const available = state.latest_version
        if (available === undefined || !stableUpdateAvailable(this.currentVersion, available) || recent(state.last_prompt_at, now)) return

        state.last_prompt_at = new Date(now).toISOString()
        writeStateAtomically(paths, state, this.dependencies.lockToken())
        notice = noticeDocument(this.currentVersion, available)
      } finally {
        held.release()
      }
    } catch {
      return
    }

    // Claim the prompt in state before writing it. A broken stderr can lose a
    // best-effort notice, but concurrent installations can never duplicate it.
    if (notice !== undefined) {
      try { this.dependencies.writeNotice(notice, this.format) } catch {}
    }
  }

  private async checkForUpdate (): Promise<void> {
    try {
      const paths = updatePaths(this.dependencies.configDirectory())
      const held = await acquireLock(paths, this.dependencies)
      if (held === undefined) return
      try {
        const now = this.dependencies.now()
        const state = readState(paths.state, now)
        if (!recent(state.last_attempt_at, now)) {
          // Publish the attempt before starting npm. A timeout, npm failure,
          // parse failure, or interruption therefore cannot cause a registry
          // request loop on the next invocation.
          state.last_attempt_at = new Date(now).toISOString()
          // Do not prompt from a previously cached answer when today's lookup
          // fails or today's latest tag is invalid or prerelease-only.
          delete state.latest_version
          writeStateAtomically(paths, state, this.dependencies.lockToken())
          try {
            const latest = await this.dependencies.lookupLatest()
            if (parseSemver(latest)?.prerelease.length === 0) {
              state.latest_version = latest
              writeStateAtomically(paths, state, this.dependencies.lockToken())
            }
          } catch {
            // Registry lookup is advisory and the attempted timestamp already
            // suppresses another request for the rolling 24-hour window.
          }
        }
        if (state.latest_version !== undefined && stableUpdateAvailable(this.currentVersion, state.latest_version)) {
          this.availableVersion = state.latest_version
        }
      } finally {
        held.release()
      }
    } catch {
      // Configuration and filesystem failures must not affect the API command.
    }
  }
}
