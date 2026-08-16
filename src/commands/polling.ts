import type { Argv } from 'yargs'

import { CliError, inputError } from '../errors'
import {
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_WAIT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  parseTimeoutMilliseconds,
  TIMEOUT_MILLISECONDS_RANGE
} from '../timeouts'

export function withWaitOptions (yargs: Argv, waitDescription: string): Argv {
  return yargs
    .option('wait', { describe: waitDescription, type: 'boolean', default: false })
    .option('poll-interval-ms', { describe: `Delay between --wait polls; accepts an ${TIMEOUT_MILLISECONDS_RANGE}`, type: 'number', default: DEFAULT_POLL_INTERVAL_MS })
    .option('wait-timeout-ms', { describe: `Maximum total --wait time before a retryable WAIT_TIMEOUT error; accepts an ${TIMEOUT_MILLISECONDS_RANGE}`, type: 'number', default: DEFAULT_WAIT_TIMEOUT_MS })
    .check(argv => {
      if (parseTimeoutMilliseconds(argv.pollIntervalMs) === undefined) throw inputError(`--poll-interval-ms must be a positive integer no greater than ${String(MAX_TIMEOUT_MS)}.`)
      if (parseTimeoutMilliseconds(argv.waitTimeoutMs) === undefined) throw inputError(`--wait-timeout-ms must be a positive integer no greater than ${String(MAX_TIMEOUT_MS)}.`)
      if (argv.wait && argv.raw === true) throw inputError('--wait cannot be combined with --raw.')
      return true
    })
}

export interface PollOutcome {
  resource: unknown
  state: string
  polls: number
  waited_ms: number
}

// Bounded polling loop for asynchronous server-side processing. On timeout
// the operation is still running remotely, so the error is retryable and
// carries the last observed state.
export async function pollUntil (
  args: Record<string, unknown>,
  fetchState: (pollTimeoutMs: number) => Promise<{ resource: unknown, state: string, terminal: boolean, succeeded: boolean }>,
  subject: string,
  // The timeout one poll request would use outside --wait: the explicit
  // --timeout-ms, else POKI_API_TIMEOUT_MS, else the ordinary default. Each
  // poll is bounded by this or the remaining wait time, whichever is smaller,
  // and which of the two bounds applies decides how an expiry is reported.
  requestTimeoutMs: number
): Promise<PollOutcome> {
  const intervalMs = parseTimeoutMilliseconds(args.pollIntervalMs) ?? DEFAULT_POLL_INTERVAL_MS
  const timeoutMs = parseTimeoutMilliseconds(args.waitTimeoutMs) ?? DEFAULT_WAIT_TIMEOUT_MS
  const startedAt = Date.now()
  const deadline = startedAt + timeoutMs
  let polls = 0
  let lastResource: unknown = null
  let lastState = 'unknown'

  const timeoutError = (): CliError => {
    const waitedMs = Date.now() - startedAt
    return new CliError('WAIT_TIMEOUT', `Timed out waiting for ${subject} after ${String(waitedMs)} ms; last observed state: ${lastState}.`, 5, {
      details: { last_state: lastState, polls, waited_ms: waitedMs, resource: lastResource },
      retryable: true,
      hint: 'The operation continues server-side; poll the resource again or raise --wait-timeout-ms.'
    })
  }

  const waitFor = async (milliseconds: number): Promise<void> => {
    await new Promise(resolve => setTimeout(resolve, milliseconds))
  }

  while (true) {
    const remainingBeforePoll = deadline - Date.now()
    if (remainingBeforePoll <= 0) throw timeoutError()
    const pollTimeoutMs = Math.max(1, Math.min(remainingBeforePoll, requestTimeoutMs))
    // When the remaining wait time is the smaller bound, an expiring request
    // means the wait deadline expired. Both timers are then armed for the same
    // instant, so without this the winner of that race would decide between
    // the retryable WAIT_TIMEOUT contract and a bare API_TIMEOUT. A poll the
    // request timeout bounds keeps reporting API_TIMEOUT, so a create that
    // already committed keeps its no-replay recovery envelope.
    const boundedByDeadline = remainingBeforePoll <= requestTimeoutMs
    const deadlineReached = Symbol('poll-deadline-reached')
    let timer: ReturnType<typeof setTimeout> | undefined
    let current: { resource: unknown, state: string, terminal: boolean, succeeded: boolean }
    try {
      current = await Promise.race([
        fetchState(pollTimeoutMs),
        new Promise<typeof deadlineReached>(resolve => {
          timer = setTimeout(() => resolve(deadlineReached), remainingBeforePoll)
        })
      ]).then(result => {
        if (result === deadlineReached) throw timeoutError()
        return result
      })
    } catch (error) {
      // Only an expiry becomes WAIT_TIMEOUT. A definitive failure such as a 403
      // that happens to surface once the deadline has passed is not a timeout,
      // and rewriting it as the retryable wait contract would send an agent
      // into a retry loop against a request that can never succeed.
      const expiredPoll = error instanceof CliError && (error.code === 'WAIT_TIMEOUT' || (boundedByDeadline && error.code === 'API_TIMEOUT'))
      if (expiredPoll) throw timeoutError()
      throw error
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
    if (Date.now() >= deadline) throw timeoutError()
    polls++
    lastResource = current.resource
    lastState = current.state
    const waitedMs = Date.now() - startedAt
    if (current.terminal) {
      if (!current.succeeded) {
        throw new CliError('ASYNC_OPERATION_FAILED', `${subject} reached terminal failure state ${current.state}.`, 5, {
          details: { final_state: current.state, polls, waited_ms: waitedMs, resource: current.resource },
          retryable: false,
          hint: 'Inspect the final resource error details; retry only by starting a new operation when appropriate.'
        })
      }
      return { resource: current.resource, state: current.state, polls, waited_ms: waitedMs }
    }
    const remainingBeforeDelay = deadline - Date.now()
    if (remainingBeforeDelay <= 0) throw timeoutError()
    await waitFor(Math.min(intervalMs, remainingBeforeDelay))
  }
}

export function withWaitMeta (outcome: PollOutcome): unknown {
  const resource = outcome.resource
  if (resource === null || typeof resource !== 'object' || Array.isArray(resource)) return resource
  const meta = (resource as { meta?: Record<string, unknown> }).meta
  return {
    ...resource,
    meta: {
      ...(meta ?? {}),
      wait: { final_state: outcome.state, polls: outcome.polls, waited_ms: outcome.waited_ms }
    }
  }
}
