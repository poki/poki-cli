import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

import { repository, temporaryDirectory } from './helpers'

void test('the CI reporter prints named failures and hides passing tests', t => {
  const directory = temporaryDirectory(t, 'test-reporter')
  const fixture = join(directory, 'reporter-fixture.test.mjs')
  writeFileSync(fixture, `
    import assert from 'node:assert/strict'
    import test from 'node:test'
    test('passing reporter fixture', () => {})
    test('failing reporter fixture', () => assert.equal('actual', 'expected'))
  `)

  const environment: NodeJS.ProcessEnv = { ...process.env, GITHUB_ACTIONS: 'true' }
  delete environment.NODE_OPTIONS
  delete environment.NODE_TEST_CONTEXT
  const reporter = pathToFileURL(join(repository, 'scripts', 'failures-only-reporter.mjs')).href
  const result = spawnSync(process.execPath, ['--test', `--test-reporter=${reporter}`, fixture], {
    cwd: repository,
    encoding: 'utf8',
    env: environment
  })

  assert.equal(result.status, 1, result.stderr)
  assert.doesNotMatch(result.stdout, /passing reporter fixture/)
  assert.match(result.stdout, /Failed tests \(1\):/)
  assert.match(result.stdout, /FAIL failing reporter fixture/)
  assert.match(result.stdout, /reporter-fixture\.test\.mjs:5:5/)
  assert.match(result.stdout, /AssertionError \[ERR_ASSERTION\]/)
  assert.match(result.stdout, /actual: 'actual'/)
  assert.match(result.stdout, /expected: 'expected'/)
  assert.match(result.stdout, /::error title=Failed test,file=.*reporter-fixture\.test\.mjs,line=5,col=5::/)
})
