export const MAX_TIMEOUT_MS = 0x7fffffff
export const TIMEOUT_MILLISECONDS_RANGE = `integer from 1 to ${String(MAX_TIMEOUT_MS)}`
export const DEFAULT_REQUEST_TIMEOUT_MS = 30000
export const DEFAULT_UPLOAD_TIMEOUT_MS = 300000
export const DEFAULT_DOWNLOAD_TIMEOUT_MS = 300000
export const DEFAULT_POLL_INTERVAL_MS = 15000
export const DEFAULT_WAIT_TIMEOUT_MS = 600000

export function parseTimeoutMilliseconds (value: unknown): number | undefined {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() !== ''
      ? Number(value)
      : Number.NaN

  return Number.isInteger(parsed) && parsed >= 1 && parsed <= MAX_TIMEOUT_MS
    ? parsed
    : undefined
}

export function timeoutMillisecondsOrDefault (value: unknown, fallback: number): number {
  const parsedFallback = parseTimeoutMilliseconds(fallback)
  if (parsedFallback === undefined) throw new Error('The default timeout is outside the supported range.')
  return parseTimeoutMilliseconds(value) ?? parsedFallback
}
