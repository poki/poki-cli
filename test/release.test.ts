import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8')) as {
  publishConfig: { registry: string }
  scripts: Record<string, string>
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
})

void test('prerelease publication requires one explicit safe non-latest dist-tag without contacting npm', () => {
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
      ['0.2.0-experimental.0', ['--tag', 'experimental'], true],
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

void test('stable publication explicitly owns latest instead of inheriting an ambient npm dist-tag', () => {
  const moduleUrl = pathToFileURL(join(repository, 'scripts', 'release-tag.mjs')).href
  const probe = `
    import { resolveReleasePublishArguments } from ${JSON.stringify(moduleUrl)}
    const resolved = [
      resolveReleasePublishArguments('0.2.0', []),
      resolveReleasePublishArguments('0.2.0', ['--dry-run']),
      resolveReleasePublishArguments('0.2.0', ['--tag', 'next']),
      resolveReleasePublishArguments('0.2.0-experimental.0', ['--tag=experimental'])
    ]
    process.stdout.write(JSON.stringify(resolved))
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', probe], {
    cwd: repository,
    encoding: 'utf8',
    env: { ...process.env, NPM_CONFIG_TAG: 'experimental' }
  })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), [
    ['--tag', 'latest'],
    ['--dry-run', '--tag', 'latest'],
    ['--tag', 'next'],
    ['--tag=experimental']
  ])
})
