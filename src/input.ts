import { readFileSync } from 'fs'
import { decode } from '@toon-format/toon'

import { CliError, inputError } from './errors'

const zeroWidthPattern = /[\u200B-\u200D\uFEFF]/u

// JavaScript string.length counts UTF-16 code units while the API validates
// Unicode code points. Keep local length checks on the same unit as the API.
export function characterCount (value: string): number {
  return Array.from(value).length
}

export function containsZeroWidthCharacter (value: string): boolean {
  return zeroWidthPattern.test(value)
}

async function readStdin (): Promise<string> {
  // `-` with an interactive stdin would block forever waiting for input that
  // is never piped; failing fast keeps non-interactive agents unstuck.
  if (process.stdin.isTTY) {
    throw inputError('Standard input is a terminal; `-` requires piped input.', {
      accepted_inputs: ['inline JSON or TOON', '@file', '- with piped stdin']
    })
  }
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf8')
}

export async function readStructuredSource (source: string, label = '--data'): Promise<Record<string, unknown>> {
  let contents: string
  try {
    contents = source === '-'
      ? await readStdin()
      : source.startsWith('@')
        ? readFileSync(source.slice(1), 'utf8')
        : source
  } catch (error) {
    if (error instanceof CliError) throw error
    throw inputError(`Could not read ${label}.`, error instanceof Error ? error.message : String(error))
  }

  const trimmed = contents.trim()
  if (trimmed === '') throw inputError(`${label} is empty.`)

  let parsed: unknown
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    // JSON-shaped input is never valid TOON; falling back to the TOON parser
    // here would turn a JSON syntax error into garbage field names.
    try {
      parsed = JSON.parse(contents)
    } catch (jsonError) {
      throw inputError(`${label} must contain valid JSON.`, {
        json: jsonError instanceof Error ? jsonError.message : String(jsonError)
      })
    }
  } else {
    try {
      parsed = decode(contents)
    } catch (toonError) {
      try {
        parsed = JSON.parse(contents)
      } catch (jsonError) {
        throw inputError(`${label} must contain valid JSON or TOON.`, {
          json: jsonError instanceof Error ? jsonError.message : String(jsonError),
          toon: toonError instanceof Error ? toonError.message : String(toonError)
        })
      }
    }
  }

  if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw inputError(`${label} must be a JSON or TOON object.`)
  }
  return parsed as Record<string, unknown>
}

export function requireAllowedFields (data: Record<string, unknown>, allowed: readonly string[]): void {
  const unsupported = Object.keys(data).filter(key => !allowed.includes(key))
  if (unsupported.length > 0) {
    throw inputError(`Unsupported field${unsupported.length === 1 ? '' : 's'}: ${unsupported.join(', ')}.`, {
      allowed
    })
  }
}

export function requireChanges (data: Record<string, unknown>): void {
  if (Object.keys(data).length === 0) {
    throw inputError('At least one field must be changed.')
  }
}
