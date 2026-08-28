export type ErrorDetails = Record<string, unknown> | unknown[] | string | number | boolean | null

const safeApiErrorFields = ['status', 'code', 'title', 'detail'] as const
export type SafeApiError = Partial<Record<typeof safeApiErrorFields[number], string>>
export interface SafeApiErrorResponse extends Record<string, unknown> { errors?: SafeApiError[] }

export const AUTH_LOGIN_USER_ACTION_HINT = 'Ask the user to run `poki auth login` in an interactive terminal and complete the browser sign-in. Do not run `poki auth login` yourself.'
export const AUTH_REQUIRED_HINT = `${AUTH_LOGIN_USER_ACTION_HINT} After the user confirms sign-in succeeded, retry the original command.`

/**
 * Project a backend JSON:API error document onto the reviewed developer
 * surface. Error source pointers, per-error metadata, document metadata, and
 * any future backend fields are deliberately omitted.
 */
export function safeApiErrorResponse (body: unknown): SafeApiErrorResponse {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return {}

  const errors = (body as { errors?: unknown }).errors
  if (!Array.isArray(errors)) return {}

  const safeErrors = errors.flatMap(error => {
    if (error === null || typeof error !== 'object' || Array.isArray(error)) return []
    const source = error as Record<string, unknown>
    const safe: SafeApiError = {}
    for (const field of safeApiErrorFields) {
      if (typeof source[field] === 'string') safe[field] = source[field]
    }
    return Object.keys(safe).length === 0 ? [] : [safe]
  })

  return safeErrors.length === 0 ? {} : { errors: safeErrors }
}

export class CliError extends Error {
  readonly code: string
  readonly exitCode: number
  readonly status?: number
  readonly details?: ErrorDetails
  readonly hint?: string
  readonly retryable: boolean
  readonly requestId?: string
  readonly retryAfter?: string

  constructor (code: string, message: string, exitCode: number, options: {
    status?: number
    details?: ErrorDetails
    hint?: string
    retryable?: boolean
    requestId?: string
    retryAfter?: string
  } = {}) {
    super(message)
    this.name = 'CliError'
    this.code = code
    this.exitCode = exitCode
    this.status = options.status
    this.details = options.details
    this.hint = options.hint
    this.retryable = options.retryable ?? false
    this.requestId = options.requestId
    this.retryAfter = options.retryAfter
  }
}

export function inputError (message: string, details?: ErrorDetails, hint?: string): CliError {
  return new CliError('INVALID_INPUT', message, 2, { details, hint })
}

export function authRequired (message = 'Authentication is required.', hint = AUTH_REQUIRED_HINT): CliError {
  return new CliError('AUTH_REQUIRED', message, 3, {
    status: 401,
    hint
  })
}

export function notFound (resource: string, id: string, hint?: string): CliError {
  return new CliError('NOT_FOUND', `${resource} ${id} was not found.`, 4, {
    status: 404,
    details: { resource, id },
    hint
  })
}

// 130 is 128 + SIGINT, the code a shell already reports for an interrupted
// process. Both handled signals share it so the published exit-code table
// stays the small closed set an agent can reason about.
export function interruptedError (signal: string): CliError {
  return new CliError('INTERRUPTED', `The CLI was interrupted by ${signal} before the command completed.`, 130, {
    details: { signal },
    hint: 'A request that was already sent may still have been applied. Read the current resource state before retrying.'
  })
}

type InterruptCleanup = () => void

const interruptCleanups = new Set<InterruptCleanup>()

/**
 * Register work that must happen before an interrupted process exits, and
 * return the deregistration for the ordinary `finally` path. Every other
 * cleanup path in the CLI is such a `finally` block, which a signal with its
 * default disposition never runs, so anything that would otherwise outlive the
 * process - a partial download beside its destination, an upload archive -
 * registers here as well. Cleanups run synchronously because the handler exits
 * without returning to the event loop.
 */
export function registerInterruptCleanup (cleanup: InterruptCleanup): () => void {
  interruptCleanups.add(cleanup)
  return () => { interruptCleanups.delete(cleanup) }
}

/**
 * Run every registered cleanup exactly once. A failing cleanup must not skip
 * the remaining ones or turn an interrupt into an uncaught exception.
 */
export function runInterruptCleanups (): void {
  for (const cleanup of interruptCleanups) {
    interruptCleanups.delete(cleanup)
    try {
      cleanup()
    } catch {
      // Best-effort removal; an interrupted process has nowhere to report it.
    }
  }
}

/**
 * The one projection of a CliError onto the public error surface. Both the
 * top-level error document and every nested action-level cause serialize
 * through it, so a field added here cannot widen one surface while the other
 * silently keeps the old shape. Only the top-level document passes `details`
 * through: they may contain backend payloads or other data that has not been
 * reviewed for the narrower nested surface.
 */
function publicErrorFields (error: CliError, details?: ErrorDetails): Record<string, unknown> {
  return {
    code: error.code,
    message: error.message,
    ...(error.status === undefined ? {} : { status: error.status }),
    ...(details === undefined ? {} : { details }),
    retryable: error.retryable,
    ...(error.requestId === undefined ? {} : { request_id: error.requestId }),
    ...(error.retryAfter === undefined ? {} : { retry_after: error.retryAfter }),
    ...(error.hint === undefined ? {} : { hint: error.hint })
  }
}

function unexpectedErrorFields (error: unknown): Record<string, unknown> {
  return {
    code: 'UNEXPECTED_ERROR',
    message: error instanceof Error ? error.message : String(error),
    retryable: false
  }
}

/**
 * Serialize an error for use as a nested action-level cause. Command-specific
 * details are intentionally not copied: they may contain backend payloads or
 * other data that has not been reviewed as part of the public error contract.
 */
export function safeErrorCause (error: unknown): Record<string, unknown> {
  if (!(error instanceof CliError)) return unexpectedErrorFields(error)

  const apiResponse = safeApiErrorResponse(error.details)
  return {
    ...publicErrorFields(error),
    ...(Object.keys(apiResponse).length === 0 ? {} : { api_response: apiResponse })
  }
}

export function errorDocument (error: unknown): { error: Record<string, unknown> } {
  return {
    error: error instanceof CliError ? publicErrorFields(error, error.details) : unexpectedErrorFields(error)
  }
}
