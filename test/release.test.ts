import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test, { type TestContext } from 'node:test'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8')) as {
  devDependencies: Record<string, string>
  publishConfig: { registry: string }
  scripts: Record<string, string>
}

function runGit (directory: string, arguments_: string[]): string {
  const environment = { ...process.env }
  delete environment.GIT_INDEX_FILE
  const result = spawnSync('git', arguments_, { cwd: directory, encoding: 'utf8', env: environment })
  assert.equal(result.status, 0, [result.stdout, result.stderr].filter(Boolean).join('\n'))
  return result.stdout.trim()
}

function withoutAlternateGitIndex<T> (operation: () => T): T {
  const gitIndex = process.env.GIT_INDEX_FILE
  delete process.env.GIT_INDEX_FILE
  try {
    return operation()
  } finally {
    if (gitIndex !== undefined) process.env.GIT_INDEX_FILE = gitIndex
  }
}

async function releaseRepository (t: TestContext): Promise<{ commit: string, remote: string, worktree: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'poki-cli-release-git-'))
  t.after(async () => { await rm(directory, { recursive: true, force: true }) })
  const remote = join(directory, 'remote.git')
  const worktree = join(directory, 'worktree')
  await mkdir(worktree)
  runGit(directory, ['init', '--bare', remote])
  runGit(worktree, ['init', '--initial-branch=main'])
  runGit(worktree, ['config', 'user.name', 'Release Test'])
  runGit(worktree, ['config', 'user.email', 'release@example.com'])
  await writeFile(join(worktree, 'release.txt'), 'release\n')
  runGit(worktree, ['add', 'release.txt'])
  runGit(worktree, ['commit', '-m', 'release'])
  runGit(worktree, ['remote', 'add', 'origin', remote])
  runGit(worktree, ['push', '--set-upstream', 'origin', 'main'])
  return { commit: runGit(worktree, ['rev-parse', 'HEAD']), remote, worktree }
}

void test('release publication validates and publishes the verified index package', () => {
  assert.equal(manifest.scripts.test, 'node scripts/test.mjs')
  assert.equal(
    manifest.scripts['release:validate'],
    'yarn validate:source && yarn build && yarn audit:dependencies'
  )
  assert.equal(
    manifest.scripts['release:check'],
    'yarn release:validate && yarn test:package --require-clean'
  )
  assert.equal(
    manifest.scripts['release:publish'],
    'yarn release:validate && yarn test:package --require-clean --publish'
  )
  assert.equal(manifest.publishConfig.registry, 'https://registry.npmjs.org/')
  assert.equal(manifest.devDependencies.semver, '^7.7.4')
})

void test('prerelease publication requires one explicit npm-valid non-latest dist-tag without contacting npm', () => {
  const moduleUrl = pathToFileURL(join(repository, 'scripts', 'release-tag.mjs')).href
  const probe = `
    import { validatePublishTag } from ${JSON.stringify(moduleUrl)}
    const cases = ${JSON.stringify([
      ['0.2.0-experimental.0', [], false],
      ['0.2.0-experimental.0', ['--tag', 'latest'], false],
      ['0.2.0-experimental.0', ['--tag'], false],
      ['0.2.0-experimental.0', ['--tag='], false],
      ['0.2.0-experimental.0', ['--tag', 'experimental', '--tag', 'next'], false],
      ['0.2.0-experimental.0', ['-t', 'experimental'], false],
      ['0.2.0-experimental.0', ['--tag', 'v0.2.0-exp.0'], false],
      ['0.2.0-experimental.0', ['--tag', 'x'], false],
      ['0.2.0-experimental.0', ['--tag', 'experimental'], true],
      ['0.2.0-experimental.0', ['--tag', 'exp-0.2.0'], true],
      ['0.2.0-experimental.1', ['--tag=experimental'], true],
      ['0.2.0', [], true],
      ['0.2.0', ['--tag', 'latest'], true],
      ['0.2.0', ['--tag', 'experimental'], true]
    ])}
    const results = cases.map(([version, args, expected]) => {
      let accepted = true
      try { validatePublishTag(version, args) } catch { accepted = false }
      return { accepted, expected }
    })
    process.stdout.write(JSON.stringify(results))
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', probe], {
    cwd: repository,
    encoding: 'utf8',
    env: { ...process.env, npm_config_registry: 'http://127.0.0.1:1' }
  })
  assert.equal(result.status, 0, result.stderr)
  const cases = JSON.parse(result.stdout) as Array<{ accepted: boolean, expected: boolean }>
  assert.ok(cases.every(value => value.accepted === value.expected), result.stdout)
})

void test('publication explicitly owns latest and dry-run instead of inheriting ambient npm configuration', () => {
  const moduleUrl = pathToFileURL(join(repository, 'scripts', 'release-tag.mjs')).href
  const probe = `
    import { releasePublishIsDryRun, resolveReleasePublishArguments } from ${JSON.stringify(moduleUrl)}
    const resolved = [
      resolveReleasePublishArguments('0.2.0', []),
      resolveReleasePublishArguments('0.2.0', ['--dry-run']),
      resolveReleasePublishArguments('0.2.0', ['--dry-run=false']),
      resolveReleasePublishArguments('0.2.0', ['--tag', 'next']),
      resolveReleasePublishArguments('0.2.0-experimental.0', ['--tag=experimental'])
    ]
    process.stdout.write(JSON.stringify({ resolved, dryRuns: resolved.map(releasePublishIsDryRun) }))
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', probe], {
    cwd: repository,
    encoding: 'utf8',
    env: { ...process.env, NPM_CONFIG_DRY_RUN: 'true', NPM_CONFIG_TAG: 'experimental' }
  })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), {
    resolved: [
      ['--dry-run=false', '--tag', 'latest'],
      ['--dry-run', '--tag', 'latest'],
      ['--dry-run=false', '--tag', 'latest'],
      ['--tag', 'next', '--dry-run=false'],
      ['--tag=experimental', '--dry-run=false']
    ],
    dryRuns: [false, true, false, false, false]
  })
})

void test('release Git tagging preflights without mutation, then creates and pushes the version tag', async t => {
  const { commit, remote, worktree } = await releaseRepository(t)
  const moduleUrl = pathToFileURL(join(repository, 'scripts', 'release-git-tag.mjs')).href
  const { prepareReleaseGitTag, publishReleaseGitTag } = await import(moduleUrl)

  const plan = withoutAlternateGitIndex(() => prepareReleaseGitTag(worktree, '0.2.0-experimental.0'))
  assert.equal(plan.tag, 'v0.2.0-experimental.0')
  assert.equal(plan.commit, commit)
  assert.equal(spawnSync('git', ['show-ref', '--verify', '--quiet', plan.reference], { cwd: worktree }).status, 1)

  withoutAlternateGitIndex(() => publishReleaseGitTag(plan))
  assert.equal(runGit(worktree, ['rev-parse', plan.reference]), commit)
  assert.equal(runGit(worktree, ['--git-dir', remote, 'rev-parse', plan.reference]), commit)
  assert.throws(() => withoutAlternateGitIndex(() => prepareReleaseGitTag(worktree, '0.2.0-experimental.0')), /already exists locally/)
  runGit(worktree, ['update-ref', '-d', plan.reference])
  assert.throws(() => withoutAlternateGitIndex(() => prepareReleaseGitTag(worktree, '0.2.0-experimental.0')), /already exists on 'origin'/)
})

void test('release Git tagging refuses uncommitted index bytes', async t => {
  const { worktree } = await releaseRepository(t)
  const moduleUrl = pathToFileURL(join(repository, 'scripts', 'release-git-tag.mjs')).href
  const { prepareReleaseGitTag } = await import(moduleUrl)
  await writeFile(join(worktree, 'release.txt'), 'changed\n')
  runGit(worktree, ['add', 'release.txt'])
  assert.throws(
    () => withoutAlternateGitIndex(() => prepareReleaseGitTag(worktree, '0.2.0')),
    /requires every indexed change to be committed/
  )
})

void test('failed Git push after npm publication preserves the local tag and gives tag-only recovery', async t => {
  const { commit, remote, worktree } = await releaseRepository(t)
  const moduleUrl = pathToFileURL(join(repository, 'scripts', 'release-git-tag.mjs')).href
  const { prepareReleaseGitTag, publishReleaseGitTag } = await import(moduleUrl)
  const plan = withoutAlternateGitIndex(() => prepareReleaseGitTag(worktree, '0.2.0'))
  const rejectPush = join(remote, 'hooks', 'pre-receive')
  await writeFile(rejectPush, '#!/bin/sh\nexit 1\n')
  await chmod(rejectPush, 0o755)

  assert.throws(
    () => withoutAlternateGitIndex(() => publishReleaseGitTag(plan)),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /npm publication succeeded/)
      assert.match(error.message, /Do not rerun yarn release:publish/)
      assert.match(error.message, /git push origin refs\/tags\/v0\.2\.0:refs\/tags\/v0\.2\.0/)
      return true
    }
  )
  assert.equal(runGit(worktree, ['rev-parse', plan.reference]), commit)
})

void test('an uninspectable Git push outcome requires remote inspection before recovery', async t => {
  const { remote, worktree } = await releaseRepository(t)
  const moduleUrl = pathToFileURL(join(repository, 'scripts', 'release-git-tag.mjs')).href
  const { prepareReleaseGitTag, publishReleaseGitTag } = await import(moduleUrl)
  const plan = withoutAlternateGitIndex(() => prepareReleaseGitTag(worktree, '0.2.0'))
  await rm(remote, { recursive: true, force: true })

  assert.throws(
    () => withoutAlternateGitIndex(() => publishReleaseGitTag(plan)),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /First inspect 'refs\/tags\/v0\.2\.0'/)
      assert.doesNotMatch(error.message, /^Run:/m)
      return true
    }
  )
})
