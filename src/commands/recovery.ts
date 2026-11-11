import { DEFAULT_POLL_INTERVAL_MS, DEFAULT_WAIT_TIMEOUT_MS } from '../timeouts'

export interface RecoveryAction {
  action?: string
  arguments: string[]
}

// Resume from server-side resource identity; no local operation journal exists.
export function pollArguments (argv: Record<string, unknown>): string[] {
  return [
    '--poll-interval-ms', String(argv.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS),
    '--wait-timeout-ms', String(argv.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS),
    ...(typeof argv.timeoutMs === 'number' ? ['--timeout-ms', String(argv.timeoutMs)] : [])
  ]
}
