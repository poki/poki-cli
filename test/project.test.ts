import assert from 'node:assert/strict'
import { realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test, { TestContext } from 'node:test'

import { configHomeEnvironment, RunResult, runCli, temporaryDirectory } from './helpers'

// realpathSync avoids macOS /var vs /private/var mismatches when asserting
// the absolute configuration path reported by `poki context`.
function projectDirectory (t: TestContext, slug: string): string {
  return realpathSync(temporaryDirectory(t, slug))
}

async function runContext (directory: string): Promise<RunResult> {
  return await runCli(['context', '--format', 'json'], {
    cwd: directory,
    env: configHomeEnvironment(join(directory, 'empty-config'))
  })
}

void test('context resolves the poki key in package.json when poki.json is absent', async t => {
  const directory = projectDirectory(t, 'project-package')
  writeFileSync(join(directory, 'package.json'), JSON.stringify({
    name: 'example',
    poki: { game_id: 'pkg-game', build_dir: 'www' }
  }))

  const result = await runContext(directory)
  assert.equal(result.code, 0, result.stderr)
  const context = JSON.parse(result.stdout)
  assert.equal(context.project.source, 'package.json#poki')
  assert.equal(context.project.path, join(directory, 'package.json'))
  assert.equal(context.project.game_id, 'pkg-game')
  assert.equal(context.project.build_dir, 'www')
})

void test('poki.json wins over a conflicting package.json poki key', async t => {
  const directory = projectDirectory(t, 'project-both')
  writeFileSync(join(directory, 'poki.json'), JSON.stringify({ game_id: 'poki-game' }))
  writeFileSync(join(directory, 'package.json'), JSON.stringify({
    name: 'example',
    poki: { game_id: 'pkg-game' }
  }))

  const result = await runContext(directory)
  assert.equal(result.code, 0, result.stderr)
  const context = JSON.parse(result.stdout)
  assert.equal(context.project.source, 'poki.json')
  assert.equal(context.project.path, join(directory, 'poki.json'))
  assert.equal(context.project.game_id, 'poki-game')
})

void test('a non-string game_id in package.json is a structured input error', async t => {
  const directory = projectDirectory(t, 'project-numeric')
  writeFileSync(join(directory, 'package.json'), JSON.stringify({
    name: 'example',
    poki: { game_id: 42 }
  }))

  const result = await runContext(directory)
  assert.equal(result.code, 2)
  assert.equal(result.stdout, '')
  const error = JSON.parse(result.stderr).error
  assert.equal(error.code, 'INVALID_INPUT')
  assert.match(error.message, /game_id/)
  assert.match(error.message, /must be a string/)
})

void test('a package.json without a poki key means no project and yields hints', async t => {
  const directory = projectDirectory(t, 'project-none')
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: 'example' }))

  const result = await runContext(directory)
  assert.equal(result.code, 0, result.stderr)
  const context = JSON.parse(result.stdout)
  assert.equal(context.project.source, 'none')
  assert.equal(context.project.path, null)
  assert.equal(context.project.game_id, null)
  assert.ok(Array.isArray(context.hints))
  assert.ok(context.hints.some((hint: string) => hint.includes('No project game configured')))
})

void test('an empty-string game_id does not satisfy game-scoped commands', async t => {
  const directory = projectDirectory(t, 'project-empty-game')
  writeFileSync(join(directory, 'poki.json'), JSON.stringify({ game_id: '', build_dir: 'dist' }))

  const result = await runCli(['versions', 'list', '--format', 'json'], {
    cwd: directory,
    env: configHomeEnvironment(join(directory, 'empty-config'))
  })
  assert.equal(result.code, 2)
  assert.equal(result.stdout, '')
  const error = JSON.parse(result.stderr).error
  assert.equal(error.code, 'INVALID_INPUT')
  assert.match(error.message, /game ID is required/)
  assert.match(error.hint, /poki init --game/)
})
