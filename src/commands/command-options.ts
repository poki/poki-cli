import type { Argv, Options } from 'yargs'

import {
  dryRunOption,
  fieldsOption,
  filterOption,
  formatOption,
  fullOption,
  type HelpOption,
  listFormatOption,
  paginationOptions,
  rawOption,
  sortOption
} from '../docs/commands'
import { inputError } from '../errors'
import { readStructuredSource, requireAllowedFields } from '../input'
import type { ListCapabilities } from '../list-capabilities'
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_UPLOAD_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  parseTimeoutMilliseconds,
  TIMEOUT_MILLISECONDS_RANGE
} from '../timeouts'
import { ResourceListKind, validateListViewFields } from '../views'
import { render } from './rendering'

export interface MutationBehavior {
  destructive?: boolean
  nonAtomic?: boolean
  sideEffects?: string[]
}

// buildCli disables yargs help and resolveHelp answers every help request, so a
// yargs `describe` can never reach a user: the HelpOption spec is the sole
// documentation surface. Declaring a shared option here therefore means copying
// its name, description, choices and default out of the spec, and a copy can
// disagree. Generate the declaration from the spec instead.
//
// What the spec cannot express stays with the caller: a documented type like
// "positive integer" is prose, and repeatability says nothing about whether one
// occurrence takes exactly one token. Both are load-bearing for parsing, and
// neither is uniform - --filter and --sort accept one string each, while
// repeatable options such as --tag and --event deliberately do not set nargs.
export function applySpecOption (yargs: Argv, spec: HelpOption, declaration: Options = {}): Argv {
  const declared: Options = { describe: spec.description }
  if (spec.type === 'boolean') declared.type = 'boolean'
  if (spec.repeatable === true) declared.type = 'array'
  if (spec.values !== undefined) declared.choices = spec.values
  if (spec.default !== undefined) declared.default = spec.default
  return yargs.option(spec.name.replace(/^--/, ''), { ...declared, ...declaration })
}

// --game shares nothing but its name with the spec: every caller supplies its
// own description, and requiredness and default are resolved from the project
// configuration at registration time. The deprecated upload command declares
// the same default-or-required behavior independently on its compatibility path.
export function withDefaultGameOption (
  yargs: Argv,
  projectGameId: string | undefined,
  description = 'Game ID that scopes this command'
): Argv {
  return yargs.option('game', {
    describe: `${description}; defaults to game_id from the current project configuration`,
    type: 'string',
    demandOption: projectGameId === undefined,
    ...(projectGameId === undefined ? {} : { default: projectGameId })
  })
}

export function withFormatOption (yargs: Argv): Argv {
  return applySpecOption(yargs, formatOption)
}

// --timeout-ms keeps a hand-written declaration: three documented variants say
// the same thing about a different budget, and upload and download share the
// 300000 ms default while documenting it differently, so the applicable spec
// cannot be selected from this function's only parameter. The declared text is
// what parity.test.ts checks the documented budget against.
export function withTimeoutOption (yargs: Argv, defaultMilliseconds = DEFAULT_REQUEST_TIMEOUT_MS): Argv {
  return yargs
    .option('timeout-ms', {
      describe: `Maximum time for each API request in milliseconds; accepts an ${TIMEOUT_MILLISECONDS_RANGE}; defaults to POKI_API_TIMEOUT_MS or ${String(defaultMilliseconds)}`,
      type: 'number'
    })
    .check(argv => {
      if (argv.timeoutMs !== undefined && parseTimeoutMilliseconds(argv.timeoutMs) === undefined) {
        throw inputError(`--timeout-ms must be a positive integer no greater than ${String(MAX_TIMEOUT_MS)}.`)
      }
      return true
    })
}

export function withRequestOptions (yargs: Argv): Argv {
  return withTimeoutOption(withFormatOption(yargs))
}

export function withOutputOptions (yargs: Argv): Argv {
  return applySpecOption(withRequestOptions(yargs), rawOption)
}

export function withUploadOutputOptions (yargs: Argv): Argv {
  return applySpecOption(withTimeoutOption(withFormatOption(yargs), DEFAULT_UPLOAD_TIMEOUT_MS), rawOption)
}

// --yes keeps a hand-written declaration because its wording is the only use of
// `behavior` here; generating it from the single documented spec would leave
// every caller passing a parameter that no longer does anything.
export function withMutationOptions (yargs: Argv, behavior: MutationBehavior = {}): Argv {
  return applySpecOption(yargs, dryRunOption)
    .option('yes', {
      describe: behavior.destructive === true || behavior.nonAtomic === true
        ? 'Confirm the documented destructive or non-atomic operation; required unless --dry-run is used'
        : 'Confirm without an interactive prompt; accepted for uniform automation',
      type: 'boolean',
      default: false
    })
}

// The standard composition for a game-scoped mutation command. Spelled out per
// command, one of the three layers can go missing, which would advertise a
// mutation without --game, --dry-run and --yes, or --format and --timeout-ms.
export function withGameMutationOptions (
  yargs: Argv,
  projectGameId: string | undefined,
  description: string,
  behavior: MutationBehavior = {}
): Argv {
  return withDefaultGameOption(withMutationOptions(withOutputOptions(yargs), behavior), projectGameId, description)
}

// Same composition for actions that report a CLI-synthesized result and
// therefore declare no --raw backend document.
export function withGameActionOptions (
  yargs: Argv,
  projectGameId: string | undefined,
  description: string,
  behavior: MutationBehavior = {}
): Argv {
  return withDefaultGameOption(withMutationOptions(withRequestOptions(yargs), behavior), projectGameId, description)
}

// nargs: 1 keeps yargs from swallowing the following argument into --data.
export function withDataOption (yargs: Argv, describe: string): Argv {
  return yargs.option('data', { describe, type: 'string', nargs: 1 })
}

export function requireConfirmation (args: Record<string, unknown>, action: string): void {
  if (args.dryRun === true || args.yes === true) return
  throw inputError(`${action} requires --yes. Use --dry-run to inspect the resolved operation first.`, {
    confirmation_flag: '--yes',
    preview_flag: '--dry-run'
  })
}

export function requestTimeout (args: Record<string, unknown>): number | undefined {
  return args.timeoutMs === undefined ? undefined : parseTimeoutMilliseconds(args.timeoutMs)
}
export function mutationPreview (
  method: 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body: unknown,
  args: Record<string, unknown>,
  behavior: MutationBehavior = {}
): boolean {
  if (args.dryRun !== true) return false
  render({
    dry_run: true,
    contacted_api: false,
    validation: {
      scope: 'local_input_only',
      local_input_validated: true,
      backend_mutation_validated: false,
      mutation_permissions_validated: false,
      resource_state_validated: false
    },
    executable: 'unknown',
    request: {
      method,
      path,
      ...(body === undefined ? {} : { body })
    },
    // risk mirrors the command's documented classification from poki help
    // (destructive outranks non_atomic); the booleans below describe the
    // resolved invocation precisely.
    risk: behavior.destructive === true ? 'destructive' : behavior.nonAtomic === true ? 'non_atomic' : 'mutation',
    destructive: behavior.destructive ?? false,
    non_atomic: behavior.nonAtomic ?? false,
    side_effects: behavior.sideEffects ?? []
  }, args)
  return true
}

// View selection for commands that return a resource list in one response
// (relationship-backed lists without server pagination).
export function withListViewOptions (yargs: Argv, kind: ResourceListKind): Argv {
  // listFormatOption re-declares --format with the csv choice the view adds.
  let command = applySpecOption(withOutputOptions(yargs), listFormatOption)
  command = applySpecOption(command, fullOption)
  command = applySpecOption(command, fieldsOption, { type: 'string' })
  return command
    .check(argv => {
      // Boolean(), not === true: generating the declaration from the spec drops
      // the yargs type inference that used to make argv.full a boolean here, and
      // the check must keep testing exactly the same truthiness it always did.
      if (argv.raw === true && Boolean(argv.full)) throw inputError('--raw cannot be combined with --full.')
      if (argv.raw === true && argv.fields !== undefined) throw inputError('--raw cannot be combined with --fields.')
      if (argv.raw === true && argv.format === 'csv') throw inputError('--format csv cannot be combined with --raw.')
      if (Boolean(argv.full) && argv.fields !== undefined) throw inputError('--full cannot be combined with --fields.')
      if (typeof argv.fields === 'string') {
        const fields = argv.fields.split(',').map(field => field.trim())
        if (fields.length === 0 || fields.some(field => !/^[A-Za-z0-9_]+$/.test(field))) {
          throw inputError('--fields must be a comma-separated list of top-level field names.')
        }
        validateListViewFields(kind, argv.fields)
      }
      return true
    })
}

// One string per occurrence. Without nargs yargs swallows the following token
// into the array, so `--filter a=b games` would silently lose the command.
const repeatedStringValue: Options = { string: true, nargs: 1 }

export function withListOptions (yargs: Argv, capabilities: ListCapabilities, kind: ResourceListKind): Argv {
  let command = withListViewOptions(yargs, kind)
  if (capabilities.filter) command = applySpecOption(command, filterOption, repeatedStringValue)
  if (capabilities.sort) command = applySpecOption(command, sortOption, repeatedStringValue)
  if (capabilities.pagination) {
    // Every documented pagination bound is a count except the boolean --all,
    // whose kind the spec already carries.
    for (const spec of paginationOptions) {
      command = applySpecOption(command, spec, spec.type === 'boolean' ? {} : { type: 'number' })
    }
  }
  return command.check(argv => {
    if (capabilities.pagination) {
      if (argv.raw === true && argv.all === true) throw inputError('--raw cannot be combined with --all.')
      if (argv.all === true && argv.page !== 1) throw inputError('--all fetches every page from page 1; it cannot be combined with --page.')
      if (!Number.isInteger(argv.page) || Number(argv.page) < 1) throw inputError('--page must be a positive integer.')
      if (!Number.isInteger(argv.pageSize) || Number(argv.pageSize) < 1) throw inputError('--page-size must be a positive integer.')
      if (argv.maxPages !== undefined && (!Number.isInteger(argv.maxPages) || Number(argv.maxPages) < 1)) throw inputError('--max-pages must be a positive integer.')
      if (argv.maxItems !== undefined && (!Number.isInteger(argv.maxItems) || Number(argv.maxItems) < 1)) throw inputError('--max-items must be a positive integer.')
      if (argv.all !== true && (argv.maxPages !== undefined || argv.maxItems !== undefined)) {
        throw inputError('--max-pages and --max-items require --all.')
      }
    }
    return true
  })
}
function suppliedFlags (argv: Record<string, unknown>, names: readonly string[]): string[] {
  return names.filter(name => argv[name] !== undefined)
}

export function ensureDataExclusive (argv: Record<string, unknown>, fieldNames: readonly string[]): void {
  if (argv.data === undefined) return
  const supplied = suppliedFlags(argv, fieldNames)
  if (supplied.length > 0) {
    throw inputError(`--data cannot be combined with field flags: ${supplied.map(name => `--${name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`).join(', ')}.`)
  }
}

export interface MutationInputFields {
  // camelCase yargs names that --data replaces and therefore excludes.
  flags: readonly string[]
  // JSON:API attribute names a --data document may contain. The list is
  // reported verbatim by the unsupported-field error, so its order is public.
  fields: readonly string[]
}

// Pairs each field flag with the attribute it supplies so one declaration
// answers both questions. Two hand-maintained lists can disagree, and a flag
// whose attribute is missing from the allowlist is advertised but unusable.
export function mutationInputFields (pairs: Readonly<Record<string, string>>): MutationInputFields {
  return { flags: Object.keys(pairs), fields: Object.values(pairs) }
}

// Every --data-capable mutation resolves its input the same way: --data and the
// field flags are mutually exclusive, --data supplies the complete field set,
// and the result may contain only allowed fields. Commands differ only in how
// they read their flags, so that step stays with the command.
export async function resolveMutationInput (
  argv: Record<string, unknown>,
  input: MutationInputFields,
  fromFlags: () => Record<string, unknown>
): Promise<Record<string, unknown>> {
  ensureDataExclusive(argv, input.flags)
  const data = argv.data === undefined ? fromFlags() : await readStructuredSource(String(argv.data))
  requireAllowedFields(data, input.fields)
  return data
}
