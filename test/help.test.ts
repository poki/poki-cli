import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { commandManifest, commandSpecs, helpDocument, helpTopics, searchCommandManifest } from '../src/docs/commands'
import { developerPermissionCatalog, developerPermissionCodes } from '../src/developer-permissions'
import { CliError } from '../src/errors'
import { resolveHelp } from '../src/help'
import { parseToon, runCli, temporaryDirectory } from './helpers'

function withoutNotice (value: Record<string, any>): Record<string, any> {
  const { notice, ...document } = value
  return document
}

void test('root help is compact structured TOON with an optional implicit notice', async () => {
  const empty = await runCli([])
  const explicit = await runCli(['--help'])
  const routed = await runCli(['help'])
  const json = await runCli(['--help', '--format', 'json'])

  assert.equal(empty.code, 0)
  assert.equal(empty.stderr, '')
  assert.equal(explicit.code, 0)
  assert.equal(explicit.stderr, '')
  assert.equal(routed.code, 0)
  assert.equal(routed.stderr, '')
  assert.equal(explicit.stdout, routed.stdout)
  const emptyDocument = parseToon(empty.stdout)
  const explicitDocument = parseToon(explicit.stdout)
  assert.equal(emptyDocument.notice.code, 'MISSING_COMMAND')
  assert.deepEqual(withoutNotice(emptyDocument), explicitDocument)
  assert.deepEqual(JSON.parse(json.stdout), explicitDocument)
  assert.equal(explicitDocument.usage, 'poki <command> [options]')
  assert.ok(explicitDocument.behavior.some((item: string) => item.includes('Europe/Amsterdam')))
  assert.ok(explicitDocument.behavior.some((item: string) => item.includes('non-data API endpoints use UTC')))
  assert.match(explicitDocument.quickstart.find((item: { command: string }) => item.command === 'poki auth login')?.purpose ?? '', /agent.*not run.*developer.*npx poki auth login/i)
  assert.ok(explicitDocument.behavior.some((item: string) => /Only init.*auth.*deprecated upload.*cross-release compatible.*Pin an exact version/i.test(item)))
  assert.ok(explicitDocument.commands.some((command: { path: string }) => command.path === 'poki versions'))
  assert.ok(explicitDocument.commands.some((command: { path: string }) => command.path === 'poki version-activations'))
  assert.ok(explicitDocument.discovery.some((item: { command: string }) => item.command === 'poki help --all'))
  assert.equal(explicitDocument.help.search, 'poki help --search TEXT')
})

void test('structured help rejects ambiguous modes and unknown help options', async () => {
  for (const args of [
    ['help', '--unknown', '--format', 'json'],
    ['help', '--all', 'games', '--format', 'json'],
    ['help', '--search', '--format', 'json'],
    ['help', '--format', 'yaml']
  ]) {
    const result = await runCli(args)
    assert.equal(result.code, 2, `${args.join(' ')}: ${result.stderr}`)
    assert.equal(result.stdout, '')
    const error = args.includes('json') ? JSON.parse(result.stderr) : parseToon(result.stderr)
    assert.equal(error.error.code, 'INVALID_INPUT')
  }
})

void test('structured shapes help explains analytics condition select expressions', () => {
  const document = resolveHelp(['help', 'shapes'])?.document as Record<string, any>
  const conditions = String(document.analytics_results.conditions)
  assert.match(conditions, /left may be a field or validated select-statement expression/)
  assert.match(conditions, /right may be the operator-specific literal value\(s\) or a validated select-statement expression/)
  assert.match(conditions, /not as database subqueries/)
  assert.match(String(document.analytics_results.game_event_terminology), /Game Events.*Category.*What.*Action.*category.*action.*label/i)

  const authRequired = document.error_envelope.codes.find((code: string) => code.startsWith('AUTH_REQUIRED'))
  assert.match(authRequired, /ask the developer.*poki auth login.*npx poki auth login.*never run.*agent sandbox.*after the developer confirms.*retry/i)
})

void test('auth login is machine-readable as a developer-only action for global and project installs', () => {
  const login = helpDocument(['auth', 'login']) as Record<string, any>
  assert.deepEqual(login.agent_execution, {
    allowed: false,
    required_actor: 'developer',
    reason: 'The saved credentials must belong to the developer environment and would be lost with an LLM or agent sandbox.',
    developer_commands: {
      global: 'poki auth login',
      project_dependency: 'npx poki auth login'
    }
  })
  assert.match(login.behavior.join(' '), /ask the developer.*never run.*agent sandbox/i)
  assert.deepEqual(login.examples.map((item: { command: string }) => item.command), ['poki auth login'])

  const auth = helpDocument(['auth']) as Record<string, any>
  assert.equal(auth.commands.find((command: { path: string }) => command.path === 'poki auth login')?.agent_execution?.allowed, false)

  const manifest = commandManifest() as Record<string, any>
  assert.equal(manifest.commands.find((command: { command: string }) => command.command === 'poki auth login')?.agent_execution?.allowed, false)
})

void test('structured update help publishes cadence, exclusions, state, exact npm actions, and no-replay guidance', () => {
  const updates = resolveHelp(['help', 'updates'])?.document as Record<string, any>
  assert.equal(updates.topic, 'updates')
  assert.match(String(updates.checking.cadence), /rolling 24 hours/i)
  assert.equal(updates.checking.registry_command, 'npm view @poki/cli "dist-tags.latest" --json')
  assert.match(String(updates.checking.excluded), /Help.*version.*auth.*legacy upload.*context.*audiences.*--dry-run.*--validate-only/i)
  assert.match(String(updates.state.file), /update-check\.json/)
  assert.match(String(updates.state.sharing), /Global and project-local.*cross-process lock/i)
  assert.equal(updates.notice.shape.notice.channel, 'latest')
  assert.equal(updates.notice.shape.notice.update_commands.global, 'npm install --global --ignore-scripts --no-audit --no-fund @poki/cli@AVAILABLE_VERSION')
  assert.equal(updates.notice.shape.notice.update_commands.project_local, 'npm install --save-dev --ignore-scripts --no-audit --no-fund @poki/cli@AVAILABLE_VERSION')
  assert.equal(updates.notice.shape.notice.completed_command_requires_rerun, false)
  assert.match(updates.llm_action.join(' '), /Do not replay/)
  assert.match(updates.llm_action.join(' '), /inspect poki help --all.*Only init.*auth login\/status\/logout.*upload.*cross-release compatibility/i)
  assert.match(String(updates.opt_out), /POKI_CLI_UPDATE_CHECK=0/)

  const shapes = resolveHelp(['help', 'shapes'])?.document as Record<string, any>
  assert.match(String(shapes.channels.stderr), /successful.*CLI_UPDATE_AVAILABLE/i)
  assert.match(String(shapes.update_notice.separation), /stdout are unchanged.*Failures never receive/i)
})

void test('structured help keeps signed funnel hashes out of JavaScript numbers', () => {
  const shapes = resolveHelp(['help', 'shapes'])?.document as Record<string, any>
  assert.match(String(shapes.analytics_results.signed_int64_hashes), /toString\(event_hash\).*groupUniqArray\(toString\(event_hash\)\).*has_any_int64.*never use JavaScript numbers/i)

  const dataQuery = helpDocument(['data', 'query']) as Record<string, any>
  assert.ok(dataQuery.behavior.some((item: string) => /signed funnel hashes.*toString\(event_hash\).*exact decimal-string has_any_int64/i.test(item)))
  assert.match(String(dataQuery.output_schema.signed_int64_hashes), /groupUniqArray\(toString\(event_hash\)\).*exact base-10 decimal strings.*never JavaScript numbers/i)
})

// The help contract is verified in-process against the exported registries so
// every registered command is covered without spawning one subprocess each.
// End-to-end wiring is covered by the spot-check test below.
void test('every command group and action exposes progressive structured help', () => {
  const specs = [...commandSpecs.values()]
  assert.ok(specs.length > 80)
  const riskValues = ['offline', 'read_only', 'local_write', 'mutation', 'destructive', 'non_atomic']
  const childrenOf = (path: string[]): string[][] => specs
    .filter(spec => spec.path.length === path.length + 1 && path.every((part, index) => spec.path[index] === part))
    .map(spec => spec.path)

  const root = resolveHelp([])
  assert.ok(root !== undefined)
  const rootDocument = root.document as Record<string, any>
  assert.equal(rootDocument.notice.code, 'MISSING_COMMAND')
  assert.deepEqual(withoutNotice(rootDocument), helpDocument([]))
  const topLevel = (helpDocument([]) as Record<string, any>).commands as Array<{ path: string }>
  for (const path of childrenOf([])) {
    assert.ok(topLevel.some(command => command.path === `poki ${path.join(' ')}`), path.join(' '))
  }

  for (const spec of specs) {
    if (spec.path.length === 0) continue
    const name = spec.path.join(' ')
    const routed = resolveHelp(['help', ...spec.path])
    assert.ok(routed !== undefined, name)
    const document = routed.document as Record<string, any>
    assert.deepEqual(helpDocument(spec.path), document, name)
    if (spec.path[0] !== 'help') {
      assert.deepEqual(resolveHelp([...spec.path, '--help'])?.document, document, name)
    }
    assert.equal(document.command, `poki ${name}`)
    assert.match(String(document.usage), new RegExp(`^poki ${name}`))
    assert.equal(document.provenance, undefined, name)

    const children = childrenOf(spec.path)
    if (children.length > 0) {
      // Group index documents list every registered child and stay compact.
      for (const child of children) {
        assert.ok(document.commands.some((command: { path: string }) => command.path === `poki ${child.join(' ')}`), child.join(' '))
      }
      assert.equal(document.examples, undefined, name)
      const bare = resolveHelp(spec.path)
      assert.ok(bare !== undefined, name)
      const bareDocument = bare.document as Record<string, any>
      assert.equal(bareDocument.notice.code, 'MISSING_ACTION')
      assert.deepEqual(withoutNotice(bareDocument), document)
      continue
    }

    assert.ok(Array.isArray(document.examples) && document.examples.length > 0, name)
    assert.ok(document.examples.some((item: { command: string }) => !item.command.endsWith('--help')), `${name} needs a non-circular usage example`)
    // The first example must be a valid invocation: it carries every
    // unconditionally required option, and every option required unless --data
    // when the example does not itself use --data. This pins the generated
    // defaultExample contract (the reviews-request class of bug) without
    // running the commands.
    const firstExampleTokens = String(document.examples[0].command).split(' ')
    for (const option of spec.options ?? []) {
      if (option.required !== true && (option.required !== 'unless --data' || firstExampleTokens.includes('--data'))) continue
      assert.ok(firstExampleTokens.includes(option.name), `first example of '${name}' must include required ${option.name}`)
    }
    // Every leaf document points at the discovery surface.
    assert.deepEqual(document.help, {
      manifest: 'poki help --all',
      search: 'poki help --search TEXT',
      permissions: 'poki help permissions',
      formats: 'poki help formats',
      shapes: 'poki help shapes',
      workflows: 'poki help workflows'
    }, name)
    assert.equal(typeof document.network.contacts_api, 'boolean')
    assert.ok(riskValues.includes(document.risk), name)
    if (document.network.contacts_api === true && spec.permission_codes !== undefined) {
      assert.equal(typeof document.retry.safe_to_retry_after_failure, 'boolean')
      assert.equal(typeof document.retry.automatic_after_401_refresh, 'string')
      assert.equal(document.retry.automatic_otherwise, false)
      assert.ok(Array.isArray(document.permission_codes), name)
      assert.equal(document.permission_requirements.length, document.permission_codes.length, name)
      for (const requirement of document.permission_requirements) {
        assert.ok(document.permission_codes.includes(requirement.code), name)
        assert.ok(typeof requirement.description === 'string' && requirement.description.length > 0, name)
      }
    } else {
      // Offline commands, and API commands with no permission list at all
      // (auth login), carry no retry or permission boilerplate.
      assert.equal(document.retry, undefined)
      assert.equal(document.permission_codes, undefined)
    }
    assert.equal(document.exit_codes['2'], 'invalid input or local validation failure')
  }

  // Every group with a fields index also has the single-field variant.
  const fieldsGroups = specs.filter(spec => spec.path.length === 2 && spec.path[1] === 'fields').map(spec => spec.path[0])
  assert.ok(fieldsGroups.length >= 5)
  for (const group of fieldsGroups) {
    const fieldSpec = commandSpecs.get(`${group} field`)
    assert.ok(fieldSpec !== undefined, group)
    assert.equal(fieldSpec?.missing_input, 'a field name', group)
  }

  const versionListHelp = helpDocument(['versions', 'list']) as Record<string, any>
  assert.equal(versionListHelp.output_schema.timestamp_time_zone, 'UTC')
  assert.deepEqual(versionListHelp.output_schema.formats, ['toon', 'json', 'csv'])

  const manifestDocument = commandManifest() as Record<string, any>
  assert.equal(manifestDocument.meta.total, manifestDocument.commands.length)
  assert.ok(manifestDocument.meta.total > 80)
  assert.ok(manifestDocument.commands.every((command: Record<string, unknown>) => typeof command.usage === 'string'))
  assert.equal(manifestDocument.commands.some((command: { command: string }) => /marketing-assets|ab-tests|poki teams|team-members/.test(command.command)), false)
  assert.equal(manifestDocument.commands.some((command: { command: string }) => command.command === 'poki search' || command.command === 'poki capabilities'), false)

  const searched = searchCommandManifest('upload') as Record<string, any>
  assert.ok(searched.commands.some((command: { command: string }) => command.command === 'poki versions upload'))
})

void test('the compact manifest stays schema-free and the full manifest carries every input schema', () => {
  const compact = commandManifest() as Record<string, any>
  assert.equal(compact.meta.schema, 'compact')
  assert.equal(compact.meta.full_schema, 'poki help --all --full')
  for (const command of compact.commands) {
    assert.ok(!('input_schema' in command), `compact manifest entry '${String(command.command)}' must not carry input_schema`)
  }

  const full = commandManifest(true) as Record<string, any>
  assert.equal(full.meta.schema, 'full')
  assert.ok(!('full_schema' in full.meta), 'the full manifest must not point at itself')
  assert.equal(full.meta.total, full.commands.length)
  assert.equal(full.commands.length, compact.commands.length)
  // Reference topics (poki help formats/shapes/workflows) are not invocable
  // commands and carry no input schema; every real command carries one.
  const topicCommands = new Set(helpTopics.map(topic => `poki help ${topic.name}`))
  let schemas = 0
  for (const command of full.commands) {
    if (topicCommands.has(command.command)) {
      assert.ok(!('input_schema' in command), command.command)
      continue
    }
    assert.ok(Array.isArray(command.input_schema?.arguments), `full manifest entry '${String(command.command)}' needs input_schema.arguments`)
    assert.ok(Array.isArray(command.input_schema?.options), `full manifest entry '${String(command.command)}' needs input_schema.options`)
    schemas++
  }
  assert.equal(schemas, commandSpecs.size)

  assert.deepEqual(resolveHelp(['help', '--all', '--full'])?.document, commandManifest(true))
  assert.deepEqual(resolveHelp(['help', '--all'])?.document, commandManifest())
  assert.throws(() => resolveHelp(['help', '--full']), (error: unknown) => {
    assert.ok(error instanceof CliError)
    assert.equal(error.code, 'INVALID_INPUT')
    assert.equal(error.exitCode, 2)
    assert.match(error.message, /--full requires --all/)
    return true
  })
})

void test('search indexes resource fields and clips each vocabulary kind at its quota', () => {
  const fieldSearch = searchCommandManifest('peer_count') as Record<string, any>
  assert.ok(Array.isArray(fieldSearch.data_matches))
  assert.ok(fieldSearch.data_matches.some((match: { kind: string, command: string }) => match.kind === 'field' && match.command === 'poki netlib-lobbies field peer_count'),
    'searching a resource field name must surface its field discovery command')

  // The per-kind quota keeps ubiquitous column matches from crowding out the
  // metric and recipe vocabulary for a report question like "earnings".
  const earnings = searchCommandManifest('earnings') as Record<string, any>
  const earningsKinds = new Set(earnings.data_matches.map((match: { kind: string }) => match.kind))
  assert.ok(earningsKinds.has('metric'), 'earnings must match at least one metric')
  assert.ok(earningsKinds.has('recipe'), 'earnings must match at least one recipe')

  const broad = searchCommandManifest('date') as Record<string, any>
  assert.equal(broad.meta.data_matches_truncated, true)
  assert.equal(broad.meta.data_matches, broad.data_matches.length)
  const perKind = new Map<string, number>()
  for (const match of broad.data_matches as Array<{ kind: string }>) {
    perKind.set(match.kind, (perKind.get(match.kind) ?? 0) + 1)
  }
  assert.ok(perKind.size >= 2, 'a broad search must span multiple match kinds')
  for (const [kind, count] of perKind) {
    assert.ok(count <= 8, `kind '${kind}' exceeds the per-kind quota with ${count} entries`)
  }
})

void test('the public command contract stays developer-only and omits deferred endpoint families', () => {
  const manifest = JSON.stringify(commandManifest(true))
  assert.doesNotMatch(manifest, /can_[a-z0-9_]*_all(?:_|\b)/i)
  assert.doesNotMatch(manifest, /\badmin(?:istrator|istrative|-only)?\b/i)
  // Paths alone do not prove absence: a --raw description once documented a
  // marketing-asset field alias that does not exist on any shipped command.
  assert.doesNotMatch(manifest, /asset_type|marketing|web-?fit|game-?similarit/i)

  const documentedPermissions = [...new Set([...commandSpecs.values()]
    .flatMap(spec => spec.permission_codes ?? []))].sort()
  assert.deepEqual(documentedPermissions, [...developerPermissionCodes].sort())

  const paths = [...commandSpecs.keys()].join('\n')
  assert.doesNotMatch(paths, /marketing-assets/i)
  assert.doesNotMatch(paths, /(?:^|\s)(?:thumbnail-)?ab-tests?(?:\s|$)/i)
  assert.doesNotMatch(paths, /web-?fit/i)
  assert.doesNotMatch(paths, /game-?similarit/i)
  assert.ok(commandSpecs.has('netlib-lobbies list'))
})

// Help is the only place an agent can learn a combination is refused, so the
// declared conflict is checked against the refusal itself in both directions.
void test('every csv-capable view command documents that --raw excludes --format csv', async () => {
  const csvViews = [...commandSpecs.values()].filter(spec => {
    const format = spec.options?.find(option => option.name === '--format')
    return spec.options?.some(option => option.name === '--raw') === true && (format?.values ?? []).includes('csv')
  })
  assert.ok(csvViews.length >= 12, `only ${String(csvViews.length)} csv-capable view commands were checked`)
  for (const spec of csvViews) {
    const raw = spec.options?.find(option => option.name === '--raw')
    assert.ok(raw?.conflicts?.includes('--format csv') === true, `poki ${spec.path.join(' ')} --raw must document the --format csv conflict`)
  }

  for (const args of [['games', 'list'], ['playtest-requests', 'list', '--game', 'game-1']]) {
    const rejected = await runCli([...args, '--raw', '--format', 'csv'])
    assert.equal(rejected.code, 2, rejected.stderr)
    assert.match(parseToon(rejected.stderr).error.message, /--format csv cannot be combined with --raw/, args.join(' '))
  }

  // The conflict is the csv value only: json and toon reach authentication.
  const accepted = await runCli(['games', 'list', '--raw', '--format', 'json'])
  assert.equal(accepted.code, 3, accepted.stderr)
  assert.equal(JSON.parse(accepted.stderr).error.code, 'AUTH_REQUIRED')
})

void test('the published exit-code table documents signal interruption', () => {
  const document = helpDocument(['games', 'list']) as Record<string, any>
  assert.match(String(document.exit_codes['130']), /SIGINT.*SIGTERM/)
  assert.match(String(document.exit_codes['130']), /INTERRUPTED/)
  const shapes = resolveHelp(['help', 'shapes'])?.document as Record<string, any>
  assert.deepEqual(shapes.channels.exit_codes, document.exit_codes)
  // An exit code without a matching error code leaves an agent unable to
  // recognize the failure it is looking at, so the code list carries it too.
  const interrupted = (shapes.error_envelope.codes as string[]).filter(code => code.startsWith('INTERRUPTED'))
  assert.equal(interrupted.length, 1)
  assert.match(interrupted[0], /exit 130, not retryable/)
  assert.match(interrupted[0], /Read current resource state before retrying/)
})

// The renderer rejects a CSV export whenever meta reports either incompleteness
// signal, so help has to name both: an agent told only about explicit bounds
// would treat a rejected ordinary page as a CLI bug.
void test('the documented CSV rule names both incompleteness signals', () => {
  const shapes = resolveHelp(['help', 'shapes'])?.document as Record<string, any>
  const csv = String(shapes.analytics_results.csv)
  assert.match(csv, /truncated/)
  assert.match(csv, /has_next/)
  assert.match(csv, /empty collection exports the header its view declares/)
})

void test('the permission catalog drives the glossary, inline command help, and permission search', () => {
  assert.equal(new Set(developerPermissionCodes).size, developerPermissionCodes.length)
  assert.equal(developerPermissionCatalog.length, developerPermissionCodes.length)
  for (const permission of developerPermissionCatalog) {
    assert.ok(permission.description.trim().length > 0, permission.code)
  }

  const glossary = resolveHelp(['help', 'permissions'])?.document as Record<string, any>
  assert.equal(glossary.topic, 'permissions')
  assert.equal(glossary.permissions.length, developerPermissionCatalog.length)
  assert.deepEqual(glossary.permissions.map((permission: { code: string }) => permission.code), developerPermissionCodes)
  for (const permission of glossary.permissions) {
    assert.ok(typeof permission.description === 'string' && permission.description.length > 0, permission.code)
    assert.ok(Array.isArray(permission.commands) && permission.commands.length > 0, permission.code)
  }

  const activate = helpDocument(['versions', 'activate']) as Record<string, any>
  assert.deepEqual(activate.permission_requirements.map((permission: { code: string }) => permission.code), activate.permission_codes)
  assert.ok(activate.permission_requirements.every((permission: { description: string }) => permission.description.length > 0))

  const searched = searchCommandManifest('traffic-track allocation') as Record<string, any>
  assert.ok(searched.commands.some((command: { command: string }) => command.command === 'poki versions activate'))
})

// Every registered spec with a missing_input contract is exercised in-process;
// the end-to-end exit code and stderr envelope are covered by the spot check.
void test('bare incomplete actions raise MISSING_INPUT with the structured help embedded', () => {
  const specs = [...commandSpecs.values()]
  const hasChildren = (path: string[]): boolean => specs
    .some(spec => spec.path.length === path.length + 1 && path.every((part, index) => spec.path[index] === part))

  const incomplete = specs.filter(spec => spec.missing_input !== undefined)
  assert.ok(incomplete.length >= 20)
  for (const spec of incomplete) {
    const name = spec.path.join(' ')
    assert.throws(() => resolveHelp(spec.path), (error: unknown) => {
      assert.ok(error instanceof CliError, name)
      assert.equal(error.code, 'MISSING_INPUT', name)
      assert.equal(error.exitCode, 2, name)
      assert.equal(error.message, `Missing ${spec.missing_input ?? ''} for poki ${name}.`)
      assert.equal(typeof error.hint, 'string', name)
      assert.deepEqual((error.details as { help: unknown }).help, helpDocument(spec.path), name)
      return true
    }, name)
  }

  // Complete actions pass through to their handlers instead of raising help.
  for (const spec of specs) {
    if (spec.path.length === 0 || spec.path[0] === 'help') continue
    if (spec.missing_input !== undefined || hasChildren(spec.path)) continue
    assert.equal(resolveHelp(spec.path), undefined, spec.path.join(' '))
  }
})

void test('help forms and missing-input errors agree end-to-end (spot check)', async () => {
  const bare = await runCli(['games'])
  const explicit = await runCli(['games', '--help'])
  const routed = await runCli(['help', 'games'])
  assert.equal(bare.code, 0, bare.stderr)
  assert.equal(bare.stderr, '')
  assert.equal(explicit.code, 0, explicit.stderr)
  assert.equal(explicit.stderr, '')
  assert.equal(routed.code, 0, routed.stderr)
  assert.equal(routed.stderr, '')
  assert.equal(explicit.stdout, routed.stdout)
  const bareDocument = parseToon(bare.stdout)
  assert.equal(bareDocument.notice.code, 'MISSING_ACTION')
  assert.deepEqual(withoutNotice(bareDocument), parseToon(explicit.stdout))

  const json = await runCli(['games', 'create', '--help', '--format', 'json'])
  assert.equal(json.code, 0, json.stderr)
  assert.deepEqual(JSON.parse(json.stdout), helpDocument(['games', 'create']))

  const incomplete = await runCli(['games', 'create', '--format', 'json'])
  assert.equal(incomplete.code, 2, incomplete.stdout)
  assert.equal(incomplete.stdout, '')
  const error = JSON.parse(incomplete.stderr).error
  assert.equal(error.code, 'MISSING_INPUT')
  assert.match(error.message, /game fields or --data/)
  assert.equal(typeof error.hint, 'string')
  assert.deepEqual(error.details.help, helpDocument(['games', 'create']))
})

void test('invalid inputs fail before HTTP with structured exit code 2 errors', async t => {
  const rawAll = await runCli(['games', 'list', '--raw', '--all', '--format', 'json'])
  assert.equal(rawAll.code, 2)
  assert.equal(rawAll.stdout, '')
  assert.deepEqual(JSON.parse(rawAll.stderr), {
    error: {
      code: 'INVALID_INPUT',
      message: '--raw cannot be combined with --all.',
      retryable: false
    }
  })

  const mixedMutation = await runCli([
    'games', 'create', '--title', 'Example', '--team', 'team-1',
    '--data', '{"title":"Other","team_id":"team-1"}'
  ])
  assert.equal(mixedMutation.code, 2)
  assert.match(parseToon(mixedMutation.stderr).error.message, /--data cannot be combined/)

  const removedCompactOption = await runCli(['games', 'list', '--compact'])
  assert.equal(removedCompactOption.code, 2)
  assert.match(parseToon(removedCompactOption.stderr).error.message, /--compact/)

  const fractionalPage = await runCli(['games', 'list', '--page', '1.5'])
  assert.equal(fractionalPage.code, 2)
  assert.match(parseToon(fractionalPage.stderr).error.message, /positive integer/)

  const removedGlobalScope = await runCli(['playtest-recordings', 'list', '--game', 'game-1', '--global'])
  assert.equal(removedGlobalScope.code, 2)
  assert.match(parseToon(removedGlobalScope.stderr).error.message, /Unknown argument: --global/)

  const removedSqlPreview = await runCli(['data', 'query', '--query', '{from: dbt_p4d_gameplays}', '--preview-sql'])
  assert.equal(removedSqlPreview.code, 2)
  assert.match(parseToon(removedSqlPreview.stderr).error.message, /Unknown argument: --preview-sql/)

  const ignoredCreateState = await runCli([
    'game-events', 'create', '--game', 'game-1', '--category', 'progress', '--action', 'level',
    '--description', 'Progress event', '--no-enabled', '--dry-run'
  ])
  assert.equal(ignoredCreateState.code, 2)
  assert.match(parseToon(ignoredCreateState.stderr).error.message, /Unknown argument: --no-enabled/)

  const noProject = temporaryDirectory(t, 'no-project')
  const missingGame = await runCli(['player-fit-tests', 'get', 'fit-1'], { cwd: noProject })
  assert.equal(missingGame.code, 2)
  assert.match(parseToon(missingGame.stderr).error.message, /game/)

  const malformedProject = temporaryDirectory(t, 'malformed-project')
  writeFileSync(join(malformedProject, 'poki.json'), '{"game_id":')
  const malformedContext = await runCli(['context', '--format', 'json'], { cwd: malformedProject })
  assert.equal(malformedContext.code, 2)
  assert.equal(JSON.parse(malformedContext.stderr).error.code, 'INVALID_INPUT')
  assert.match(JSON.parse(malformedContext.stderr).error.message, /Could not parse/)

  // A malformed project file must not break commands that never read it.
  const malformedVersion = await runCli(['--version'], { cwd: malformedProject })
  assert.equal(malformedVersion.code, 0, malformedVersion.stderr)
  const malformedHelp = await runCli(['games', 'update', '--help'], { cwd: malformedProject })
  assert.equal(malformedHelp.code, 0, malformedHelp.stderr)
  // But commands that need the project game must surface the parse error, not
  // a generic missing-argument message.
  const malformedScoped = await runCli(['versions', 'list'], { cwd: malformedProject })
  assert.equal(malformedScoped.code, 2)
  assert.match(parseToon(malformedScoped.stderr).error.message, /Could not parse/)

  const unscopedGame = await runCli(['versions', 'list', '--format', 'json'], { cwd: noProject })
  assert.equal(unscopedGame.code, 2)
  const unscopedError = JSON.parse(unscopedGame.stderr).error
  assert.equal(unscopedError.code, 'INVALID_INPUT')
  assert.match(unscopedError.hint, /poki init --game/)

  const tooManyRecordings = await runCli(['playtest-requests', 'create', '--game', 'game-1', '--version', 'version-1', '--recordings', '11'])
  assert.equal(tooManyRecordings.code, 2)
  assert.match(parseToon(tooManyRecordings.stderr).error.message, /1 through 10/)

  const tooManyCategories = await runCli([
    'player-fit-tests', 'create', '--game', 'game-1', '--version', 'version-1',
    '--category', '1', '--category', '2', '--category', '3', '--category', '4', '--category', '5', '--category', '6'
  ])
  assert.equal(tooManyCategories.code, 2)
  assert.match(parseToon(tooManyCategories.stderr).error.message, /at most five/)
})

// Help is the discovery surface, so every invocation of it must emit a
// document or a structured error; an empty successful response is the one
// failure an agent cannot detect. Individual tests pin the content of each
// shape, but the routing matrix itself - option order, unknown paths, an
// unknown option, and the legacy --version short-circuit - is a single closed
// contract and is checked as one.
void test('every help and version routing shape emits a document or a structured error', async () => {
  const invocations = [
    [],
    ['--help'],
    ['help'],
    ['help', 'not-a-command'],
    ['help', 'games', 'create'],
    ['games', 'create', '--help'],
    ['--help', 'games', 'create'],
    ['help', '--format', 'json'],
    ['--format', 'json', '--help'],
    ['help', '--format', 'bogus'],
    ['not-a-command'],
    ['games', 'list', '--not-an-option'],
    ['--version'],
    ['upload', '--version'],
    ['--version', 'upload']
  ]
  for (const args of invocations) {
    const result = await runCli(args)
    const label = `poki ${args.join(' ')}`
    if (result.code === 0) {
      assert.notEqual(result.stdout.trim(), '', `${label} exited 0 without emitting anything`)
    } else {
      assert.notEqual(result.stderr.trim(), '', `${label} failed without a structured error`)
      assert.match(result.stderr, /(^|\n)error:|"error":/, label)
    }
  }
})

void test('a leading --format still routes the help command instead of exiting empty', async () => {
  // resolveHelp must match `help` after removing the encoding option: falling
  // through to yargs would print nothing and exit successfully, the one
  // failure an agent cannot detect.
  const routed = await runCli(['help'])
  const leadingToon = await runCli(['--format', 'toon', 'help'])
  assert.equal(leadingToon.code, 0, leadingToon.stderr)
  assert.equal(leadingToon.stdout, routed.stdout)

  const trailingJson = await runCli(['help', 'games', '--format', 'json'])
  for (const args of [['--format', 'json', 'help', 'games'], ['--format=json', 'help', 'games']]) {
    const leading = await runCli(args)
    assert.equal(leading.code, 0, leading.stderr)
    assert.notEqual(leading.stdout, '')
    assert.equal(leading.stdout, trailingJson.stdout)
  }

  // Help options keep working around the relocated encoding option.
  const search = await runCli(['--format', 'json', 'help', '--search', 'activate'])
  assert.equal(search.code, 0, search.stderr)
  assert.deepEqual(JSON.parse(search.stdout), JSON.parse((await runCli(['help', '--search', 'activate', '--format', 'json'])).stdout))

  const unknownPath = await runCli(['--format', 'json', 'help', 'not-a-command'])
  assert.equal(unknownPath.code, 2)
  assert.equal(JSON.parse(unknownPath.stderr).error.code, 'INVALID_INPUT')
})
