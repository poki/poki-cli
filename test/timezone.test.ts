import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

import { repository, RunResult, temporaryDirectory } from './helpers'

const tsx = createRequire(import.meta.url).resolve('tsx', { paths: [repository] })

// The spawned processes must not see POKI_* overrides or the developer's real
// XDG_CONFIG_HOME (and with it real credentials) from the inherited shell.
const inheritedEnv: NodeJS.ProcessEnv = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !name.startsWith('POKI_') && name !== 'XDG_CONFIG_HOME')
)

// Unlike helpers.runCli, this spawns an arbitrary script (not the CLI entry
// point) so a tiny fixture can print uploadFilename under a controlled TZ.
async function runNode (args: string[], options: { env?: NodeJS.ProcessEnv, cwd?: string } = {}): Promise<RunResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', tsx, ...args], {
      cwd: options.cwd ?? repository,
      env: { ...inheritedEnv, ...options.env },
      stdio: 'pipe'
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.on('error', reject)
    child.on('close', code => resolve({ code: code ?? -1, stdout, stderr }))
    child.stdin.end()
  })
}

// uploadFilename shifts the injected instant by -getTimezoneOffset(), so the
// emitted name is the local wall-clock time of the configured TZ.
void test('uploadFilename renders the local wall-clock time of the configured time zone', async t => {
  const directory = temporaryDirectory(t, 'timezone')

  const script = join(directory, 'print-upload-filename.mjs')
  writeFileSync(script, [
    `import { uploadFilename } from '${pathToFileURL(join(repository, 'src/legacy.ts')).href}'`,
    "process.stdout.write(uploadFilename(new Date('2026-08-11T01:30:00Z')))",
    ''
  ].join('\n'))

  // UTC+14: 01:30Z is 15:30 local on the same date.
  const kiritimati = await runNode([script], { env: { TZ: 'Pacific/Kiritimati' }, cwd: directory })
  assert.equal(kiritimati.code, 0, kiritimati.stderr)
  assert.equal(kiritimati.stdout, '2026-08-11-153000.zip')

  // UTC-4 (EDT on 2026-08-11): 01:30Z is 21:30 local on the previous date.
  const newYork = await runNode([script], { env: { TZ: 'America/New_York' }, cwd: directory })
  assert.equal(newYork.code, 0, newYork.stderr)
  assert.equal(newYork.stdout, '2026-08-10-213000.zip')

  // UTC control: no shift at all.
  const utc = await runNode([script], { env: { TZ: 'UTC' }, cwd: directory })
  assert.equal(utc.code, 0, utc.stderr)
  assert.equal(utc.stdout, '2026-08-11-013000.zip')
})
