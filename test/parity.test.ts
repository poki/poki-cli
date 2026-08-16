import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { Argv } from 'yargs'

import { ApiClient } from '../src/api'
import { registerBuiltinCommands, registerRootCommands } from '../src/cli'
import { commandSpec, CommandSpec, commandSpecs, HelpOption } from '../src/docs/commands'
import { resetProjectConfigCache } from '../src/project'
import { runCli } from './helpers'

// The specs in src/docs/commands.ts are the only documentation users ever see
// (yargs help output is unreachable by design). This suite records the actual
// yargs declarations through a probe implementing the fluent Argv surface and
// fails whenever the documented contract drifts from the declared one.
//
// The shared option helpers in src/commands/command-options.ts now generate
// their declarations from those specs, so for the roughly 240 declarations they
// produce the comparisons below hold structurally. The other roughly 280 are
// still hand-maintained copies of the same facts, and for those this suite pins
// everything an agent can act on: which commands and options exist, their
// choices, defaults, requiredness, repeatability, and whether a flag takes a
// value. It deliberately does not compare the two description texts - the yargs
// strings never reach a user - but it does require both surfaces to carry one.
//
// Two things stay checkable for generated options too, and both are checked
// below: the parsing facts a spec cannot express (whether one occurrence takes
// exactly one string) are still declared by hand, and the constraints help
// advertises are executed, so a documented conflict cannot outlive the check
// that enforces it.

interface RecordedOption {
  choices?: string[]
  default?: unknown
  demandOption: boolean
  array: boolean
  boolean: boolean
  string?: boolean
  nargs?: number
  description?: string
}

interface RecordedPositional {
  name: string
  required: boolean
  choices?: string[]
  description?: string
}

interface RecordedCommand {
  path: string[]
  positionals: RecordedPositional[]
  options: Map<string, RecordedOption>
  subcommands: Map<string, RecordedCommand>
}

interface DeclaredOptionConfig {
  choices?: ReadonlyArray<string | number>
  default?: unknown
  demandOption?: boolean
  type?: string
  array?: boolean
  string?: boolean
  nargs?: number
  describe?: string
}

// yargs epilogs and examples never render (resolveHelp answers every help
// request before yargs and showHelpOnFail is disabled), so any .epilog() or
// .example() declaration is dead documentation that can drift from the specs.
// The probe records them so the suite can assert none exist.
const renderlessDocCalls: string[] = []

function createProbe (record: RecordedCommand): Argv {
  const methods: Record<string, (...args: unknown[]) => Argv> = {
    epilog: () => {
      renderlessDocCalls.push(`'poki ${record.path.join(' ')}' declares .epilog()`)
      return probe
    },
    example: () => {
      renderlessDocCalls.push(`'poki ${record.path.join(' ')}' declares .example()`)
      return probe
    },
    command: (name, _description, builder) => {
      const tokens = String(name).split(' ')
      const child: RecordedCommand = {
        path: [...record.path, tokens[0]],
        positionals: tokens.slice(1).map(token => ({
          name: token.replace(/^[<[]/, '').replace(/[\]>]$/, '').replace(/\.\.$/, ''),
          required: token.startsWith('<')
        })),
        options: new Map(),
        subcommands: new Map()
      }
      assert.ok(!record.subcommands.has(tokens[0]), `duplicate command '${child.path.join(' ')}'`)
      record.subcommands.set(tokens[0], child)
      if (typeof builder === 'function') builder(createProbe(child))
      return probe
    },
    option: (name, config) => {
      const declared = (config ?? {}) as DeclaredOptionConfig
      record.options.set(String(name), {
        choices: declared.choices === undefined ? undefined : declared.choices.map(String),
        default: declared.default,
        demandOption: declared.demandOption === true,
        array: declared.type === 'array' || declared.array === true,
        boolean: declared.type === 'boolean',
        string: declared.string,
        nargs: declared.nargs,
        description: declared.describe
      })
      return probe
    },
    positional: (name, config) => {
      const positional = record.positionals.find(entry => entry.name === name)
      assert.ok(positional !== undefined, `positional '${String(name)}' is missing from the command string of 'poki ${record.path.join(' ')}'`)
      const declared = (config ?? {}) as DeclaredOptionConfig
      if (declared.demandOption === true) positional.required = true
      if (declared.choices !== undefined) positional.choices = declared.choices.map(String)
      positional.description = declared.describe
      return probe
    }
  }
  // Every other fluent method (check, demandCommand, ...) carries no
  // documented contract, so it chains as a no-op.
  const probe = new Proxy(methods, {
    get (target, property: string) {
      if (property in target) return target[property]
      return () => probe
    }
  }) as unknown as Argv
  return probe
}

const PROJECT_GAME_ID = 'parity-project-game'
const root: RecordedCommand = { path: [], positionals: [], options: new Map(), subcommands: new Map() }

// Register the full command surface exactly as buildCli() does. With a
// project game_id, registration-time defaults (--game and legacy build_dir
// resolution) are deterministic; without one, conditionally required game
// options must become demanded instead.
function recordCommandSurface (target: RecordedCommand, projectGameId?: string): void {
  const projectDirectory = mkdtempSync(join(tmpdir(), 'poki-cli-parity-'))
  if (projectGameId !== undefined) {
    writeFileSync(join(projectDirectory, 'poki.json'), `${JSON.stringify({ game_id: projectGameId })}\n`)
  }
  const previousDirectory = process.cwd()
  process.chdir(projectDirectory)
  resetProjectConfigCache()
  try {
    const api = new ApiClient()
    // buildCli() composes exactly these two registrations, so the probe
    // records the real declarations rather than a copy that could drift.
    void registerRootCommands(registerBuiltinCommands(createProbe(target), []), api)
  } finally {
    process.chdir(previousDirectory)
    resetProjectConfigCache()
    rmSync(projectDirectory, { recursive: true, force: true })
  }
}
recordCommandSurface(root, PROJECT_GAME_ID)
const bareRoot: RecordedCommand = { path: [], positionals: [], options: new Map(), subcommands: new Map() }
recordCommandSurface(bareRoot)

function flatten (record: RecordedCommand, into: Map<string, RecordedCommand>): Map<string, RecordedCommand> {
  for (const child of record.subcommands.values()) {
    into.set(child.path.join(' '), child)
    flatten(child, into)
  }
  return into
}
const recordedCommands = flatten(root, new Map())
const recordedWithoutProject = flatten(bareRoot, new Map())

// gameOption in docs/commands.ts documents this conditional requirement; the
// matching yargs declaration resolves the project game at registration time.
const CONDITIONAL_GAME_REQUIRED = 'when no project game is configured'

// Options whose declared yargs default legitimately differs from the spec.
// Each entry verifies what the declaration must look like instead.
const declaredDefaultExceptions = new Map<string, (declared: RecordedOption) => void>([
  // The declared default is resolved from project build_dir at registration
  // time ('dist' when unset); the spec documents that conditional default in
  // prose because no single value is always correct.
  ['versions upload --build-dir', declared => assert.equal(declared.default, 'dist')],
  ['upload --build-dir', declared => assert.equal(declared.default, 'dist')],
  ['upload --game', declared => assert.equal(declared.default, PROJECT_GAME_ID)],
  // The declared default is a freshly generated timestamped archive name
  // (uploadFilename in src/legacy.ts); the spec documents it as prose.
  ['upload --name', declared => assert.match(String(declared.default), /^\d{4}-\d{2}-\d{2}-\d{6}\.zip$/)],
  // playtest-requests create and player-fit-tests create leave these flags
  // undeclared so --data exclusivity can detect explicitly supplied flags
  // (ensureDataExclusive checks definedness); the handlers apply the
  // documented defaults with ?? / ??= instead. Declaring the default in yargs
  // would make --data always conflict with these flags.
  ['playtest-requests create --recordings', declared => assert.equal(declared.default, undefined)],
  ['playtest-requests create --device-category', declared => assert.equal(declared.default, undefined)],
  ['playtest-requests create --orientation', declared => assert.equal(declared.default, undefined)],
  ['playtest-requests create --new-users-only', declared => assert.equal(declared.default, undefined)],
  ['playtest-requests create --normal-tile', declared => assert.equal(declared.default, undefined)],
  ['player-fit-tests create --device-category', declared => assert.equal(declared.default, undefined)],
  ['player-fit-tests create --orientation', declared => assert.equal(declared.default, undefined)],
  ['player-fit-tests create --category-only', declared => assert.equal(declared.default, undefined)]
])

void test('every yargs command has a spec and every spec is a yargs command', () => {
  // Guard against a silently broken probe making the suite pass vacuously.
  assert.ok(recordedCommands.size > 50, `only ${recordedCommands.size} commands were recorded`)
  for (const key of recordedCommands.keys()) {
    assert.ok(commandSpecs.has(key), `yargs command 'poki ${key}' has no spec in docs/commands.ts`)
  }
  for (const key of commandSpecs.keys()) {
    // The root document (bare `poki`) is served by resolveHelp before yargs
    // parses anything, so it intentionally exists only as a spec.
    if (key === '') continue
    assert.ok(recordedCommands.has(key), `spec 'poki ${key}' is not a registered yargs command`)
  }
})

void test('no command declares yargs epilogs or examples', () => {
  assert.deepEqual(renderlessDocCalls, [], 'yargs epilogs and examples never render; document behavior in src/docs/commands.ts specs instead')
})

void test('group commands and group specs both stay bare', () => {
  for (const [key, record] of recordedCommands) {
    if (record.subcommands.size === 0) continue
    const spec = commandSpecs.get(key)
    assert.ok(spec !== undefined, key)
    assert.equal(spec.options, undefined, `group spec 'poki ${key}' must not document options`)
    assert.equal(spec.arguments, undefined, `group spec 'poki ${key}' must not document arguments`)
    assert.equal(record.options.size, 0, `group command 'poki ${key}' must not declare options`)
    assert.equal(record.positionals.length, 0, `group command 'poki ${key}' must not declare positionals`)
  }
})

void test('documented options match declared yargs options exactly', () => {
  const exceptionsUsed = new Set<string>()
  for (const [key, record] of recordedCommands) {
    if (record.subcommands.size > 0) continue
    const spec = commandSpecs.get(key)
    assert.ok(spec !== undefined, key)
    const specOptions = new Map((spec.options ?? []).map(option => [option.name.replace(/^--/, ''), option]))
    assert.equal(specOptions.size, (spec.options ?? []).length, `duplicate documented options for 'poki ${key}'`)
    for (const option of spec.options ?? []) {
      assert.match(option.name, /^--[a-z0-9]+(-[a-z0-9]+)*$/, `documented option '${option.name}' for 'poki ${key}' must be a kebab-case --flag`)
    }

    const undocumented = [...record.options.keys()].filter(name => !specOptions.has(name))
    const undeclared = [...specOptions.keys()].filter(name => !record.options.has(name))
    assert.deepEqual(undocumented, [], `'poki ${key}' declares options that the spec does not document`)
    assert.deepEqual(undeclared, [], `'poki ${key}' spec documents options that yargs does not declare`)

    for (const [name, declared] of record.options) {
      const documented = specOptions.get(name)
      assert.ok(documented !== undefined, name)
      const label = `'poki ${key} --${name}'`
      assert.deepEqual(declared.choices, documented.values, `choices for ${label}`)
      assert.equal(declared.array, documented.repeatable === true, `repeatable for ${label}`)
      // Whether a flag swallows the next token is not cosmetic: resolveHelp
      // reads the documented type to decide that `--tag -h` is a tag value and
      // not a help request, and MISSING_INPUT counts positionals the same way.
      // A spec that calls a valued option boolean would silently break both.
      assert.equal(declared.boolean, documented.type === 'boolean', `value-taking kind for ${label}`)
      // The two description texts intentionally differ in wording, but an
      // option that documents nothing at all is a gap on either surface.
      assert.notEqual((declared.description ?? '').trim(), '', `yargs describe for ${label}`)
      assert.notEqual(documented.description.trim(), '', `documented description for ${label}`)
      // Preserve the historical upload declaration exactly: it marks --game
      // demanded only when the legacy project config already supplies a
      // default. This oddity predates the new command surface.
      if (key === 'upload' && name === 'game') {
        assert.equal(declared.demandOption, true, `${label} must preserve the legacy configured-project declaration`)
      } else if (documented.required === true) {
        assert.equal(declared.demandOption, true, `${label} is documented required but not demanded by yargs`)
      } else {
        assert.equal(declared.demandOption, false, `${label} is demanded by yargs but not documented required:true`)
      }

      if (documented.required === CONDITIONAL_GAME_REQUIRED) {
        // With a project game configured (as in this suite) the declaration
        // must default to it and must not be demanded; without one it becomes
        // demanded (withDefaultGameOption in src/commands/common.ts).
        assert.equal(declared.default, PROJECT_GAME_ID, `${label} must default to the configured project game`)
        continue
      }
      const exception = declaredDefaultExceptions.get(`${key} --${name}`)
      if (exception !== undefined) {
        exception(declared)
        exceptionsUsed.add(`${key} --${name}`)
        continue
      }
      assert.deepEqual(declared.default, documented.default, `default for ${label}`)
    }
  }
  assert.deepEqual([...declaredDefaultExceptions.keys()].filter(key => !exceptionsUsed.has(key)), [], 'stale declared-default exceptions')
})

// Sample values for the runtime invocations below. An option absent from this
// map takes '1', which every remaining runtime check accepts.
const SAMPLE_VALUES = new Map([
  ['--fields', 'id'],
  // --page conflicts with --all only away from its default of 1.
  ['--page', '2'],
  ['--tag', 'sample-tag'],
  ['--data', '{}'],
  ['--last-days', '7'],
  ['--from-date', '2026-01-01'],
  ['--to-date', '2026-01-02'],
  ['--team', 'TEAM_ID'],
  ['--game', 'GAME_ID'],
  ['--filter', 'id=SAMPLE_ID'],
  ['--sort', 'created_at']
])

function sampleTokens (option: HelpOption, value?: string): string[] {
  if (option.type === 'boolean') return [option.name]
  return [option.name, value ?? SAMPLE_VALUES.get(option.name) ?? '1']
}

// The command path plus everything it requires, and nothing else: the shortest
// invocation that reaches a command's own local validation.
function requiredInvocation (spec: CommandSpec): string[] {
  const args = [...spec.path]
  for (const argument of spec.arguments ?? []) {
    if (argument.required) args.push(argument.values?.[0] ?? 'SAMPLE_ID')
  }
  for (const declared of spec.options ?? []) {
    if (declared.required === true || declared.required === CONDITIONAL_GAME_REQUIRED) args.push(...sampleTokens(declared))
  }
  return args
}

// Options whose declaration must take exactly one string per occurrence. A spec
// cannot say this: `repeatable` only means the option may appear more than
// once, and most repeatable options (--tag, --event, --category) deliberately
// let yargs gather trailing tokens. These three are the ones the shared helpers
// declare by hand for that reason, so nothing generated from a spec can carry
// the fact and nothing else in this suite would notice it disappearing.
const SINGLE_VALUE_OPTIONS = ['filter', 'sort', 'data']

void test('single-value options declare the parsing the spec cannot express', () => {
  let checked = 0
  for (const [key, record] of recordedCommands) {
    for (const name of SINGLE_VALUE_OPTIONS) {
      const declared = record.options.get(name)
      if (declared === undefined) continue
      const label = `'poki ${key} --${name}'`
      assert.equal(declared.nargs, 1, `${label} must take exactly one value per occurrence`)
      // Repeated JSON:API values are opaque strings; without string:true yargs
      // would turn `--filter version_id=1` into a number.
      if (declared.array) assert.equal(declared.string, true, `${label} must keep its repeated values as strings`)
      checked++
    }
  }
  assert.ok(checked >= 25, `only ${checked} single-value declarations were checked`)
})

// The declaration test above proves nargs was written down. Only parsing proves
// it still applies: without it the token after the value disappears into the
// option and the invocation silently becomes a different command.
void test('a token following a single-value option is not swallowed', async () => {
  let checked = 0
  for (const name of SINGLE_VALUE_OPTIONS) {
    const entry = [...recordedCommands].find(([, record]) => record.options.has(name))
    assert.ok(entry !== undefined, `no command declares --${name}`)
    const [key, record] = entry
    const spec = commandSpecs.get(key)
    assert.ok(spec !== undefined, key)
    const value = SAMPLE_VALUES.get(`--${name}`) ?? '1'
    const args = [...requiredInvocation(spec), `--${name}`, value, 'SWALLOWED_TOKEN']
    const result = await runCli(args)
    const label = `'poki ${args.join(' ')}' (--${name} declared by 'poki ${key}')`
    assert.ok(record.options.has(name), label)
    assert.equal(result.code, 2, `${label} must reject the trailing token\n${result.stdout}${result.stderr}`)
    assert.match(result.stderr, /SWALLOWED_TOKEN/, label)
    checked++
  }
  assert.equal(checked, SINGLE_VALUE_OPTIONS.length)
})

// A conflict is either a bare option name or an option scoped to one of its
// documented values ('--format csv'), because some options conflict only with a
// particular value. Both halves have to name something the command declares, or
// help advertises a constraint an agent cannot act on.
void test('documented option conflicts name options and values declared by the same command', () => {
  let conflictCount = 0
  let valueScopedCount = 0
  for (const [key, spec] of commandSpecs) {
    const options = new Map((spec.options ?? []).map(option => [option.name, option]))
    for (const option of spec.options ?? []) {
      for (const conflict of option.conflicts ?? []) {
        const [name, ...rest] = conflict.split(' ')
        const value = rest.join(' ')
        assert.notEqual(name, option.name, `'poki ${key} ${option.name}' conflicts with itself`)
        const conflicting = options.get(name)
        assert.ok(conflicting !== undefined, `'poki ${key} ${option.name}' documents unknown conflict '${conflict}'`)
        if (value !== '') {
          assert.ok(
            (conflicting.values ?? []).includes(value),
            `'poki ${key} ${option.name}' documents conflict '${conflict}' with a value '${name}' does not declare`
          )
          valueScopedCount++
        }
        conflictCount++
      }
    }
  }
  assert.ok(conflictCount >= 20, `only ${String(conflictCount)} documented option conflicts were checked`)
  assert.ok(valueScopedCount >= 1, 'no value-scoped option conflict was checked')
})

// Builds the smallest invocation that reaches the conflict check: the required
// positionals and options first, then the two conflicting flags. Nothing here
// may reach the network, and the hermetic environment guarantees that a
// conflict which stopped being enforced fails loudly instead.
function conflictInvocation (spec: CommandSpec, option: HelpOption, conflict: string): string[] {
  const args = [...requiredInvocation(spec), ...sampleTokens(option)]
  const [name, ...rest] = conflict.split(' ')
  const conflicting = (spec.options ?? []).find(candidate => candidate.name === name)
  assert.ok(conflicting !== undefined, conflict)
  args.push(...sampleTokens(conflicting, rest.length === 0 ? undefined : rest.join(' ')))
  return args
}

// The declaration test above only proves a documented conflict names real
// options. This one proves the constraint exists at all: the runtime check
// lives in src/commands, so nothing else stops help from advertising a rule
// that was deleted there. One invocation per distinct rule keeps the suite
// fast, and a paginated list is exercised separately from a single-page one
// because they resolve --raw through different documented conflict sets.
void test('every documented option conflict is rejected at runtime', async () => {
  const rules = new Map<string, { key: string, spec: CommandSpec, option: HelpOption, conflict: string }>()
  let declarations = 0
  for (const [key, spec] of commandSpecs) {
    const paginated = (spec.options ?? []).some(option => option.name === '--all')
    for (const option of spec.options ?? []) {
      for (const conflict of option.conflicts ?? []) {
        declarations++
        const rule = `${option.name} + ${conflict} (${paginated ? 'paginated' : 'single-page'})`
        if (!rules.has(rule)) rules.set(rule, { key, spec, option, conflict })
      }
    }
  }
  assert.ok(declarations >= 100, `only ${declarations} documented conflicts exist`)

  for (const [rule, { key, spec, option, conflict }] of rules) {
    const args = conflictInvocation(spec, option, conflict)
    const result = await runCli(args)
    const label = `'poki ${args.join(' ')}' (${key}: ${rule})`
    assert.equal(result.code, 2, `${label} must be rejected with exit 2\n${result.stderr}`)
    assert.match(result.stderr, /INVALID_INPUT/, label)
  }
})

// versions upload streams a multipart archive and versions download streams a
// signed one, so both raise the ordinary 30 s budget to 300000 ms. Only the
// spec text is ever read, and an agent that trusts a stale 30000 there would
// set its own deadline far too low for a multi-megabyte transfer.
void test('streaming transfer commands document their 300000 ms timeout default on both surfaces', () => {
  for (const command of ['versions upload', 'versions download']) {
    const declared = recordedCommands.get(command)?.options.get('timeout-ms')
    const documented = commandSpecs.get(command)?.options?.find(option => option.name === '--timeout-ms')
    assert.match(declared?.description ?? '', /POKI_API_TIMEOUT_MS or 300000/, `${command} yargs declaration`)
    assert.match(documented?.description ?? '', /POKI_API_TIMEOUT_MS or 300000/, `${command} structured help`)
  }

  const ordinary = recordedCommands.get('games get')?.options.get('timeout-ms')
  assert.match(ordinary?.description ?? '', /POKI_API_TIMEOUT_MS or 30000$/)
  assert.doesNotMatch(ordinary?.description ?? '', /300000/)
})

void test('without a project game, conditionally required game options become demanded', () => {
  let checked = 0
  for (const [key, spec] of commandSpecs) {
    for (const option of spec.options ?? []) {
      if (option.required !== CONDITIONAL_GAME_REQUIRED) continue
      const record = recordedWithoutProject.get(key)
      assert.ok(record !== undefined, key)
      const declared = record.options.get(option.name.replace(/^--/, ''))
      assert.ok(declared !== undefined, `'poki ${key} ${option.name}'`)
      assert.equal(declared.demandOption, true, `'poki ${key} ${option.name}' must be demanded when no project game is configured`)
      assert.equal(declared.default, undefined, `'poki ${key} ${option.name}' must have no default without a project game`)
      checked++
    }
  }
  // Guard against the conditional-requirement convention silently vanishing.
  assert.ok(checked >= 20, `only ${checked} conditionally required game options were checked`)
})

void test('legacy upload keeps its historical project-dependent game declaration', () => {
  const configured = recordedCommands.get('upload')?.options.get('game')
  assert.equal(configured?.demandOption, true)
  assert.equal(configured?.default, PROJECT_GAME_ID)

  const unconfigured = recordedWithoutProject.get('upload')?.options.get('game')
  assert.equal(unconfigured?.demandOption, false)
  assert.equal(unconfigured?.default, undefined)
})

void test('documented arguments match declared yargs positionals exactly', () => {
  let enumPositionals = 0
  for (const [key, record] of recordedCommands) {
    if (record.subcommands.size > 0) continue
    const spec = commandSpecs.get(key)
    assert.ok(spec !== undefined, key)
    // values/choices are compared in both directions: a positional declaring
    // yargs choices must document an identical spec values array, and a spec
    // values array must be enforced by identical declared choices.
    const documented = (spec.arguments ?? []).map(argument => ({ name: argument.name, required: argument.required, values: argument.values }))
    const declared = record.positionals.map(positional => ({ name: positional.name, required: positional.required, values: positional.choices }))
    assert.deepEqual(declared, documented, `arguments for 'poki ${key}'`)
    enumPositionals += declared.filter(positional => positional.values !== undefined).length
    for (const positional of record.positionals) {
      assert.notEqual((positional.description ?? '').trim(), '', `yargs describe for positional '${positional.name}' of 'poki ${key}'`)
    }
    for (const argument of spec.arguments ?? []) {
      assert.notEqual(argument.description.trim(), '', `documented description for argument '${argument.name}' of 'poki ${key}'`)
    }
  }
  // Guard against the probe silently dropping positional choices: at least
  // `poki data describe [topic]` declares them.
  assert.ok(enumPositionals >= 1, 'no positional enum choices were recorded')
})

void test('missing_input specs describe real action commands', () => {
  for (const [key, spec] of commandSpecs) {
    if (spec.missing_input === undefined) continue
    const record = recordedCommands.get(key)
    assert.ok(record !== undefined, `missing_input spec 'poki ${key}' is not a registered yargs command`)
    assert.equal(record.subcommands.size, 0, `missing_input spec 'poki ${key}' must be an action, not a group`)
  }
})

void test('every spec example resolves to a real command path', () => {
  for (const [key, spec] of commandSpecs) {
    const examples = [...(spec.examples ?? []), ...(spec.quickstart ?? []), ...(spec.discovery ?? [])]
    for (const { command } of examples) {
      const label = `example '${command}' of 'poki ${key}'`
      assert.ok(command === 'poki' || command.startsWith('poki '), `${label} must start with 'poki '`)
      const tokens = command.split(' ').slice(1)
      const path: string[] = []
      while (path.length < tokens.length && !tokens[path.length].startsWith('-') && commandSpec([...path, tokens[path.length]]) !== undefined) {
        path.push(tokens[path.length])
      }
      const resolved = commandSpec(path)
      assert.ok(resolved !== undefined, label)
      // After the command path, positional values may follow (a variadic
      // string[] argument accepts any number); the next token after those must
      // be an option flag.
      const remaining = tokens.slice(path.length)
      const variadic = resolved.arguments?.some(argument => argument.type.endsWith('[]')) === true
      const argumentCount = variadic ? Infinity : resolved.arguments?.length ?? 0
      let consumed = 0
      while (consumed < remaining.length && consumed < argumentCount && !remaining[consumed].startsWith('-')) consumed++
      const next = remaining[consumed] as string | undefined
      assert.ok(next === undefined || next.startsWith('-'), `${label} does not resolve to a command path ('${next ?? ''}' is neither a command nor an argument)`)
    }
  }
})
