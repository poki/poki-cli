import { createRequire } from 'node:module'
import { rmSync } from 'node:fs'

const require = createRequire(import.meta.url)
// Node 20.7 can evaluate --import preloads before tsx's CommonJS hook is ready.
// Register it here before requiring the same cleanup registry as the CLI.
require('tsx/cjs')
const { registerInterruptCleanup } = require('../../src/errors.ts')

const archive = process.env.POKI_CLI_TEST_CLEANUP_ARCHIVE
const code = process.env.POKI_CLI_TEST_STDOUT_ERROR_CODE
if (archive === undefined || !['EPIPE', 'EIO'].includes(code)) {
  throw new Error('The stdout-error fixture requires an archive and error code.')
}
registerInterruptCleanup(() => rmSync(archive, { force: true }))

let emitted = false
process.stdout.write = () => {
  if (!emitted) {
    emitted = true
    process.nextTick(() => process.stdout.emit('error', Object.assign(new Error('consumer closed'), { code })))
  }
  return true
}
