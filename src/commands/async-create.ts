import { CliError, safeErrorCause } from '../errors'
import { ResourceResult } from '../jsonapi'
import { DEFAULT_POLL_INTERVAL_MS, DEFAULT_WAIT_TIMEOUT_MS } from '../timeouts'
import { PollOutcome, withWaitMeta } from './polling'
import { render } from './rendering'
import { isMalformedSuccessfulMutation } from './resource-responses'

// A create that a caller may follow with --wait has one shared failure
// boundary: the resource can already exist while the step that should have
// observed it fails. Replaying the mutation would duplicate the resource, so
// every such command reports the same non-retryable envelope carrying the
// created resource and an executable inspect-or-resume recovery.

export interface RecoveryAction {
  action: string
  arguments: string[]
}

export interface AsyncCreateContract {
  errorCode: string
  // Names the details keys: `<noun>_created`, `created_<noun>`,
  // `created_<noun>_id`, and `inspect_created_<noun>`.
  noun: string
  missingId: { message: string, hint: string }
  pollFailed: { message: string, hint: string }
  inspect: (argv: Record<string, unknown>) => RecoveryAction
  resumePoll: (createdId: string, argv: Record<string, unknown>) => RecoveryAction
}

// Resuming a poll repeats the caller's own pacing rather than the defaults.
export function pollArguments (argv: Record<string, unknown>): string[] {
  return [
    '--poll-interval-ms', String(argv.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS),
    '--wait-timeout-ms', String(argv.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS)
  ]
}

export function asyncCreateWaitFailure (
  contract: AsyncCreateContract,
  error: unknown,
  createdResource: Record<string, unknown> | undefined,
  createdId: string | undefined,
  argv: Record<string, unknown>
): CliError {
  const original = error instanceof CliError ? error : undefined
  const outcome = createdId === undefined ? contract.missingId : contract.pollFailed
  const recovery = createdId === undefined
    ? { [`inspect_created_${contract.noun}`]: contract.inspect(argv) }
    : { resume_poll: contract.resumePoll(createdId, argv) }
  return new CliError(contract.errorCode, outcome.message, original?.exitCode ?? 5, {
    status: original?.status,
    retryable: false,
    requestId: original?.requestId,
    retryAfter: original?.retryAfter,
    hint: outcome.hint,
    details: {
      [`${contract.noun}_created`]: true,
      ...(createdId === undefined ? {} : { [`created_${contract.noun}_id`]: createdId }),
      ...(createdResource === undefined ? {} : { [`created_${contract.noun}`]: createdResource }),
      recovery: Object.fromEntries(Object.entries(recovery)
        .map(([key, value]) => [key, { action: value.action, command: 'poki', arguments: value.arguments }])),
      cause: safeErrorCause(error)
    }
  })
}

interface MutationResponse {
  body: unknown
  status: number
}

export interface AsyncCreateOptions {
  contract: AsyncCreateContract
  argv: Record<string, unknown>
  send: () => Promise<MutationResponse>
  normalize: (response: MutationResponse, onRecoverySnapshot: (result: ResourceResult) => void) => ResourceResult
  // Returns the created ID or throws the command's own INVALID_API_RESPONSE.
  createdIdOf: (normalized: ResourceResult, response: MutationResponse) => string
  // versions upload proves the build reached the requested game from the
  // create response alone, so it validates the identity even without --wait.
  // A question ID is only needed to poll generation.
  requireCreatedId: 'always' | 'when_waiting'
  // Recovery projections: the first reads the recovery snapshot of an
  // otherwise malformed document, the second the normalized created resource.
  recoveryFromSnapshot: (data: unknown) => Record<string, unknown> | undefined
  recoveryFromNormalized: (data: unknown) => Record<string, unknown> | undefined
  poll: (createdId: string) => Promise<PollOutcome>
}

export async function createThenWait (options: AsyncCreateOptions): Promise<void> {
  const { argv } = options
  const waiting = argv.wait === true
  const failure = (error: unknown, created: Record<string, unknown> | undefined, createdId?: string): CliError =>
    asyncCreateWaitFailure(options.contract, error, created, createdId, argv)

  const response = await options.send().catch((error: unknown) => {
    if (waiting && isMalformedSuccessfulMutation(error)) throw failure(error, undefined)
    throw error
  })

  let normalized: ResourceResult
  let snapshot: ResourceResult | undefined
  try {
    normalized = options.normalize(response, result => {
      snapshot = result
    })
  } catch (error) {
    if (waiting) throw failure(error, options.recoveryFromSnapshot(snapshot?.data))
    throw error
  }

  let createdId: string | undefined
  if (waiting || options.requireCreatedId === 'always') {
    try {
      createdId = options.createdIdOf(normalized, response)
    } catch (error) {
      if (waiting) throw failure(error, options.recoveryFromNormalized(normalized.data))
      throw error
    }
  }

  if (!waiting || createdId === undefined) {
    render(argv.raw === true ? response.body : normalized, argv)
    return
  }

  let outcome: PollOutcome
  try {
    outcome = await options.poll(createdId)
  } catch (error) {
    // A remote operation that is still running or has genuinely failed keeps
    // its own contract; only an unexplained polling failure needs the
    // created-resource recovery envelope.
    if (error instanceof CliError && (error.code === 'WAIT_TIMEOUT' || error.code === 'ASYNC_OPERATION_FAILED')) throw error
    throw failure(error, options.recoveryFromNormalized(normalized.data), createdId)
  }
  render(withWaitMeta(outcome), argv)
}
