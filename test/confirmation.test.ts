import assert from 'node:assert/strict'
import test from 'node:test'

import { commandSpecs, CommandSpec } from '../src/docs/commands'
import { apiHarness, runCli } from './helpers'

// Every documented destructive command that carries the --yes gate. (The
// deprecated legacy upload command is destructive but has no --yes option.)
const destructiveSpecs = [...commandSpecs.values()]
  .filter(spec => spec.destructive === true && (spec.options ?? []).some(option => option.name === '--yes'))

// Emptiness guard for the generated suite below: if a refactor broke the spec
// filter, the loop would silently generate zero tests and stay green.
void test('the generated destructive-gate suite covers a non-trivial command set', () => {
  assert.ok(destructiveSpecs.length >= 8, `only ${destructiveSpecs.length} destructive specs with a --yes option were found`)
})

// Builds a syntactically complete invocation the same way the spec's
// generated examples do: dummy uppercase IDs for required positionals, dummy
// values for unconditionally required options, and --game for game-scoped
// commands.
function invocation (spec: CommandSpec): string[] {
  const args = [...spec.path]
  for (const value of spec.arguments ?? []) {
    if (value.required) args.push(value.name.toUpperCase().replace(/-/g, '_'))
  }
  for (const value of spec.options ?? []) {
    if (value.required !== true) continue
    args.push(value.name)
    if (value.type !== 'boolean') args.push(value.name.slice(2).toUpperCase().replace(/-/g, '_'))
  }
  if ((spec.options ?? []).some(option => option.name === '--game')) args.push('--game', 'g')
  // replace refuses to run without at least one override, so satisfy its
  // missing_input contract with a recording count.
  if (spec.path.join(' ') === 'playtest-requests replace') args.push('--recordings', '5')
  return args
}

for (const spec of destructiveSpecs) {
  const name = spec.path.join(' ')
  void test(`poki ${name} refuses to run without --yes and performs zero requests`, async t => {
    let requests = 0
    const { directory, env } = await apiHarness(t, (_req, res) => {
      requests++
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end('{}')
    }, 'confirmation')

    const args = [...invocation(spec), '--format', 'json']
    const unconfirmed = await runCli(args, { env, cwd: directory })
    assert.equal(unconfirmed.code, 2, unconfirmed.stderr)
    const error = JSON.parse(unconfirmed.stderr).error
    assert.equal(error.code, 'INVALID_INPUT')
    assert.match(String(error.message), /--yes/)
    assert.equal(requests, 0)

    // playtest-requests replace legitimately GETs the game while resolving a
    // --dry-run preview, so its dry-run half is exercised elsewhere.
    if (name !== 'playtest-requests replace') {
      const preview = await runCli([...args, '--dry-run'], { env, cwd: directory })
      assert.equal(preview.code, 0, preview.stderr)
      assert.equal(requests, 0)
    }
  })
}
