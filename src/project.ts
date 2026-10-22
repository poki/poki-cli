import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'

import { Config } from './config'
import { CliError, inputError } from './errors'
import { isRecord } from './json'

export interface ProjectConfigContext {
  config: Config
  source: 'poki.json' | 'package.json#poki' | 'none'
  path?: string
}

function parseConfig (contents: string, path: string, root = false): Config {
  let parsed: unknown
  try {
    parsed = JSON.parse(contents)
  } catch (error) {
    throw inputError(`Could not parse ${path}.`, {
      path,
      cause: error instanceof Error ? error.message : String(error)
    })
  }

  const value = root && isRecord(parsed)
    ? (parsed as { poki?: unknown }).poki
    : parsed
  if (value === undefined && root) return {}
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    const subject = root ? `The poki property in ${path}` : path
    throw inputError(`${subject} must be an object.`, { path })
  }

  const config = value as Config
  for (const field of ['game_id', 'build_dir'] as const) {
    if (config[field] !== undefined && typeof config[field] !== 'string') {
      throw inputError(`${field} in ${path} must be a string.`, { path, field })
    }
  }
  return config
}

export function readProjectConfigContext (cwd = process.cwd()): ProjectConfigContext {
  const pokiPath = resolve(cwd, 'poki.json')
  if (existsSync(pokiPath)) {
    return {
      config: parseConfig(readFileSync(pokiPath, 'utf8'), pokiPath),
      source: 'poki.json',
      path: pokiPath
    }
  }

  const packagePath = resolve(cwd, 'package.json')
  if (existsSync(packagePath)) {
    const config = parseConfig(readFileSync(packagePath, 'utf8'), packagePath, true)
    if (Object.keys(config).length > 0) {
      return { config, source: 'package.json#poki', path: packagePath }
    }
  }

  return { config: {}, source: 'none' }
}

// Commands register at startup, so a malformed configuration file must not
// abort offline commands like `poki version` or `poki init --force`. The parse
// error is cached here and surfaced only when a command actually needs the
// project configuration; `context` reads the throwing variant directly.
let safeState: { config: Config, error?: CliError } | undefined

function safeProjectConfig (): { config: Config, error?: CliError } {
  if (safeState === undefined) {
    try {
      safeState = { config: readProjectConfigContext().config }
    } catch (error) {
      safeState = { config: {}, ...(error instanceof CliError ? { error } : {}) }
    }
  }
  return safeState
}

// Test-only: a CLI process reads one working directory for its lifetime, but
// in-process tests re-register the command surface from different directories.
export function resetProjectConfigCache (): void {
  safeState = undefined
}

export function projectConfigError (): CliError | undefined {
  return safeProjectConfig().error
}

export function readProjectConfig (): Config {
  return safeProjectConfig().config
}

export function getProjectGameId (): string | undefined {
  const gameId = readProjectConfig().game_id
  return gameId === undefined || gameId === '' ? undefined : gameId
}
