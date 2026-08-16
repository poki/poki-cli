import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test, { TestContext } from 'node:test'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const bundle = 'bin/index.js'

function filesBelow (directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? filesBelow(path) : [path]
  })
}

function assertNoPrivateReferences (contents: string, label: string): void {
  const internalRepositories = [`poki-${'devs'}`, `mother${'ship'}`]
  const legacyIdentifiers = [`POKI_${'DEVS'}_COMMIT`, `${'MOTHER'}${'SHIP'}_COMMIT`, `backend_${'revision'}`]
  const forbidden = new RegExp(`github\\.com/poki/(?:${internalRepositories.join('|')})|\\b(?:${internalRepositories.join('|')})\\b|${legacyIdentifiers.join('|')}`, 'i')

  assert.doesNotMatch(contents, forbidden, label)
  assert.doesNotMatch(contents, /api\.poki\.com\/category\//i, `${label} must use the bundled audiences command`)
}

void test('shipped documentation contains no private repository references', () => {
  for (const file of [join(repository, 'README.md'), ...filesBelow(join(repository, 'src'))]) {
    assertNoPrivateReferences(readFileSync(file, 'utf8'), file)
  }
})

// Sources are not what a user installs: the package ships one rolled-up file
// that inlines dependencies, so only scanning the bundle proves what leaves
// this repository.
void test('the built bundle that is actually published contains no private repository references', (t: TestContext) => {
  const manifest = JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8')) as { bin: Record<string, string>, files: string[] }
  assert.equal(manifest.bin.poki, bundle)
  assert.ok(manifest.files.includes(bundle), `package files must ship ${bundle}`)

  const path = join(repository, bundle)
  if (!existsSync(path)) {
    // A checkout without a build has nothing to scan. The assertions above
    // still pin the artifact this scan must cover, so renaming or dropping it
    // fails here instead of leaving the bundle silently unscanned.
    t.skip(`${bundle} is absent; run yarn build to scan the shipped bundle`)
    return
  }
  assertNoPrivateReferences(readFileSync(path, 'utf8'), path)
})
