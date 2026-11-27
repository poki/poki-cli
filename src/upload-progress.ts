// A live progress line for the deprecated human upload. It renders only when
// the output is a terminal: piped, captured, and CI output never receives it,
// so the documented upload output stays byte-identical for every pipeline that
// reads it.

export interface ProgressOutput {
  isTTY?: boolean
  columns?: number
  write: (text: string) => unknown
}

export interface UploadProgress {
  update: (sent: number) => void
  finish: () => void
}

const RENDER_INTERVAL_MS = 100
const MIN_BAR_WIDTH = 10
const MAX_BAR_WIDTH = 30
const DEFAULT_COLUMNS = 80

const units = ['B', 'KB', 'MB', 'GB', 'TB']

export function formatBytes (bytes: number): string {
  let value = bytes
  let unit = 0
  // Round before choosing the unit so 999,999 bytes reads 1.0 MB, not 1000.0 KB.
  while (unit < units.length - 1 && (unit === 0 ? Math.round(value) : Math.round(value * 10) / 10) >= 1000) {
    value /= 1000
    unit++
  }
  return unit === 0 ? `${Math.round(value)} B` : `${value.toFixed(1)} ${units[unit]}`
}

export function uploadProgressLine (sent: number, total: number, elapsedMs: number, columns = DEFAULT_COLUMNS): string {
  const fraction = total > 0 ? Math.min(1, Math.max(0, sent / total)) : 1
  const percent = `${Math.floor(fraction * 100)}%`.padStart(4)
  const rate = elapsedMs > 0 && sent > 0 ? `  ${formatBytes(sent / elapsedMs * 1000)}/s` : ''
  const text = `${percent}  ${formatBytes(sent)} / ${formatBytes(total)}${rate}`
  // Stay one column short of the terminal width: a line that exactly fills it
  // wraps in some terminals, and the carriage return then redraws the wrong row.
  const width = Math.max(MIN_BAR_WIDTH, Math.min(MAX_BAR_WIDTH, columns - text.length - 4))
  const filled = Math.round(fraction * width)
  return `[${'#'.repeat(filled)}${'-'.repeat(width - filled)}] ${text}`
}

export function uploadProgress (total: number, output: ProgressOutput, now: () => number = Date.now): UploadProgress {
  if (output.isTTY !== true) return { update: () => {}, finish: () => {} }

  const started = now()
  let sent = 0
  let renderedSent = -1
  let renderedAt = -Infinity
  let finished = false

  const render = (): void => {
    renderedAt = now()
    renderedSent = sent
    // \r returns to the line start and ESC[K clears what a longer previous
    // line left behind. libuv translates both for Windows consoles.
    output.write(`\r${uploadProgressLine(sent, total, renderedAt - started, output.columns)}\x1b[K`)
  }

  render()

  return {
    update: bytes => {
      if (finished) return
      sent = bytes
      if (sent >= total || now() - renderedAt >= RENDER_INTERVAL_MS) render()
    },
    // Idempotent: the body completing and the response settling both end the
    // line, and whichever comes first must leave later output on a fresh row.
    finish: () => {
      if (finished) return
      finished = true
      if (renderedSent !== sent) render()
      output.write('\n')
    }
  }
}
