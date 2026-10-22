import assert from 'node:assert/strict'
import test from 'node:test'

import { pollUntil } from '../src/commands/common'
import { CliError } from '../src/errors'

async function wait (milliseconds: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, milliseconds))
}

void test('pollUntil rejects a terminal result that arrives after the total wait deadline', async () => {
  let slowPollCompleted = false
  let suppliedPollTimeout = 0
  const startedAt = Date.now()

  await assert.rejects(pollUntil({
    pollIntervalMs: 1,
    waitTimeoutMs: 35,
    timeoutMs: 5000
  }, async pollTimeoutMs => {
    suppliedPollTimeout = pollTimeoutMs
    await wait(80)
    slowPollCompleted = true
    return { resource: { id: 'late' }, state: 'done', terminal: true, succeeded: true }
  }, 'slow operation', 5000), (error: unknown) => {
    assert.ok(error instanceof CliError)
    assert.equal(error.code, 'WAIT_TIMEOUT')
    const details = error.details as { last_state: string, polls: number, waited_ms: number, resource: unknown }
    assert.equal(details.last_state, 'unknown')
    assert.equal(details.polls, 0)
    assert.equal(details.resource, null)
    assert.ok(details.waited_ms >= 30, `expected a truthful wait duration, got ${String(details.waited_ms)} ms`)
    return true
  })

  assert.ok(suppliedPollTimeout > 0 && suppliedPollTimeout <= 35)
  assert.equal(slowPollCompleted, false)
  assert.ok(Date.now() - startedAt >= 30)
})

void test('pollUntil waits out the remaining deadline when the polling interval is larger than the timeout', async () => {
  let polls = 0
  const startedAt = Date.now()

  await assert.rejects(pollUntil({
    pollIntervalMs: 1000,
    waitTimeoutMs: 35
  }, async () => {
    polls++
    return { resource: { id: 'running' }, state: 'processing', terminal: false, succeeded: false }
  }, 'interval-bound operation', 30000), (error: unknown) => {
    assert.ok(error instanceof CliError)
    assert.equal(error.code, 'WAIT_TIMEOUT')
    const details = error.details as { last_state: string, polls: number, waited_ms: number, resource: unknown }
    assert.equal(details.last_state, 'processing')
    assert.equal(details.polls, 1)
    assert.deepEqual(details.resource, { id: 'running' })
    assert.ok(details.waited_ms >= 30, `expected to wait until the deadline, got ${String(details.waited_ms)} ms`)
    return true
  })

  assert.equal(polls, 1)
  assert.ok(Date.now() - startedAt >= 30)
})

// Which bound expired decides how the failure is reported, so both directions
// are pinned: mixing them up either loses the created-resource recovery
// envelope or reports a wait deadline that has not been reached.
void test('an expiring poll is attributed to whichever bound was smaller', async () => {
  const apiTimeout = (): CliError => new CliError('API_TIMEOUT', 'The Poki API request exceeded 5 ms.', 5, {
    retryable: true,
    details: { timeout_ms: 5 }
  })

  // The request timeout is the smaller bound: the wait deadline is far away,
  // so this stays an API timeout and a caller keeps its own recovery contract.
  await assert.rejects(pollUntil({ pollIntervalMs: 1, waitTimeoutMs: 30000 }, async () => {
    throw apiTimeout()
  }, 'request-bound operation', 5), (error: unknown) => {
    assert.ok(error instanceof CliError)
    assert.equal(error.code, 'API_TIMEOUT')
    return true
  })

  // The remaining wait time is the smaller bound: the same expiry is the wait
  // deadline, reported with the retryable WAIT_TIMEOUT contract.
  await assert.rejects(pollUntil({ pollIntervalMs: 1, waitTimeoutMs: 20 }, async () => {
    await wait(40)
    throw apiTimeout()
  }, 'deadline-bound operation', 30000), (error: unknown) => {
    assert.ok(error instanceof CliError)
    assert.equal(error.code, 'WAIT_TIMEOUT')
    assert.equal(error.retryable, true)
    return true
  })
})

void test('a definitive poll failure observed after the deadline keeps its own classification', async () => {
  await assert.rejects(pollUntil({ pollIntervalMs: 1, waitTimeoutMs: 20 }, async () => {
    // Spending the complete wait deadline inside the poll without yielding is
    // how a permanent failure reaches the loop after the deadline expired.
    const until = Date.now() + 60
    while (Date.now() < until) { /* hold the event loop past the wait deadline */ }
    throw new CliError('PERMISSION_DENIED', 'You do not have permission to read this resource.', 4, {
      status: 403,
      retryable: false
    })
  }, 'denied operation', 30000), (error: unknown) => {
    // Reporting this as retryable WAIT_TIMEOUT would send an agent into a retry
    // loop against a request that can never succeed.
    assert.ok(error instanceof CliError)
    assert.equal(error.code, 'PERMISSION_DENIED')
    assert.equal(error.status, 403)
    assert.equal(error.retryable, false)
    return true
  })
})
