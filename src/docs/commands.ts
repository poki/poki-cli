import { resourceDocumentations } from './resources'
import { ANALYTICS_TIME_ZONE, RESOURCE_API_TIME_ZONE } from '../timezones'
import { tableCatalog } from '../data/catalog'
import { dataRecipes } from '../data/examples'
import { dataMetrics } from '../data/metrics'
import type { ListCapabilities } from '../list-capabilities'
import { audienceCatalog } from '../audiences'
import {
  DEFAULT_DOWNLOAD_TIMEOUT_MS,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_UPLOAD_TIMEOUT_MS,
  DEFAULT_WAIT_TIMEOUT_MS,
  TIMEOUT_MILLISECONDS_RANGE
} from '../timeouts'
import {
  developerPermissionCatalog,
  DeveloperPermissionCode,
  developerPermissionRequirements
} from '../developer-permissions'
import { addAudienceCommandSpecs } from './command-groups/audiences'
import { addAuthCommandSpecs } from './command-groups/auth'
import { addDataCommandSpecs } from './command-groups/data'
import { addGameChangeRequestCommandSpecs } from './command-groups/game-change-requests'
import { addGameEventFunnelCommandSpecs } from './command-groups/game-event-funnels'
import { addGameEventCommandSpecs } from './command-groups/game-events'
import { addGameCommandSpecs } from './command-groups/games'
import { addNetlibLobbyCommandSpecs } from './command-groups/netlib-lobbies'
import { addPlayerFeedbackQuestionCommandSpecs } from './command-groups/player-feedback-questions'
import { addPlayerFitTestCommandSpecs } from './command-groups/player-fit-tests'
import { addPlaytestRecordingCommandSpecs } from './command-groups/playtest-recordings'
import { addPlaytestRequestCommandSpecs } from './command-groups/playtest-requests'
import { addReviewCommandSpecs } from './command-groups/reviews'
import { addVersionActivationCommandSpecs } from './command-groups/version-activations'
import { addVersionCommandSpecs } from './command-groups/versions'
import type { CommandSpecBuilder } from './command-groups/types'

export interface HelpNotice {
  code: 'MISSING_COMMAND' | 'MISSING_ACTION'
  message: string
}

export interface HelpArgument {
  name: string
  type: string
  required: boolean
  description: string
  values?: string[]
}

export interface HelpOption {
  name: string
  type: string
  description: string
  required?: boolean | string
  default?: string | number | boolean
  repeatable?: boolean
  values?: string[]
  conflicts?: string[]
}

export interface HelpExample {
  command: string
  purpose: string
}

export interface NetworkContract {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'MULTIPLE' | 'none'
  path: string | string[]
  contacts_api: boolean
}

export type CommandRisk = 'offline' | 'read_only' | 'local_write' | 'mutation' | 'destructive' | 'non_atomic'

export interface CommandSpec {
  path: string[]
  summary: string
  behavior?: string[]
  quickstart?: HelpExample[]
  permission_codes?: DeveloperPermissionCode[]
  permission_logic?: string
  side_effects?: string[]
  arguments?: HelpArgument[]
  options?: HelpOption[]
  examples?: HelpExample[]
  discovery?: HelpExample[]
  references?: Array<{ title: string, url: string }>
  output?: Record<string, unknown>
  missing_input?: string
  network?: NetworkContract
  scope?: string
  risk?: CommandRisk
  destructive?: boolean
  non_atomic?: boolean
  retry_safe?: boolean
  deprecated?: boolean
  aliases?: string[]
  provenance?: Record<string, unknown>
}

const option = (name: string, type: string, description: string, extra: Omit<HelpOption, 'name' | 'type' | 'description'> = {}): HelpOption => ({ name, type, description, ...extra })
const argument = (name: string, description: string, required = true, values?: string[]): HelpArgument => ({ name, type: 'string', required, description, ...(values === undefined ? {} : { values }) })
const example = (command: string, purpose: string): HelpExample => ({ command, purpose })

// The shared option specs below are exported because the yargs declarations in
// src/commands/command-options.ts are generated from them: these records are
// the only documentation a user ever reads, so the declaration must not be a
// second hand-maintained copy of the same name, description, choices and
// default.
export const formatOption = option('--format', 'enum', 'Structured output encoding.', { default: 'toon', values: ['toon', 'json'] })
export const rawOption = option('--raw', 'boolean', 'Keep a valid backend response shape instead of normalizing it; documented command-specific enrichments may apply and successful mutation shapes are still validated.', { default: false })
const timeoutOption = option('--timeout-ms', TIMEOUT_MILLISECONDS_RANGE, `Maximum time for each API request; accepts an ${TIMEOUT_MILLISECONDS_RANGE}; defaults to POKI_API_TIMEOUT_MS or ${String(DEFAULT_REQUEST_TIMEOUT_MS)}.`)
const uploadTimeoutOption = option('--timeout-ms', TIMEOUT_MILLISECONDS_RANGE, `Maximum time for each API request; accepts an ${TIMEOUT_MILLISECONDS_RANGE}; defaults to POKI_API_TIMEOUT_MS or ${String(DEFAULT_UPLOAD_TIMEOUT_MS)} for this multipart upload command.`)
const downloadTimeoutOption = option('--timeout-ms', TIMEOUT_MILLISECONDS_RANGE, `Maximum time for each API request; accepts an ${TIMEOUT_MILLISECONDS_RANGE}; defaults to POKI_API_TIMEOUT_MS or ${String(DEFAULT_DOWNLOAD_TIMEOUT_MS)} for this streamed download command.`)
const gameOption = option('--game', 'string', 'Override project game_id.', { required: 'when no project game is configured' })
const dataOption = option('--data', 'string', 'JSON or TOON object inline, from @file, or stdin with -; mutually exclusive with field flags. JSON input is always accepted; see poki help formats.')
export const dryRunOption = option('--dry-run', 'boolean', 'Validate input locally and print the resolved HTTP operation without sending it. Backend acceptance, mutation permissions, and resource state remain unvalidated unless the command says otherwise.', { default: false })
const yesOption = option('--yes', 'boolean', 'Required for destructive or non-atomic operations; otherwise accepted but not required.', { default: false })
export const fullOption = option('--full', 'boolean', 'Return all bundled developer-visible fields present in the normalized response.', { default: false, conflicts: ['--fields', '--raw'] })
export const fieldsOption = option('--fields', 'comma-separated fields', 'Select documented developer-visible top-level fields; unknown fields fail locally.', { conflicts: ['--full', '--raw'] })
// The csv conflict names the offending value, not the whole option: --raw
// combines with toon and json and is rejected only for the tabular export.
const viewRawOption: HelpOption = {
  ...rawOption,
  description: `${rawOption.description} Raw list output disables normalized list views.`,
  conflicts: ['--full', '--fields', '--format csv']
}
const listRawOption: HelpOption = { ...viewRawOption, conflicts: [...(viewRawOption.conflicts ?? []), '--all'] }
export const listFormatOption = option('--format', 'enum', 'Structured output encoding; csv exports the viewed resource list as a table.', { default: 'toon', values: ['toon', 'json', 'csv'] })
const waitOptions = (subject: string): HelpOption[] => [
  option('--wait', 'boolean', `${subject} A successful terminal state returns meta.wait; a terminal failure exits 5 with ASYNC_OPERATION_FAILED and the final resource.`, { default: false, conflicts: ['--raw'] }),
  option('--poll-interval-ms', TIMEOUT_MILLISECONDS_RANGE, `Delay between --wait polls; accepts an ${TIMEOUT_MILLISECONDS_RANGE}.`, { default: DEFAULT_POLL_INTERVAL_MS }),
  option('--wait-timeout-ms', TIMEOUT_MILLISECONDS_RANGE, `Maximum total --wait time before a retryable WAIT_TIMEOUT error; accepts an ${TIMEOUT_MILLISECONDS_RANGE}.`, { default: DEFAULT_WAIT_TIMEOUT_MS })
]
const listViewOptions: HelpOption[] = [fullOption, fieldsOption, listFormatOption, viewRawOption, timeoutOption]
export const filterOption = option('--filter', 'field=value', 'JSON:API filter; repeatable. Use attribute names from the group fields index. Observed server operators include field=null and field=not:null for nullable timestamps.', { repeatable: true })
export const sortOption = option('--sort', 'string', 'Sort field; prefix with - for descending (for example --sort -created_at); repeatable.', { repeatable: true })
// Declaration order is public: it is the order help lists the bounds in and the
// order withListOptions registers them in.
export const paginationOptions: HelpOption[] = [
  option('--page', 'positive integer', 'One-based page; cannot be combined with --all.', { default: 1, conflicts: ['--all'] }),
  option('--page-size', 'positive integer', 'Resources per page.', { default: 30 }),
  option('--all', 'boolean', 'Fetch pages from page 1 until exhausted. An internal safety ceiling fails closed unless an explicit truncation bound is supplied.', { default: false }),
  option('--max-pages', 'positive integer', 'Accept successful --all truncation after this many pages.'),
  option('--max-items', 'positive integer', 'Accept successful --all truncation after this many resources.')
]
function listOptionsFor (capabilities: ListCapabilities): HelpOption[] {
  return [
    ...(capabilities.filter ? [filterOption] : []),
    ...(capabilities.sort ? [sortOption] : []),
    ...(capabilities.pagination ? paginationOptions : []),
    ...listViewOptions.map(value => capabilities.pagination && value === viewRawOption ? listRawOption : value)
  ]
}
const outputOptions = [formatOption, rawOption, timeoutOption]
const mutationOptions = [...outputOptions, dryRunOption, yesOption]
const uploadMutationOptions = [formatOption, rawOption, uploadTimeoutOption, dryRunOption, yesOption]
const requestOptions = [formatOption, timeoutOption]
const downloadRequestOptions = [formatOption, downloadTimeoutOption]
const requestMutationOptions = [...requestOptions, dryRunOption, yesOption]

const jsonApiOutput = {
  default_format: 'toon',
  formats: ['toon', 'json'],
  timestamp_time_zone: RESOURCE_API_TIME_ZONE,
  shape: { data: 'resource, resources, or mutation result', meta: 'pagination, view, or operation metadata' }
}

const standardExitCodes = {
  0: 'success or help',
  2: 'invalid input or local validation failure',
  3: 'authentication required or rejected; recovery needs a human to run poki auth login in a browser-capable terminal',
  4: 'authenticated API request denied by permission or another client-visible rule, or resource not found',
  5: 'network, timeout, server, or invalid API response failure',
  // 128 + SIGINT, the POSIX convention for a signal-terminated process.
  130: 'interrupted by SIGINT or SIGTERM before completion; reported as INTERRUPTED'
}

const bundledProvenance = {
  cli_contract: 'poki help COMMAND or poki help --all',
  documentation: 'bundled',
  external_sources_required: false,
  api_authoritative: true
}

const specs: CommandSpec[] = []

const CATEGORY_NAME_DISCOVERY = 'Discover category names with poki audiences list; numeric IDs are only for Playtest and Player Fit targeting.'
const TESTING_AUDIENCE_DISCOVERY = 'Discover targetable bundled IDs with poki audiences list --testing-only.'
// Shared by the commands that emulate a singular GET over a filtered
// collection request.
const COLLECTION_GET_BEHAVIOR = 'The CLI verifies that the filtered response contains the requested ID. For paginated collections it follows an authoritative same-origin next link even after an empty filtered page, or scans remaining bounded pages if the server ignored the filter; non-paginated collections already return the complete matching set.'

// The root spec has an empty path, so every surface that prints a command has
// to suppress the trailing space. One definition keeps `poki help COMMAND`,
// the manifest, and search from disagreeing about how a command is named.
function commandLabel (path: readonly string[]): string {
  return path.length === 0 ? 'poki' : `poki ${path.join(' ')}`
}

function inputSchema (spec: CommandSpec): { arguments: HelpArgument[], options: HelpOption[] } {
  return { arguments: spec.arguments ?? [], options: spec.options ?? [] }
}

function defaultExample (spec: CommandSpec, risk: CommandRisk): HelpExample {
  const command = commandLabel(spec.path)
  if (spec.path.length <= 1) return example(`${command} --help`, 'Inspect available actions and their contracts.')

  const invocation = [command]
  for (const value of spec.arguments ?? []) {
    if (value.required) invocation.push(value.name.toUpperCase().replace(/-/g, '_'))
  }
  // Options required unconditionally or "unless --data" belong in a generated
  // example — without them the example is an invocation that fails. A
  // conditional requirement like "when no project game is configured" would
  // wrongly inject flags like --game GAME_ID into every example.
  for (const value of spec.options ?? []) {
    if (value.required !== true && value.required !== 'unless --data') continue
    invocation.push(value.name)
    if (value.type !== 'boolean') {
      const name = value.name.slice(2).toUpperCase().replace(/-/g, '_')
      invocation.push(['GAME', 'TEAM', 'VERSION'].includes(name) ? `${name}_ID` : name)
    }
  }
  if (['mutation', 'destructive', 'non_atomic'].includes(risk) && spec.options?.some(value => value.name === '--dry-run') === true) {
    invocation.push('--dry-run')
  }
  const purpose = invocation.includes('--dry-run')
    ? 'Validate required input and inspect the resolved operation without sending it.'
    : risk === 'offline'
      ? 'Read bundled offline documentation or local state.'
      : risk === 'read_only'
        ? 'Read the requested resources without changing them.'
        : 'Run this command with its required inputs.'
  return example(invocation.join(' '), purpose)
}

function add (spec: CommandSpec): void {
  const risk = spec.risk ?? (spec.network?.contacts_api === false ? 'offline' : spec.network?.method === 'GET' ? 'read_only' : 'mutation')
  specs.push({
    risk,
    retry_safe: spec.network?.method === 'GET' || spec.network?.contacts_api === false,
    // Group indexes list their actions; a generated example would only point
    // back at the group itself.
    examples: spec.examples ?? (spec.path.length === 1 ? undefined : [defaultExample(spec, risk)]),
    provenance: { ...bundledProvenance, ...(spec.provenance ?? {}) },
    ...spec
  })
}

function group (path: string, summary: string, behavior?: string[]): void {
  add({ path: [path], summary, behavior, network: { method: 'none', path: 'offline command index', contacts_api: false }, risk: 'offline' })
}

function apiAction (
  path: string[],
  summary: string,
  network: NetworkContract,
  permissions: DeveloperPermissionCode[],
  extra: Partial<CommandSpec> = {}
): void {
  const waitAwareExtra = extra.options?.some(value => value.name === '--wait') === true
    ? {
        ...extra,
        behavior: [
          ...(extra.behavior ?? []).filter(value => !value.includes('--wait')),
          '--wait returns a success document only for the documented success state; a terminal failure raises ASYNC_OPERATION_FAILED with the final resource.'
        ]
      }
    : extra
  const documentedFormats = waitAwareExtra.options?.find(value => value.name === '--format')?.values
  add({
    path,
    summary,
    network,
    permission_codes: permissions,
    scope: waitAwareExtra.scope ?? (path[0] === 'whoami' ? 'authenticated account' : 'project game_id or --game'),
    output: documentedFormats === undefined
      ? jsonApiOutput
      : { ...jsonApiOutput, formats: documentedFormats },
    ...waitAwareExtra
  })
}

const commandSpecBuilder: CommandSpecBuilder = {
  add,
  apiAction,
  argument,
  categoryNameDiscovery: CATEGORY_NAME_DISCOVERY,
  collectionGetBehavior: COLLECTION_GET_BEHAVIOR,
  dataOption,
  downloadRequestOptions,
  dryRunOption,
  example,
  formatOption,
  gameOption,
  group,
  listOptionsFor,
  listViewOptions,
  mutationOptions,
  option,
  outputOptions,
  requestMutationOptions,
  requestOptions,
  testingAudienceDiscovery: TESTING_AUDIENCE_DISCOVERY,
  timeoutOption,
  uploadMutationOptions,
  waitOptions,
  yesOption
}

add({
  path: [],
  summary: 'Manage Poki for Developers resources and analytics with contracts designed for automation and LLMs.',
  behavior: [
    'Use poki help --all for the compact manifest and poki help --search TEXT for discovery. Reference topics: poki help permissions, formats, shapes, workflows, and updates.',
    'Game-scoped commands use project game_id or --game.',
    'TOON is the default structured format; use --format json for minified JSON. Run poki help formats for the TOON primer; JSON input is always accepted.',
    'API resource mutations support --dry-run, which proves local input validation only unless a command explicitly reports additional checks. Destructive and non-atomic operations require --yes. Analytics --validate-only likewise checks local structure without claiming deployed-API validity.',
    'risk values: offline (no network), read_only (reads remote state), local_write (writes only local files), mutation, destructive, non_atomic.',
    'List --all operations fail if an internal safety ceiling prevents proving completeness. Explicit --max-pages or --max-items opts into a successful bounded result with truncation metadata.',
    'Only init, auth, and deprecated upload are cross-release compatible. Pin an exact version otherwise.',
    'Structured errors set retryable and retry_after. Transient read failures are retryable; mutation failures are not unless the command explicitly documents the request as retry-safe.',
    `Analytics dates use ${ANALYTICS_TIME_ZONE}; non-data API endpoints use ${RESOURCE_API_TIME_ZONE}; player-feedback-questions date flags are UTC calendar dates.`,
    `Environment: POKI_API_TIMEOUT_MS accepts an ${TIMEOUT_MILLISECONDS_RANGE} and sets the default API plus auth exchange/refresh request timeout (it also raises or lowers the ${String(DEFAULT_UPLOAD_TIMEOUT_MS)} ms upload default); POKI_UPLOAD_TOKEN authenticates only the legacy poki upload command.`,
    'Credentials use auth.json below an absolute XDG_CONFIG_HOME or LOCALAPPDATA, falling back to ~/.config/poki.'
  ],
  quickstart: [
    example('poki auth login', 'One-time browser sign-in; requires a human to complete it.'),
    example('poki init --game GAME_ID --build-dir dist', 'Configure this project directory.'),
    example('poki whoami', 'Confirm identity, team ID, and granted permissions.'),
    example('poki versions upload --label "First build" --dry-run', 'Preview the first build upload.')
  ],
  discovery: [
    example('poki help --all', 'Return every command path and compact contract.'),
    example('poki help --search upload', 'Search command summaries, options, and analytics vocabulary.'),
    example('poki help updates', 'Inspect the daily update advisory contract.'),
    example('poki context', 'Resolve local configuration without network access.'),
    example('poki whoami', 'Inspect current identity, team ID, and granted permission identifiers.'),
    example('poki games list', 'Discover the game IDs visible to the account.')
  ],
  examples: [example('poki help --search upload', 'Find relevant commands, then inspect a detailed action contract.')],
  network: { method: 'none', path: 'offline command index', contacts_api: false },
  risk: 'offline',
  output: { default_format: 'toon', json_override: '--format json' }
})

add({
  path: ['help'],
  summary: 'Return structured command help, a compact full manifest, or text search results.',
  arguments: [{ name: 'command', type: 'string[]', required: false, description: 'Nested command path.' }],
  options: [option('--all', 'boolean', 'Return a compact manifest for every command.'), option('--full', 'boolean', 'With --all, include each command\'s complete input schema.'), option('--search', 'string', 'Search paths, summaries, permissions, option descriptions, resource field names, and the analytics vocabulary.'), formatOption],
  examples: [example('poki help versions activate', 'Inspect one detailed contract.'), example('poki help --all', 'List every command contract compactly.'), example('poki help --all --full --format json', 'Learn every command including arguments and options in one call.'), example('poki help --search destructive', 'Find risky commands.')],
  network: { method: 'none', path: 'local contract registry', contacts_api: false },
  risk: 'offline'
})
add({ path: ['version'], summary: 'Print the installed CLI version.', aliases: ['--version', '-v'], examples: [example('poki --version', 'Print only the installed version.')], network: { method: 'none', path: 'package metadata', contacts_api: false }, risk: 'offline', output: { shape: 'plain version string' } })
add({ path: ['context'], summary: 'Describe effective project configuration, API URL, timeout, CLI version, and offline auth status.', options: [formatOption], behavior: ['Reports the exact configuration source and absolute path. A malformed poki.json is an error and never falls back silently.'], examples: [example('poki context --format json', 'Resolve the project and authentication context without network access.')], network: { method: 'none', path: 'poki.json, package.json, and auth file', contacts_api: false }, risk: 'offline' })
apiAction(['whoami'], 'Return the current user, team relationship, and CLI-relevant developer permission identifiers.', { method: 'GET', path: '/users/@me', contacts_api: true }, ['can_read_self'], { options: outputOptions, behavior: ['The response meta.permissions array is restricted to permissions used by this developer CLI; unrelated role-wide permissions are omitted.'], side_effects: ['Updates last_seen for a non-impersonated user.'], examples: [example('poki whoami --format json', 'Read the identity and developer permissions used by CLI requests.')] })

addAuthCommandSpecs(commandSpecBuilder)
addAudienceCommandSpecs(commandSpecBuilder)

addGameCommandSpecs(commandSpecBuilder)

addVersionCommandSpecs(commandSpecBuilder)
addVersionActivationCommandSpecs(commandSpecBuilder)

addPlaytestRecordingCommandSpecs(commandSpecBuilder)

addPlaytestRequestCommandSpecs(commandSpecBuilder)
addPlayerFitTestCommandSpecs(commandSpecBuilder)
addReviewCommandSpecs(commandSpecBuilder)
addGameChangeRequestCommandSpecs(commandSpecBuilder)

addGameEventCommandSpecs(commandSpecBuilder)
addGameEventFunnelCommandSpecs(commandSpecBuilder)
addPlayerFeedbackQuestionCommandSpecs(commandSpecBuilder)
addNetlibLobbyCommandSpecs(commandSpecBuilder)

addDataCommandSpecs(commandSpecBuilder)

add({ path: ['init'], summary: 'Create poki.json; refuse replacement unless --force.', options: [option('--game', 'string', 'Required project game ID.', { required: true }), option('--build-dir', 'path', 'Build directory.', { default: 'dist' }), option('--force', 'boolean', 'Replace existing poki.json.', { default: false }), formatOption], side_effects: ['Writes poki.json.'], examples: [example('poki init --game GAME_ID --build-dir dist', 'Create explicit project configuration.')], network: { method: 'none', path: './poki.json', contacts_api: false }, risk: 'local_write', missing_input: '--game' })
add({ path: ['upload'], summary: 'Deprecated human-only build upload; use versions upload for structured workflows.', deprecated: true, aliases: ['legacy upload entry point'], options: [option('--game', 'string', 'Poki for Developers game ID; defaults to the legacy project configuration when present.'), option('--build-dir', 'path', 'Build directory; existing empty directories are archived and uploaded for legacy compatibility; defaults to project build_dir or dist.'), option('--name', 'string', 'Version name; defaults to a timestamped archive name.'), option('--notes', 'string', 'Version notes.'), option('--make-public', 'boolean', 'Request delayed public activation; the same live-traffic change as versions activate, applied without a --yes guard.', { default: false }), option('--disable-image-compression', 'boolean', 'Disable image compression.', { default: false })], behavior: ['Deprecated: use poki versions upload for validated structured output, then poki versions activate for guarded activation.', 'Unlike modern versions upload, this legacy command allows an existing empty build directory and uploads its empty ZIP archive.', 'This command preserves the pre-existing human presentation: timestamped ZIP in the current directory, legacy config fallback, progress and success text, implicit browser authentication, and the raw archive or response failure written to stderr. It does not accept --format; use poki versions upload for JSON or TOON.', 'Unlike 0.1.x, a failed archive or upload exits non-zero and appends the standard structured error document to stderr after that human detail, so a pipeline can tell a published build from a lost one. Every upload failure is non-retryable because the request may already have been accepted: run poki versions list before uploading again.', `The request applies a socket-inactivity deadline of POKI_API_TIMEOUT_MS or ${String(DEFAULT_UPLOAD_TIMEOUT_MS)} ms, so an upload origin that stops answering fails promptly instead of stalling until the operating system gives up. A slow transfer that keeps making progress is never cut off.`, '--make-public is a destructive live-traffic change with no --yes requirement and no --dry-run support.', 'Authentication accepts POKI_UPLOAD_TOKEN (or the deprecated POKI_ACCESS_TOKEN) in addition to saved OAuth credentials; these token variables work for no other command.'], side_effects: ['Creates a version.', '--make-public additionally requests delayed public activation of the uploaded version.'], examples: [example('poki upload --name "$(git rev-parse --short HEAD)" --notes "$(git log -1 --pretty=%B)"', 'Use Git metadata with the preserved human upload workflow.'), example('poki versions upload --label "Release" --wait --format json', 'Use the supported structured upload workflow.')], permission_codes: ['can_create_owned_versions'], network: { method: 'POST', path: '/games/:gameID/versions via legacy upload transport', contacts_api: true }, risk: 'destructive', destructive: true, retry_safe: false, output: { default_format: 'human', formats: ['human'] } })

for (const resource of resourceDocumentations) {
  add({ path: [resource.command, 'fields'], summary: `List the offline ${resource.resource} field index.`, options: [formatOption], network: { method: 'none', path: `bundled ${resource.resource} documentation`, contacts_api: false }, risk: 'offline' })
  add({ path: [resource.command, 'field'], summary: `Return one complete ${resource.resource} field definition.`, arguments: [argument('name', 'Exact field name.')], options: [formatOption], network: { method: 'none', path: `bundled ${resource.resource} documentation`, contacts_api: false }, risk: 'offline', missing_input: 'a field name' })
}

function key (path: readonly string[]): string {
  return path.join(' ')
}

export const commandSpecs = new Map(specs.map(spec => [key(spec.path), spec]))

function children (path: string[]): Array<{ path: string, summary: string }> {
  return specs
    .filter(spec => spec.path.length === path.length + 1 && path.every((part, index) => spec.path[index] === part))
    .map(spec => ({ path: commandLabel(spec.path), summary: spec.summary }))
}

export function commandSpec (path: string[]): CommandSpec | undefined {
  return commandSpecs.get(key(path))
}

// An unknown command and an unknown help path both have to offer the caller a
// command index to self-correct from, and they must offer the same one: when
// the first segment resolves to a group, its own actions are what the caller
// needs; a leaf or unrecognized first segment has no child index, so the root
// command list is the fallback. The resolved group path is returned too
// because the caller's hint names it.
export function availableCommands (path: readonly string[]): { groupPath: string[], commands: Array<{ path: string, summary: string }> } {
  const groupPath = path.length > 0 && commandSpec([path[0]]) !== undefined ? [path[0]] : []
  const scoped = helpDocument(groupPath).commands as Array<{ path: string, summary: string }> | undefined
  if (scoped !== undefined) return { groupPath, commands: scoped }
  return { groupPath: [], commands: helpDocument([]).commands as Array<{ path: string, summary: string }> }
}

function retryContract (spec: CommandSpec): Record<string, unknown> {
  return {
    automatic_after_401_refresh: 'The request is replayed once; a 401 rejection happens before the request executes, so a mutation cannot double-apply.',
    automatic_otherwise: false,
    safe_to_retry_after_failure: spec.retry_safe ?? false
  }
}

function usageFor (spec: CommandSpec, hasChildren = false): string {
  const parts = [commandLabel(spec.path)]
  if (hasChildren) parts.push(spec.path.length === 0 ? '<command>' : '<action>')
  for (const value of spec.arguments ?? []) {
    parts.push(value.required ? `<${value.name}>` : `[${value.name}]`)
  }
  for (const value of spec.options ?? []) {
    if (value.required !== true) continue
    parts.push(value.type === 'boolean' ? value.name : `${value.name} <value>`)
  }
  parts.push('[options]')
  return parts.join(' ')
}

export function helpDocument (path: string[], notice?: HelpNotice): Record<string, unknown> {
  const spec = commandSpec(path)
  if (spec === undefined) throw new Error(`Unknown command path: ${path.join(' ')}`)
  const childCommands = children(path)
  if (childCommands.length > 0) {
    return {
      ...(notice === undefined ? {} : { notice }),
      command: commandLabel(path),
      usage: usageFor(spec, true),
      summary: spec.summary,
      ...(spec.behavior === undefined ? {} : { behavior: spec.behavior }),
      ...(spec.quickstart === undefined ? {} : { quickstart: spec.quickstart }),
      commands: childCommands,
      ...(spec.examples === undefined ? {} : { examples: spec.examples }),
      ...(spec.discovery === undefined ? {} : { discovery: spec.discovery }),
      help: {
        command: 'poki help <group> <action>',
        manifest: 'poki help --all',
        search: 'poki help --search TEXT',
        permissions: 'poki help permissions',
        formats: 'poki help formats',
        shapes: 'poki help shapes',
        workflows: 'poki help workflows'
      },
      ...(path.length === 0 ? { provenance: spec.provenance } : {})
    }
  }
  const contactsApi = spec.network?.contacts_api === true
  const aliases = spec.aliases ?? []
  const permissions = spec.permission_codes ?? []
  const permissionRequirements = developerPermissionRequirements(permissions)
  return {
    ...(notice === undefined ? {} : { notice }),
    command: commandLabel(path),
    usage: usageFor(spec),
    summary: spec.summary,
    ...(spec.deprecated === true ? { deprecated: true } : {}),
    ...(aliases.length === 0 ? {} : { aliases }),
    risk: spec.risk ?? 'offline',
    destructive: spec.destructive ?? false,
    non_atomic: spec.non_atomic ?? false,
    scope: spec.scope ?? 'not applicable',
    network: spec.network ?? { method: 'none', path: 'none', contacts_api: false },
    // Offline commands have no permissions or retry semantics worth printing.
    // An API command with an explicit empty list meaningfully checks no named
    // permission (game-change-requests cancel); one with no list at all
    // (auth login) has no permission or replay semantics to document.
    ...(contactsApi && spec.permission_codes !== undefined ? { permission_codes: permissions, permission_requirements: permissionRequirements, ...(spec.permission_logic === undefined ? {} : { permission_logic: spec.permission_logic }), retry: retryContract(spec) } : {}),
    input_schema: inputSchema(spec),
    output_schema: spec.output ?? { default_format: 'toon', formats: ['toon', 'json'] },
    exit_codes: standardExitCodes,
    help: {
      manifest: 'poki help --all',
      search: 'poki help --search TEXT',
      permissions: 'poki help permissions',
      formats: 'poki help formats',
      shapes: 'poki help shapes',
      workflows: 'poki help workflows'
    },
    ...(spec.behavior === undefined ? {} : { behavior: spec.behavior }),
    ...(spec.side_effects === undefined ? {} : { side_effects: spec.side_effects }),
    ...(spec.examples === undefined ? {} : { examples: spec.examples }),
    ...(spec.discovery === undefined ? {} : { discovery: spec.discovery }),
    ...(spec.references === undefined ? {} : { references: spec.references })
  }
}

// Stable-sort the manifest so late registrations (fields/field discovery)
// appear next to the rest of their group instead of at the tail.
function groupedSpecs (): CommandSpec[] {
  const firstIndexByGroup = new Map<string, number>()
  specs.forEach((spec, index) => {
    const group = spec.path[0] ?? ''
    if (!firstIndexByGroup.has(group)) firstIndexByGroup.set(group, index)
  })
  return [...specs].sort((a, b) => {
    return (firstIndexByGroup.get(a.path[0] ?? '') ?? 0) - (firstIndexByGroup.get(b.path[0] ?? '') ?? 0)
  })
}

export function commandManifest (full = false): Record<string, unknown> {
  return {
    commands: [
      ...groupedSpecs().map(spec => ({
        command: commandLabel(spec.path),
        usage: usageFor(spec, children(spec.path).length > 0),
        summary: spec.summary,
        ...(spec.deprecated === true ? { deprecated: true } : {}),
        risk: spec.risk,
        network: spec.network,
        ...(spec.network?.contacts_api === true && spec.permission_codes !== undefined ? { permission_codes: spec.permission_codes, ...(spec.permission_logic === undefined ? {} : { permission_logic: spec.permission_logic }) } : {}),
        scope: spec.scope ?? 'not applicable',
        ...((spec.aliases ?? []).length === 0 ? {} : { aliases: spec.aliases }),
        ...(full ? { input_schema: inputSchema(spec) } : {})
      })),
      ...helpTopics.map(topic => ({
        command: `poki help ${topic.name}`,
        usage: `poki help ${topic.name}`,
        summary: topic.summary,
        risk: 'offline' as CommandRisk,
        network: { method: 'none' as const, path: 'bundled reference topic', contacts_api: false },
        scope: 'not applicable'
      }))
    ],
    meta: {
      total: specs.length + helpTopics.length,
      contract_version: 1,
      ...(full ? { schema: 'full' } : { schema: 'compact', full_schema: 'poki help --all --full' }),
      provenance: bundledProvenance
    }
  }
}

// Structured commands carry the same --format/--timeout-ms/--raw/--dry-run/
// --yes boilerplate; deprecated human-only upload is the intentional
// exception. Matching search text against those shared option objects would
// return the full manifest for queries like "format" or "toon". Filtering by
// identity keeps intentionally divergent options (the csv-capable analytics
// --format) searchable.
const universalOptionObjects = new Set<HelpOption>([formatOption, rawOption, viewRawOption, listRawOption, timeoutOption, uploadTimeoutOption, dryRunOption, yesOption, fullOption, fieldsOption, dataOption, gameOption])

export function searchCommandManifest (text: string): Record<string, unknown> {
  const needle = text.trim().toLowerCase()
  const matches = groupedSpecs().filter(spec => JSON.stringify({
    path: spec.path,
    summary: spec.summary,
    permissions: spec.permission_codes,
    permission_requirements: developerPermissionRequirements(spec.permission_codes ?? []),
    permission_logic: spec.permission_logic,
    options: (spec.options ?? []).filter(value => !universalOptionObjects.has(value)),
    behavior: spec.behavior,
    risk: spec.risk,
    aliases: spec.aliases
  }).toLowerCase().includes(needle))
  const topicMatches = helpTopics.filter(topic => {
    return `${topic.name} ${topic.summary} ${topic.keywords.join(' ')}`.toLowerCase().includes(needle)
  })
  // The bundled analytics vocabulary (tables, columns, metrics, recipes) and
  // the resource field references are searchable so report questions like
  // "earnings" or output questions like "public_version" resolve to a
  // discovery command instead of zero matches. Each kind keeps its own quota
  // so ubiquitous column matches cannot crowd out metrics or recipes.
  const kindQuota = 8
  const clip = <T>(items: T[]): T[] => items.slice(0, kindQuota)
  const dataKinds = needle.length < 3
    ? []
    : [
        tableCatalog.filter(table => `${table.name} ${table.description}`.toLowerCase().includes(needle))
          .map(table => ({ kind: 'table', name: table.name, command: `poki data table ${table.name}` })),
        tableCatalog.flatMap(table => table.columns
          .filter(column => `${column.name} ${column.description}`.toLowerCase().includes(needle))
          .map(column => ({ kind: 'column', name: `${table.name}.${column.name}`, command: `poki data column ${table.name} ${column.name}` }))),
        dataMetrics.filter(metric => `${metric.name} ${metric.description} ${metric.population} ${metric.aggregation_guidance} ${metric.supported_tables.join(' ')}`.toLowerCase().includes(needle))
          .map(metric => ({ kind: 'metric', name: metric.name, command: `poki data metric ${metric.name}` })),
        dataRecipes.filter(recipe => `${recipe.name} ${recipe.description}`.toLowerCase().includes(needle))
          .map(recipe => ({ kind: 'recipe', name: recipe.name, command: `poki data recipe ${recipe.name}` })),
        resourceDocumentations.flatMap(resource => resource.fields
          .filter(field => `${field.name} ${field.description}`.toLowerCase().includes(needle))
          .map(field => ({ kind: 'field', name: `${resource.command}.${field.name}`, command: `poki ${resource.command} field ${field.name}` }))),
        audienceCatalog.filter(audience => `${audience.id} ${audience.name}`.toLowerCase().includes(needle))
          .map(audience => ({ kind: 'audience', name: `${audience.id}: ${audience.name}`, command: 'poki audiences list' }))
      ]
  const dataMatches = dataKinds.flatMap(clip)
  const dataMatchesTruncated = dataKinds.some(items => items.length > kindQuota)
  return {
    query: text,
    commands: [
      ...matches.map(spec => ({ command: commandLabel(spec.path), usage: usageFor(spec, children(spec.path).length > 0), summary: spec.summary, risk: spec.risk })),
      ...topicMatches.map(topic => ({ command: `poki help ${topic.name}`, usage: `poki help ${topic.name}`, summary: topic.summary, risk: 'offline' as CommandRisk }))
    ],
    ...(dataMatches.length === 0 ? {} : { data_matches: dataMatches }),
    meta: {
      total: matches.length + topicMatches.length,
      ...(dataMatches.length === 0 ? {} : { data_matches: dataMatches.length }),
      ...(dataMatchesTruncated ? { data_matches_truncated: true, data_matches_note: `Each match kind is capped at ${kindQuota}; narrow the search text for the rest.` } : {}),
      contract_version: 1,
      ...(matches.length + topicMatches.length + dataMatches.length === 0 ? { suggestion: 'No matches. Universal options such as --format are not searched; run poki help --all for the complete manifest.' } : {})
    }
  }
}

export function shapesDocument (): Record<string, unknown> {
  return {
    topic: 'shapes',
    channels: {
      stdout: 'Exactly one structured success document: TOON by default, minified JSON with --format json, CSV for analytics exports, and plain text for poki version and the deprecated human-only upload command.',
      stderr: 'Exactly one structured error document on failure. A successful eligible API command may instead append one separate structured CLI_UPDATE_AVAILABLE notice after stdout; auth login and the deprecated human-only upload command may write free-text progress lines.',
      exit_codes: standardExitCodes
    },
    update_notice: {
      channel: 'stderr after a successful eligible command; JSON with --format json and TOON otherwise, including CSV success output',
      shape: '{notice: {code: CLI_UPDATE_AVAILABLE, message, blocking: false, current_version, available_version, channel: latest, update_commands: {global, project_local}, verify_commands: {global, project_local}, completed_command_requires_rerun: false}}',
      separation: 'The success document or CSV rows on stdout are unchanged. Failures never receive an update notice beside their error document.',
      action: 'Choose the update command matching the installation mode, verify the installed version, and do not replay the already completed command. See poki help updates.'
    },
    resource_envelope: {
      shape: { data: 'one resource object, an array of resource objects, or null for an empty successful response', meta: 'view, pagination, or operation metadata' },
      resource: 'A normalized resource is a flat object containing only the bundled developer-visible field contract, with expanded relationships. Relationship identifiers without included data remain {type, id}.',
      validation: 'Every non-empty normalized JSON:API document must own data. Singular commands accept object or null; collection commands accept array or null. Missing, scalar, wrong-cardinality, or simultaneous data-and-errors shapes fail closed. Empty, JSON-null, and 204 responses normalize to {data: null, meta: {}}.',
      backend_meta: 'Normalized backend JSON:API document metadata is allowlisted to total, failed, and developer-sanitized permissions. Pagination, views, waits, and other CLI-generated metadata are added separately and are not constrained by that backend allowlist.',
      raw: '--raw is an explicit troubleshooting escape hatch that keeps a valid backend JSON:API document shape and fields; it may contain undocumented fields and disables normalization and list views. Documented command-specific enrichments can apply: Playtest recording list/get add video_url and metadata_json_url to each valid raw resource attributes object. Successful mutation documents are validated before raw rendering.',
      timestamps: `Resource timestamps are ${RESOURCE_API_TIME_ZONE}.`
    },
    list_views: {
      default: 'List commands project each resource to an operational summary of roughly 8 to 11 fields and set meta.view to summary.',
      overrides: '--full returns every bundled developer-visible field present in the response (meta.view: full); --fields a,b accepts only documented developer-visible fields (meta.view: selected).',
      get_commands: 'Singular get commands return every bundled developer-visible field supplied by the response; only list commands apply views.'
    },
    pagination_meta: {
      applicability: 'Pagination fields and --all exist only on commands whose endpoint implements pagination; inspect each command options array.',
      non_paginated: 'Complete-collection endpoints make one request, expose no pagination flags, and preserve reviewed backend metadata without inventing page or page_size.',
      single_page: 'meta preserves reviewed backend metadata and always reports has_next. It is authoritative when the server exposes a JSON:API links.next member; otherwise it reports whether the page filled the requested page size, so true means another page may exist and false proves exhaustion. Do not read meta.total as a collection size: some endpoints report a per-page total. Use --all when a result must be provably complete.',
      all: '--all responses report fetched (resources actually collected), pages_fetched, truncated, and has_next. Explicit --max-pages or --max-items adds only the supplied values to bounds and permits successful truncation; next is the first unfollowed server link when available. Every continuation is structurally valid HTTP(S) and same-origin before it is followed or returned. Without an explicit bound, reaching an internal safety ceiling fails with INVALID_API_RESPONSE. Server totals are dropped because endpoints report per-page totals inconsistently. An authoritative next link is followed across empty intermediate pages; a malformed, cross-origin, cyclic, or repeated non-empty page fails closed without exposing its URL.',
      all_page_fields: 'Under --all, meta.page is 1 and meta.page_size equals fetched.'
    },
    dry_run_documents: {
      single_request: '{dry_run: true, contacted_api: false, validation: {scope: local_input_only, local_input_validated: true, backend_mutation_validated: false, mutation_permissions_validated: false, resource_state_validated: false}, executable: unknown, request: {method, path, body?}, risk, destructive, non_atomic, side_effects[]}',
      multi_request: 'playtest-requests replace previews the ordered operations as requests[] instead of request.',
      validation: 'A normal dry-run proves only that local parsing and implemented local constraints passed. It cannot prove backend acceptance, mutation permission, current resource state, or every server constraint; executable therefore remains unknown.',
      network_exception: 'playtest-requests replace first reads the current game, so contacted_api and resource_state_validated are true, but its DELETE and POST are still not sent or backend-validated.',
      risk_semantics: 'risk mirrors the documented classification from poki help; the destructive and non_atomic booleans describe the resolved invocation.',
      auth_logout: '{operation: "delete_saved_oauth_credentials", dry_run: true}'
    },
    synthesized_results: [
      'Endpoints that return an empty body still produce a structured confirmation:',
      'versions archive/unarchive: {data: {type: game_versions, id, action}, meta: {}}',
      'playtest-recordings archive/unarchive/watch: {data: {id, archived|watched}, meta: {}}',
      'playtest-recordings update on an empty response: {data: {id, tags}, meta: {}}',
      'playtest-recordings skip-assessment on an empty response: {data: {id, tags: [], skipped_assessment: true}, meta: {}}',
      'playtest-requests cancel: {data: {id, cancelled: true}, meta: {}}',
      'playtest-requests replace normalized success: {data: {cancelled_request_id, replacement, atomic: false}, meta: {}}; --raw returns the replacement POST document unchanged.',
      'player-fit-tests stop: {data: {id, stopped: true}, meta: {}}',
      'deletes: {data: {id, deleted: true}, meta: {}}',
      'downloads: local-result documents ({data: {path, bytes, ...}}), not JSON:API resources.'
    ],
    analytics_results: {
      shape: 'data query, data run, and data freshness return a fresh {total, header, rows, included?, meta: {evidence}} envelope. Rows retain only header-named keys while preserving selected nested values; backend metadata and extra top-level or row fields are omitted. Output columns are named by alias when set, otherwise by the final field segment after qualification. The CLI uses that resolver for duplicate detection, includes, and freshness evidence, and rejects duplicate response headers.',
      conditions: 'The top-level where statement is conjunctive: omit operator or use and. The CLI rejects top-level or because the deployed API rewrites it to AND; put OR expressions inside a nested condition statement. Condition tuples are [left, operator, right]. For scalar comparisons, in, and like variants, left may be a field or validated select-statement expression and right may be the operator-specific literal value(s) or a validated select-statement expression. The backend renders select statements inline as expressions, not as database subqueries; run `poki data describe conditions` for exact operand shapes.',
      signed_int64_hashes: 'dbt_p4d_game_events_funnel_v2 hashes may exceed JavaScript safe-integer precision. Select one with toString(event_hash), select distinct values with groupUniqArray(toString(event_hash)), and filter prefix_hashes with has_any_int64 plus exact base-10 decimal strings copied verbatim; never use JavaScript numbers. Direct hash output, numeric hash comparisons, scalar has on prefix_hashes, and derived hash conditions other than length(prefix_hashes) == 0 are rejected locally.',
      evidence: 'meta.evidence records the exact query, recipe, source, requested limit and offset, returned and total rows, completeness, timezone, freshness status, and structured warnings. completeness.has_more is true only when the returned window actually filled the requested limit and more rows follow: returned.total_rows counts source rows rather than result rows for an ungrouped aggregate, so a complete single-row result can report a total in the thousands. returned_in_rows requires an actually returned selected last_updated_at timestamp column; the source table name alone is insufficient.',
      csv: '--format csv is a shape-stable export but cannot carry meta.evidence. Execute analytics as JSON or TOON first and verify completeness, then export. Resource list CSV is rejected whenever the result is incomplete or its completeness cannot be proved, whether a bounded --all reports truncated or an ordinary page reports has_next; a page that filled the requested page size counts as unproven, so use --all to export a collection larger than one page. Otherwise its columns are the union of viewed fields with nested values embedded as JSON cells, and an empty collection exports the header its view declares.'
    },
    permissions: {
      codes: 'permission_codes document the developer-scoped permission relevant to the command; permission_requirements pairs each code with its description. Commands with multiple reads expose their AND/OR expression in permission_logic. Only HTTP 403 together with JSON:API code permission-denied becomes PERMISSION_DENIED; the same backend code on another status keeps a generic HTTP classification.',
      empty: 'An empty permission_codes list means the command checks no named permission (ownership rules still apply server-side).',
      discovery: 'poki help permissions describes every CLI code. poki whoami returns the effective subset granted to the current credentials; --raw preserves the unfiltered backend response.',
      enforcement: 'The backend remains authoritative because ownership, team flags, resource state, and developer-support custom grants cannot be proven from a role label or local preflight.'
    },
    error_envelope: {
      channel: 'stderr, with the exit code from exit_codes',
      shape: '{error: {code, message, status?, details?, retryable, request_id?, retry_after?, hint?}}',
      malformed_response_boundary: 'Normalized malformed-response errors expose expected and received structural kinds or member presence only. Backend payload values, arbitrary metadata, signed URLs, response fragments, and transport exception text are omitted; use --raw only to inspect a valid backend response deliberately. Legacy top-level API error/message values are not reviewed JSON:API errors and reduce to a generic HTTP_nnn failure.',
      codes: [
        'MISSING_INPUT (exit 2): details.help embeds the full command contract; self-correct from it.',
        'INVALID_INPUT (exit 2): local validation; unknown commands embed details.suggestions and details.available_commands.',
        'AUTH_REQUIRED (exit 3): a human must run poki auth login.',
        'PERMISSION_DENIED (exit 4, status 403): the backend explicitly identified an ACL failure; details includes the command’s documented permission requirements and an allowlisted API error summary containing only status, code, title, and detail.',
        'NOT_FOUND (exit 4): the resource does not exist in the scanned scope.',
        'ACTIVE_VERSION_MULTIPLE_TRACKS (exit 4, status 409): versions activate found more than one existing traffic track during its GET preflight and sent no PATCH.',
        'WAIT_TIMEOUT (exit 5, retryable): --wait exceeded --wait-timeout-ms; details holds the last observed state and resource, and the operation continues server-side.',
        'ASYNC_OPERATION_FAILED (exit 5, not retryable): --wait observed a terminal failure state; details includes final_state and the final resource.',
        'VERSION_UPLOAD_WAIT_FAILED (exit mirrors the cause, not retryable): the upload succeeded but polling failed or the successful response had no usable ID. details preserves normalized creation data and provides recovery.resume_poll when an ID exists or recovery.inspect_created_version otherwise. Do not upload again.',
        'PLAYER_FEEDBACK_QUESTION_CREATE_WAIT_FAILED (exit mirrors the cause, not retryable): creation succeeded but polling failed or the successful response had no usable ID. details preserves normalized creation data and provides recovery.resume_poll when an ID exists or recovery.inspect_created_question otherwise. Do not create again.',
        'VERSION_ACTIVATION_OUTCOME_UNKNOWN (exit mirrors the underlying failure, 5 when malformed or unavailable; not retryable): an activation PATCH may have committed. details preserves previous_tracks and requested_tracks plus inspect-first recovery; never replay or roll back before reading the current allocation.',
        'PLAYTEST_REQUEST_REPLACEMENT_CANCELLATION_FAILED (exit mirrors the underlying failure, not retryable): cancellation failed or has an unknown outcome, so the replacement POST was not attempted. details preserves the resolved replacement and conditional inspect, retry, and create recovery.',
        'PLAYTEST_REQUEST_REPLACEMENT_FAILED (exit mirrors the underlying failure, 5 when unknown): the original request was cancelled but the replacement POST failed; details carries cancelled_request_id, replacement_creation_state, and machine-actionable recovery. Unknown outcomes require inspecting current state before any create attempt.',
        'Codes from reviewed JSON:API errors[] members are normalized to UPPER_SNAKE_CASE (exit 4 for 4xx, 5 for 5xx). Missing errors[] and legacy top-level error/message shapes reduce to HTTP_nnn with a generic message. PERMISSION_DENIED additionally requires status 403.',
        'API_TIMEOUT, NETWORK_ERROR, INVALID_API_RESPONSE, UPLOAD_FAILED, UNEXPECTED_ERROR (exit 5).',
        'INTERRUPTED (exit 130, not retryable): SIGINT or SIGTERM stopped the CLI before the command completed; registered temporary files are removed, but a request that was already sent may still have been applied. Read current resource state before retrying.'
      ],
      retry: 'retryable is true for transient GET failures and explicitly retry-safe read-only POSTs; retry_after echoes the Retry-After header when present. A failed mutation or malformed successful mutation response is not retryable because its outcome may be unknown: read resource state and do not replay blindly. Terminal asynchronous resource failures are not retryable.',
      nested_causes: 'Action-level errors recursively project their causes through the public error allowlist. The nested cause keeps documented outer fields and JSON:API error status, code, title, and detail only; source pointers, error/document metadata, permission lists, ACL diagnostics, and arbitrary backend fields are omitted.'
    }
  }
}

export function workflowsDocument (): Record<string, unknown> {
  return {
    topic: 'workflows',
    release: {
      steps: [
        'poki versions upload --label "..." --wait creates the version and blocks until processing reaches done or error (drop --wait to poll manually).',
        'Without --wait: poll poki versions get VERSION_ID until state is done (enum documented at poki versions field state); suggested interval 10-30 seconds with a deadline.',
        'poki reviews request --version VERSION_ID --developer-notes "..." — the server requires state done.',
        'Poll poki reviews list --version VERSION_ID until the review status is approved; approval is a human backend workflow and can take days, so use a long explicit deadline and preserve the last status so polling can be resumed.',
        'poki games readiness reports current backend blockers and candidate versions without applying dashboard-only eligibility.',
        'poki versions activate VERSION_ID --yes sends 100 percent of public traffic to the version; use its offline --dry-run first and remember that executable remains unknown until backend execution.'
      ],
      rollback: 'versions activate returns meta.previous_tracks; to roll back, activate the version_id it lists for the public track.'
    },
    polling: {
      wait_flag: 'Prefer --wait over manual polling where supported: versions get, versions upload, and player-feedback-questions get and create. Success adds meta.wait {final_state, polls, waited_ms}; a terminal failure raises non-retryable ASYNC_OPERATION_FAILED with the final resource, and the deadline raises retryable WAIT_TIMEOUT. When polling itself fails after a create/upload succeeded, follow the action-level error recovery command and never replay the mutation.',
      guidance: 'Otherwise poll the singular get command of the resource; suggested interval 10-30 seconds. Always bound polling with a deadline and surface the last observed state on timeout.',
      resources: [
        { resource: 'versions', field: 'state', success: 'done', failure: 'error', reference: 'poki versions field state' },
        { resource: 'player-feedback-questions', field: 'status', success: 'completed', failure: 'failed', reference: 'poki player-feedback-questions field status' },
        { resource: 'reviews', field: 'status', terminal: 'server-defined; pending until QA completes', reference: 'poki reviews field status' },
        { resource: 'player-fit-tests', field: 'status', terminal: 'see enum', reference: 'poki player-fit-tests field status' }
      ]
    },
    discovery: {
      game_id: 'poki games list (id field), or the game page URL on developers.poki.com.',
      team_id: 'poki whoami (team relationship). Analytics recipes require it as --team.',
      version_id: 'poki versions list.',
      event_keys: "Query dbt_p4d_game_events_funnel_v2.event and pass each value verbatim to --event. Keys use category^what^action with '^' as the reserved separator; the empty action form still ends in '^'.",
      funnel_hashes: 'Query dbt_p4d_game_events_funnel_v2.event_hash through toString, or through groupUniqArray(toString(event_hash)) for distinct values. Reuse the emitted decimal strings verbatim in ["prefix_hashes", "has_any_int64", ["..."]]; signed 64-bit hashes can exceed JavaScript safe-integer precision, so never parse or write them as numbers.',
      category_names: 'For games suggested-category, use name values from poki audiences list.',
      category_ids: 'For Playtest and Player Fit targeting, use numeric IDs from poki audiences list --testing-only.'
    },
    reporting: {
      steps: [
        'poki data tables, poki data metrics, and poki data recipes discover the bundled analytics surface offline.',
        'poki data recipe NAME shows required typed parameters; poki data run NAME --team TEAM_ID --last-days 7 --validate-only resolves parameters and checks local structure without claiming API validity.',
        'Drop --validate-only to execute and inspect meta.evidence for completeness and freshness. Only then add --format csv for shape-stable tabular output. Resource lists accept --format csv too.',
        'For queries beyond the recipes, poki data describe documents the grammar; build the query object and use poki data query.'
      ],
      dates: `Analytics dates are ${ANALYTICS_TIME_ZONE} calendar dates with DST; --last-days N computes the N complete days ending yesterday in that timezone for you.`
    },
    rate_limits: 'HTTP 429 sets retry_after. It is retryable only for reads and explicitly retry-safe requests; inspect mutation state instead of replaying blindly. Use explicit --max-pages or --max-items when an incomplete bounded result is acceptable in a loop.'
  }
}

export function permissionsDocument (): Record<string, unknown> {
  return {
    topic: 'permissions',
    audience: 'This CLI exposes developer and developer-support workflows. Role-wide capabilities unrelated to those workflows are omitted from normalized output and help.',
    authority: {
      effective_permissions: 'poki whoami returns the CLI-relevant permissions effective for the current credentials.',
      enforcement: 'The Poki API is authoritative for every request. Permission grants can depend on ownership, team flags, account restrictions, and per-user developer-support configuration.',
      role_labels: 'Do not infer access from the developer or developer-support role name, and do not preflight commands by role.',
      raw: 'poki whoami --raw preserves the complete backend response for explicit troubleshooting.'
    },
    interpretation: {
      owned: 'In a permission code, owned generally covers resources belonging to the current user or their team; the backend evaluates the exact scope.',
      command_contract: 'Inspect permission_codes, permission_requirements, and permission_logic in poki help COMMAND.',
      denial: 'PERMISSION_DENIED means the backend returned HTTP 403 with JSON:API code permission-denied. The same code on another status remains generic, and a generic FORBIDDEN error can describe a workflow or resource-state restriction. Sanitization applies recursively when a denial is nested under an action-level error.'
    },
    permissions: developerPermissionCatalog.map(permission => ({
      ...permission,
      commands: groupedSpecs()
        .filter(spec => spec.permission_codes?.includes(permission.code) === true)
        .map(spec => commandLabel(spec.path))
    }))
  }
}

export function updatesDocument (): Record<string, unknown> {
  return {
    topic: 'updates',
    purpose: 'Give an LLM a safe, explicit npm update action without letting the CLI modify or relaunch itself.',
    checking: {
      cadence: 'Before the first eligible Poki API request, at most one registry lookup is attempted per rolling 24 hours for the shared user config directory. A failed attempt also starts the 24-hour suppression window.',
      registry_command: 'npm view @poki/cli "dist-tags.latest" --json',
      boundary: 'npm runs without a shell, with a 5-second timeout and bounded output. Lookup, timeout, parse, filesystem, and npm failures are silent and never affect the original command.',
      channel: 'Only the stable latest dist-tag is compared. Equal, older, invalid, and prerelease latest values produce no notice; installations opted into @experimental still refresh experiments manually.',
      eligible: 'Ordinary authenticated Poki API commands are eligible. The lookup finishes before their first real API request.',
      excluded: 'Help, version, auth commands, legacy upload, context, bundled audiences, ordinary mutation --dry-run, and analytics --validate-only do not perform update network or state work. A dry-run explicitly documented as reading current API state is eligible.'
    },
    state: {
      file: 'update-check.json in the same absolute Poki config directory as auth.json: below XDG_CONFIG_HOME/poki, LOCALAPPDATA/Poki, or the absolute home fallback.',
      fields: ['last_attempt_at', 'latest_version', 'last_prompt_at'],
      sharing: 'Global and project-local installations share the state. Atomic same-directory publication and a cross-process lock allow at most one lookup and prompt; abandoned locks expire after 10 minutes.',
      recovery: 'Corrupt, oversized, or future-dated state is ignored and replaced best-effort. State failures do not change command behavior.'
    },
    notice: {
      timing: 'Only after an eligible command succeeds, and at most once per rolling 24 hours. The prompt is claimed before it is written.',
      channel: 'A separate structured document on stderr: JSON for --format json, otherwise TOON. Raw and CSV stdout stay untouched; CSV therefore receives a TOON notice.',
      shape: {
        notice: {
          code: 'CLI_UPDATE_AVAILABLE',
          message: 'A newer stable Poki CLI is available.',
          blocking: false,
          current_version: 'INSTALLED_VERSION',
          available_version: 'AVAILABLE_VERSION',
          channel: 'latest',
          update_commands: {
            global: 'npm install --global --ignore-scripts --no-audit --no-fund @poki/cli@AVAILABLE_VERSION',
            project_local: 'npm install --save-dev --ignore-scripts --no-audit --no-fund @poki/cli@AVAILABLE_VERSION'
          },
          verify_commands: {
            global: 'poki --version',
            project_local: 'npx @poki/cli --version'
          },
          completed_command_requires_rerun: false
        }
      },
      failure_rule: 'A failed command emits only its normal structured error document and no update notice.'
    },
    llm_action: [
      'Select global only for a global installation; select project_local for the project devDependency. The local command changes package.json and the npm lockfile.',
      'Run the matching verify command after npm succeeds.',
      'Before using modern commands after an upgrade, inspect poki help --all and update automation assumptions. Only init, auth login/status/logout, and deprecated top-level upload have a cross-release compatibility guarantee.',
      'Do not replay the Poki command that already completed; the advisory is non-blocking and completed_command_requires_rerun is false.'
    ],
    opt_out: 'Set POKI_CLI_UPDATE_CHECK=0 to disable both update registry access and update state creation.'
  }
}

export interface HelpTopic {
  name: string
  summary: string
  keywords: string[]
  document: () => Record<string, unknown>
}

// Reference topics live beside the command specs: routed through poki help
// NAME, listed in the manifest, and searchable, but never yargs commands.
export const helpTopics: HelpTopic[] = [
  { name: 'formats', summary: 'TOON and JSON encodings, input auto-detection, and the CSV analytics export.', keywords: ['toon', 'json', 'csv', 'format', 'encoding', 'stdin'], document: formatsDocument },
  { name: 'permissions', summary: 'Developer permission codes, descriptions, command mappings, scope, and denial behavior.', keywords: ['permission', 'permissions', 'access', 'forbidden', 'denied', 'developer-support', 'ownership', 'scope', 'whoami'], document: permissionsDocument },
  { name: 'shapes', summary: 'Response envelopes, list views, pagination meta, dry-run documents, and the error contract.', keywords: ['output', 'shape', 'envelope', 'meta', 'pagination', 'has_next', 'view', 'error', 'stderr', 'exit code', 'retryable', 'retry_after', 'request_id', 'dry-run'], document: shapesDocument },
  { name: 'workflows', summary: 'End-to-end release, polling, discovery, and reporting flows with rollback guidance.', keywords: ['workflow', 'release', 'publish', 'poll', 'polling', 'wait', 'rollback', 'review', 'activate', 'report', 'timezone', 'rate limit', 'team id', 'game id'], document: workflowsDocument },
  { name: 'updates', summary: 'Stable daily update checks, shared state, stderr advisory shape, npm actions, and opt-out.', keywords: ['update', 'upgrade', 'npm', 'latest', 'experimental', 'dist-tag', 'stderr', 'POKI_CLI_UPDATE_CHECK'], document: updatesDocument }
]

export function helpTopicDocument (name: string): Record<string, unknown> | undefined {
  return helpTopics.find(topic => topic.name === name)?.document()
}

export function formatsDocument (): Record<string, unknown> {
  return {
    topic: 'formats',
    output: {
      default: 'toon',
      json: 'Every structured command accepts --format json for minified JSON with an identical structure.',
      csv: 'Analytics commands and resource list commands additionally accept --format csv for shape-stable tabular export.'
    },
    toon_primer: [
      'TOON is a compact line-based encoding of JSON data using indentation and tab delimiters.',
      'key: value — one object field; nested objects indent by two spaces.',
      'key[N<TAB>]: a<TAB>b — inline array of N primitive values; the delimiter character (a tab here) is declared inside the brackets after the count.',
      'key[N<TAB>]{colA<TAB>colB}: — header for an array of N uniform objects; each following indented line is one row of delimiter-separated cell values.',
      'Strings are quoted only when required; quoted strings use JSON-style escapes (\\" \\n \\t). null, true, false, and numbers are literal.'
    ],
    input: 'Inputs documented as "JSON or TOON" (--data, --query) are auto-detected. JSON is always accepted and recommended for generated input; TOON acceptance exists for pasting command output back in.',
    example: {
      json: '{"title":"My Game","tags":["a","b"]}',
      toon: 'title: My Game\ntags[2\t]: a\tb'
    }
  }
}
