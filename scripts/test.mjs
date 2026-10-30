import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const testFiles = readdirSync(join(repository, 'test'))
  .filter(name => name.endsWith('.test.ts'))
  .sort()
  .map(name => join('test', name))

if (testFiles.length === 0) throw new Error('No test files found')

const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...testFiles], {
  cwd: repository,
  stdio: 'inherit'
})

if (result.error !== undefined) throw result.error
if (result.signal !== null) throw new Error(`Test process terminated by ${result.signal}`)
process.exitCode = result.status ?? 1
