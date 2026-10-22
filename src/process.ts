import type { ApiClient } from './api'
import { runCli } from './cli'
import { CliError, interruptedError, runInterruptCleanups } from './errors'
import { requestedFormat, writeError } from './output'

export function runProcess (args: string[], api?: ApiClient): void {
  // The process boundary owes an agent the same structured document every other
  // failure produces: printing the raw exception would leak an unsanitized stack
  // trace and leave the caller without a machine-readable code.
  function reportFatal (error: unknown): void {
    try {
      writeError(error, requestedFormat(args))
    } catch {
      // A stderr that cannot be written to has nowhere left to report anything.
    }
  }

  // A consumer that stops reading (`poki help | head`) closes the pipe while the
  // CLI is still writing. The consumer going away is not a CLI failure, so end
  // quietly instead of letting EPIPE surface as an uncaught stream error.
  process.stdout.on('error', error => {
    if ((error as NodeJS.ErrnoException).code === 'EPIPE') process.exit(0)
    reportFatal(error)
    process.exit(5)
  })

  // Signals run none of the `finally` blocks the commands rely on, so registered
  // cleanups are the only thing that can still remove a partial download or an
  // upload archive. Handling them also keeps the exit code and the error document
  // inside the published contract.
  let interrupted = false
  function handleInterrupt (signal: NodeJS.Signals): void {
    // A second signal must not run the cleanups again or re-enter reporting.
    if (interrupted) return
    interrupted = true
    const error = interruptedError(signal)
    try {
      runInterruptCleanups()
      writeError(error, requestedFormat(args))
    } catch {
      // Reporting an interrupt must never replace it with an uncaught exception.
    }
    process.exit(error.exitCode)
  }
  process.on('SIGINT', handleInterrupt)
  process.on('SIGTERM', handleInterrupt)

  runCli(args, api).then(exitCode => {
    process.exitCode = exitCode
  }).catch(error => {
    reportFatal(error)
    process.exitCode = error instanceof CliError ? error.exitCode : 5
  })
}
