import { availableCommands, commandManifest, commandSpec, CommandSpec, helpDocument, HelpNotice, HelpOption, helpTopicDocument, searchCommandManifest } from './docs/commands'
import { CliError, inputError } from './errors'
import { StructuredFormat } from './output'

export interface HelpResolution {
  document: Record<string, unknown>
  format: StructuredFormat
}

function withoutFormatOptions (args: string[]): string[] {
  const output: string[] = []
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]
    if (argument === '--format') {
      index++
      continue
    }
    if (argument.startsWith('--format=')) continue
    output.push(argument)
  }
  return output
}

// The command an invocation names is the longest resolvable prefix of its
// leading run of non-flag tokens. Every caller — the help router, the
// MISSING_INPUT contract, and the unknown-option and permission-denial error
// context — must agree on it, or the same invocation would be attributed to
// different commands on different surfaces.
export function leadingCommandSpec (tokens: string[]): { path: string[], spec: CommandSpec } | undefined {
  const leading: string[] = []
  for (const token of tokens) {
    if (token.startsWith('-')) break
    leading.push(token)
  }
  for (let length = leading.length; length >= 1; length--) {
    const path = leading.slice(0, length)
    const spec = commandSpec(path)
    if (spec !== undefined) return { path, spec }
  }
}

function optionsByName (spec: CommandSpec | undefined): Map<string, HelpOption> {
  return new Map((spec?.options ?? []).map(option => [option.name, option]))
}

// A declared value-taking option swallows the next token, so every scanner has
// to step over it: otherwise `--tag -h` reads as a help request and `--game g1`
// reads as a supplied positional.
function consumesNextToken (optionByName: Map<string, HelpOption>, token: string): boolean {
  const declared = token.includes('=') ? undefined : optionByName.get(token)
  return declared !== undefined && declared.type !== 'boolean'
}

function explicitHelpPath (args: string[]): string[] | undefined {
  const cleaned = withoutFormatOptions(args)

  // Resolving the command prefix first is what makes declared value-taking
  // options known; the root spec covers an invocation that names no command.
  const optionByName = optionsByName(leadingCommandSpec(cleaned)?.spec ?? commandSpec([]))

  let helpRequested = false
  for (let index = 0; index < cleaned.length; index++) {
    const token = cleaned[index]
    if (token === '--help' || token === '-h') {
      helpRequested = true
      continue
    }
    if (consumesNextToken(optionByName, token)) index++
  }
  if (!helpRequested) return undefined

  const pathTokens = cleaned.filter(argument => argument !== '--help' && argument !== '-h')
  const firstOption = pathTokens.findIndex(argument => argument.startsWith('-'))
  return matchingCommandPath(firstOption === -1 ? pathTokens : pathTokens.slice(0, firstOption))
}

function helpFormat (args: string[]): StructuredFormat {
  let format: StructuredFormat = 'toon'
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]
    if (argument !== '--format' && !argument.startsWith('--format=')) continue
    const value = argument === '--format' ? args[++index] : argument.slice('--format='.length)
    if (value !== 'toon' && value !== 'json') throw inputError('--format for help must be toon or json.')
    format = value
  }
  return format
}

// The caller passes the raw arguments so --format keeps its own parsing; the
// routed path is read from the cleaned tokens, whose first entry is `help`.
function routedHelp (args: string[]): HelpResolution {
  const format = helpFormat(args)
  const tokens = withoutFormatOptions(args)
  const path: string[] = []
  let all = false
  let full = false
  let search: string | undefined

  for (let index = 1; index < tokens.length; index++) {
    const argument = tokens[index]
    if (argument === '--help' || argument === '-h') continue
    if (argument === '--all') {
      all = true
      continue
    }
    if (argument === '--full') {
      full = true
      continue
    }
    if (argument === '--search') {
      if (search !== undefined) throw inputError('--search may only be supplied once.')
      const value = tokens[index + 1]
      if (value === undefined || value.startsWith('--')) throw inputError('--search requires text.')
      search = value
      index++
      continue
    }
    if (argument.startsWith('--search=')) {
      if (search !== undefined) throw inputError('--search may only be supplied once.')
      search = argument.slice('--search='.length)
      continue
    }
    if (argument.startsWith('-')) throw inputError(`Unknown help option '${argument}'.`)
    path.push(argument)
  }

  if (all && search !== undefined) throw inputError('--all cannot be combined with --search.')
  if ((all || search !== undefined) && path.length > 0) throw inputError('--all and --search cannot be combined with a command path.')
  if (full && !all) throw inputError('--full requires --all.')
  if (search !== undefined && search.trim() === '') throw inputError('--search requires text.')
  if (all) return { document: commandManifest(full), format }
  if (search !== undefined) return { document: searchCommandManifest(search), format }
  if (path.length === 1) {
    const topic = helpTopicDocument(path[0])
    if (topic !== undefined) return { document: topic, format }
  }
  return { document: helpDocument(matchingCommandPath(path)), format }
}

function matchingCommandPath (args: string[]): string[] {
  for (let length = args.length; length >= 0; length--) {
    const candidate = args.slice(0, length)
    const spec = commandSpec(candidate)
    if (spec !== undefined && args.length - length <= (spec.arguments?.length ?? 0)) return candidate
  }
  throw inputError(`Unknown help path '${args.join(' ')}'.`, {
    available_commands: availableCommands(args).commands
  })
}

function implicitNotice (path: string[], code: HelpNotice['code'], message: string): HelpResolution {
  return {
    document: helpDocument(path, { code, message }),
    format: 'toon'
  }
}

export function resolveHelp (args: string[]): HelpResolution | undefined {
  const cleaned = withoutFormatOptions(args)
  // `help` is matched after removing --format so a leading encoding option
  // still reaches the structured help document instead of falling through to
  // yargs, which would exit successfully without printing anything.
  if (cleaned[0] === 'help') return routedHelp(args)
  const explicitPath = explicitHelpPath(args)
  if (explicitPath !== undefined) return { document: helpDocument(explicitPath), format: helpFormat(args) }

  if (cleaned.length === 0) {
    const resolution = implicitNotice([], 'MISSING_COMMAND', 'No command supplied; showing root help.')
    resolution.format = helpFormat(args)
    return resolution
  }

  if (cleaned.length === 1) {
    const spec = commandSpec(cleaned)
    const children = spec === undefined ? undefined : helpDocument(cleaned).commands
    if (Array.isArray(children) && children.length > 0) {
      const resolution = implicitNotice(cleaned, 'MISSING_ACTION', `No action supplied for poki ${cleaned[0]}; showing group help.`)
      resolution.format = helpFormat(args)
      return resolution
    }
  }

  raiseMissingInput(cleaned)
}

// Universal options never satisfy a command's required input, so an
// invocation carrying only these still surfaces the MISSING_INPUT contract.
const universalOptions = new Set(['--format', '--raw', '--dry-run', '--yes', '--timeout-ms', '--full', '--fields'])

function raiseMissingInput (cleaned: string[]): void {
  // Resolving the command from the leading non-flag tokens is what lets a
  // stray option (`poki versions get --game g1`) still get the embedded
  // contract instead of a bare yargs error.
  const resolved = leadingCommandSpec(cleaned)
  const missingInput = resolved?.spec.missing_input
  if (resolved === undefined || missingInput === undefined) return
  const { path, spec } = resolved

  const optionByName = optionsByName(spec)
  const seenFlags = new Set<string>()
  let positionals = 0
  const tokens = cleaned.slice(path.length)
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]
    if (token.startsWith('-') && token !== '-') {
      seenFlags.add(token.split('=', 1)[0])
      // An undeclared flag is conservatively treated as boolean; an
      // overcounted positional only defers to the yargs error path.
      if (consumesNextToken(optionByName, token)) index++
      continue
    }
    positionals++
  }

  const requiredPositionals = (spec.arguments ?? []).filter(argument => argument.required).length
  const missingRequiredOption = (spec.options ?? []).some(option => option.required === true && !seenFlags.has(option.name))
  const suppliedMeaningful = positionals > 0 || [...seenFlags].some(name => !universalOptions.has(name))
  if (suppliedMeaningful && positionals >= requiredPositionals && !missingRequiredOption) return

  throw new CliError('MISSING_INPUT', `Missing ${missingInput} for poki ${path.join(' ')}.`, 2, {
    details: { help: helpDocument(path) },
    hint: `Provide ${missingInput}. The full command contract is included in details.help.`
  })
}
