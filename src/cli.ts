import yargs, { Argv } from 'yargs'

import { ApiClient } from './api'
import { registerAuthCommands } from './commands/auth'
import { registerAudienceCommands } from './commands/audiences'
import { registerDataCommands } from './commands/data'
import { registerDiscoveryCommands } from './commands/discovery'
import { registerGameChangeRequestCommands } from './commands/game-change-requests'
import { registerGameEventCommands } from './commands/game-events'
import { registerGameCommands } from './commands/games'
import { registerNetlibLobbyCommands } from './commands/netlib-lobbies'
import { registerPlayerFitTestCommands } from './commands/player-fit-tests'
import { registerPlayerFeedbackQuestionCommands } from './commands/player-feedback-questions'
import { registerPlaytestRequestCommands } from './commands/playtest-requests'
import { registerPlaytestCommands } from './commands/playtests'
import { registerReviewCommands } from './commands/reviews'
import { registerVersionActivationCommands } from './commands/version-activations'
import { registerVersionCommands } from './commands/versions'
import { availableCommands, CommandSpec } from './docs/commands'
import { developerPermissionRequirements } from './developer-permissions'
import { CliError, safeApiErrorResponse } from './errors'
import { leadingCommandSpec, resolveHelp } from './help'
import { registerLegacyCommands } from './legacy'
import { requestedFormat, writeError, writeStructured } from './output'
import { projectConfigError } from './project'
import { CLI_VERSION } from './version'
import { UpdateCoordinator } from './update'

function cliArguments (args: string[]): string[] {
  // The pre-expansion yargs --version option was global: it short-circuited
  // before command dispatch when placed first, or anywhere in the legacy
  // upload invocation. Preserve its boolean forms too: a false value removed
  // the option and continued with the upload, while the last value won.
  // New commands use --version as a resource option, so only normalize a
  // leading global probe or the deprecated top-level upload command.
  if (args.length === 1 && args[0] === '-v') return ['version']

  const optionEnd = args.includes('--') ? args.indexOf('--') : args.length
  const versionToken = (index: number): { value: boolean, consumed: number } | undefined => {
    const argument = args[index]
    if (argument === '--no-version') return { value: false, consumed: 1 }
    if (argument.startsWith('--version=')) {
      return { value: argument === '--version=true', consumed: 1 }
    }
    if (argument !== '--version') return undefined

    const value = args[index + 1]
    if (index + 1 < optionEnd && (value === 'true' || value === 'false')) {
      return { value: value === 'true', consumed: 2 }
    }
    return { value: true, consumed: 1 }
  }

  let leadingEnd = 0
  let leadingVersion: boolean | undefined
  while (leadingEnd < optionEnd) {
    const token = versionToken(leadingEnd)
    if (token === undefined) break
    leadingVersion = token.value
    leadingEnd += token.consumed
  }

  // yargs allowed upload's own options to precede its command token. Skip
  // their values when identifying that shape so an option value named
  // "upload" cannot accidentally turn a modern invocation into legacy mode.
  const valueOptions = new Set([
    '--game', '-g',
    '--build-dir', '--buildDir', '-b',
    '--name', '-n',
    '--notes', '-o'
  ])
  const booleanOptions = new Set([
    '--make-public', '--makePublic', '-l',
    '--disable-image-compression', '--disableImageCompression', '-i',
    '--no-make-public', '--no-makePublic',
    '--no-disable-image-compression', '--no-disableImageCompression'
  ])
  let commandProbe = 0
  let legacyUpload = false
  while (commandProbe < optionEnd) {
    const token = versionToken(commandProbe)
    if (token !== undefined) {
      commandProbe += token.consumed
      continue
    }

    const argument = args[commandProbe]
    if (argument === 'upload') {
      legacyUpload = true
      break
    }
    const equals = argument.indexOf('=')
    const option = equals === -1 ? argument : argument.slice(0, equals)
    if (valueOptions.has(option)) {
      commandProbe += equals === -1 ? 2 : 1
      continue
    }
    if (booleanOptions.has(option)) {
      const value = args[commandProbe + 1]
      commandProbe += equals === -1 && (value === 'true' || value === 'false') ? 2 : 1
      continue
    }
    break
  }

  let versionCompatibleArgs: string[]
  if (legacyUpload) {
    const withoutVersion: string[] = []
    let uploadVersion = leadingVersion
    for (let index = 0; index < args.length;) {
      const token = index < optionEnd ? versionToken(index) : undefined
      if (token === undefined) {
        withoutVersion.push(args[index])
        index += 1
      } else {
        uploadVersion = token.value
        index += token.consumed
      }
    }
    versionCompatibleArgs = uploadVersion === true ? ['version'] : withoutVersion
  } else if (leadingVersion === true) {
    versionCompatibleArgs = ['version']
  } else if (leadingVersion === false) {
    versionCompatibleArgs = args.slice(leadingEnd)
  } else {
    versionCompatibleArgs = args
  }

  const normalized: string[] = []
  for (let index = 0; index < versionCompatibleArgs.length; index += 1) {
    const argument = versionCompatibleArgs[index]
    // A descending JSON:API sort starts with `-`, which yargs would otherwise
    // interpret as a cluster of short options. Keep the documented
    // `--sort -created_at` form usable as well as `--sort=-created_at`.
    if (argument === '--sort' && /^-[^-]/.test(versionCompatibleArgs[index + 1] ?? '')) {
      normalized.push(`--sort=${versionCompatibleArgs[index + 1]}`)
      index += 1
    } else {
      normalized.push(argument)
    }
  }
  return normalized
}

function editDistance (a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_value, index) => index)
  for (let i = 1; i <= a.length; i++) {
    let diagonal = previous[0]
    previous[0] = i
    for (let j = 1; j <= b.length; j++) {
      const substitution = diagonal + (a[i - 1] === b[j - 1] ? 0 : 1)
      diagonal = previous[j]
      previous[j] = Math.min(previous[j] + 1, previous[j - 1] + 1, substitution)
    }
  }
  return previous[b.length]
}

// An unknown command embeds the surrounding command index and close matches
// so a caller can self-correct from the error alone, mirroring how
// MISSING_INPUT embeds the full contract.
function unknownCommandError (reason: string, unknownNames: string, args: string[]): CliError {
  const { groupPath, commands: available } = availableCommands(args)
  const attempted = unknownNames.split(', ')
  const suggestions = available
    .filter(candidate => {
      const leaf = candidate.path.split(' ').pop() ?? ''
      return attempted.some(name => editDistance(name, leaf) <= 2 || leaf.includes(name) || name.includes(leaf))
    })
    .map(candidate => candidate.path)
    .slice(0, 3)
  return new CliError('INVALID_INPUT', reason, 2, {
    details: {
      ...(suggestions.length === 0 ? {} : { suggestions }),
      available_commands: available
    },
    hint: groupPath.length === 0
      ? 'Run `poki help` for the command index or `poki help --search TEXT` to search it.'
      : `Run \`poki help ${groupPath.join(' ')}\` for this group's actions.`
  })
}

function clarifyUnknownArguments (message: string, args: string[]): string {
  const match = /^(Unknown arguments?): (.+)$/.exec(message)
  if (match === null) return message

  const names = match[2].split(', ')
  const clarified = names.map(name => {
    const original = args.find(argument => {
      if (!argument.startsWith('-')) return false
      const option = argument.split('=', 1)[0]
      const optionName = option.replace(/^--?(?:no-)?/, '')
      const camelName = optionName.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase())
      return optionName === name || camelName === name
    })
    return original?.split('=', 1)[0] ?? name
  })
  const unique = [...new Set(clarified)]
  return `Unknown argument${unique.length === 1 ? '' : 's'}: ${unique.join(', ')}`
}

// An unknown option embeds the command's declared options and close matches,
// mirroring how unknown commands embed the command index.
function unknownArgumentError (message: string, args: string[]): CliError {
  const clarified = clarifyUnknownArguments(message, args)
  const unknown = /^Unknown arguments?: (.+)$/.exec(clarified)
  const spec = invocationSpec(args)
  const options = (spec?.options ?? []).map(option => option.name)
  if (unknown === null || spec === undefined || options.length === 0) {
    return new CliError('INVALID_INPUT', clarified, 2)
  }
  const attempted = unknown[1].split(', ').map(name => name.replace(/^--?/, ''))
  const suggestions = [...new Set(attempted.flatMap(name => {
    return options.filter(candidate => editDistance(name, candidate.replace(/^--/, '')) <= 2)
  }))].slice(0, 3)
  return new CliError('INVALID_INPUT', clarified, 2, {
    details: {
      ...(suggestions.length === 0 ? {} : { suggestions }),
      available_options: options
    },
    hint: `Run \`poki help ${spec.path.join(' ')}\` for this command's full contract.`
  })
}

function invocationSpec (args: string[]): CommandSpec | undefined {
  return leadingCommandSpec(cliArguments(args))?.spec
}

function permissionDeniedWithCommandContext (error: unknown, args: string[]): unknown {
  if (!(error instanceof CliError) || error.code !== 'PERMISSION_DENIED' || error.status !== 403) return error

  const spec = invocationSpec(args)
  if (spec === undefined) return error

  const command = `poki ${spec.path.join(' ')}`
  const permissionCodes = spec.permission_codes ?? []
  return new CliError(
    'PERMISSION_DENIED',
    `The Poki API denied \`${command}\` because the current credentials do not have permission for this operation or resource scope.`,
    4,
    {
      status: 403,
      details: {
        command,
        permission_codes: permissionCodes,
        permission_requirements: developerPermissionRequirements(permissionCodes),
        ...(spec.permission_logic === undefined ? {} : { permission_logic: spec.permission_logic }),
        api_response: safeApiErrorResponse(error.details)
      },
      retryable: false,
      requestId: error.requestId,
      retryAfter: error.retryAfter,
      hint: `Run \`poki whoami\` to inspect effective CLI permissions and \`poki help ${spec.path.join(' ')}\` to inspect this command. Ownership, team flags, account restrictions, and developer-support grants are evaluated by the backend.`
    }
  )
}

// `version` and `help` cannot come from a command group: their handlers close
// over the raw argv that buildCli was given. Registering them through one
// exported function keeps the parity probe recording the real declarations
// instead of a hand-copied mirror that can drift from this file.
export function registerBuiltinCommands (cli: Argv, args: string[]): Argv {
  return cli
    .command('version', 'Print the poki-cli version', version => version, () => {
      process.stdout.write(`${CLI_VERSION}\n`)
    })
    .command('help [command..]', 'Show help for a command path such as `poki help games create`', help => help
      .positional('command', { describe: 'Nested command path', type: 'string', array: true })
      .option('all', { describe: 'Return a compact manifest for every command', type: 'boolean' })
      .option('full', { describe: 'With --all, include each command\'s complete input schema', type: 'boolean' })
      .option('search', { describe: 'Search command paths, summaries, permissions, and options', type: 'string' })
      .option('format', { describe: 'Structured output encoding', choices: ['toon', 'json'] as const, default: 'toon' }), () => {
      // resolveHelp answers every help invocation before yargs dispatches, so
      // this handler exists for the declaration alone. It still renders the
      // document rather than returning silently: a routing gap must never
      // become an empty successful response on the discovery surface.
      const resolution = resolveHelp(args)
      if (resolution === undefined) throw new CliError('UNEXPECTED_ERROR', 'Help could not be resolved for this invocation.', 5)
      writeStructured(resolution.document, resolution.format)
    })
}

export function registerRootCommands (cli: Argv, api: ApiClient): Argv {
  cli = registerLegacyCommands(cli)
  cli = registerAuthCommands(cli)
  cli = registerAudienceCommands(cli)
  cli = registerDiscoveryCommands(cli, api)
  cli = registerGameCommands(cli, api)
  cli = registerVersionCommands(cli, api)
  cli = registerVersionActivationCommands(cli, api)
  cli = registerPlaytestCommands(cli, api)
  cli = registerPlaytestRequestCommands(cli, api)
  cli = registerPlayerFitTestCommands(cli, api)
  cli = registerReviewCommands(cli, api)
  cli = registerGameChangeRequestCommands(cli, api)
  cli = registerGameEventCommands(cli, api)
  cli = registerPlayerFeedbackQuestionCommands(cli, api)
  cli = registerNetlibLobbyCommands(cli, api)
  return registerDataCommands(cli, api)
}

export function buildCli (args: string[], api = new ApiClient()): Argv {
  let cli = registerBuiltinCommands(yargs(cliArguments(args))
    .scriptName('poki')
    .usage('$0 <command> [options]\n\nManage Poki for Developers resources and analytics with machine-readable API commands.')
    .version(false)
    // resolveHelp answers every help request before yargs; yargs' built-in
    // --help must stay disabled or a value-position --help (`--team --help`)
    // would leak unstructured plain-text usage with exit 0.
    .help(false), args)

  cli = registerRootCommands(cli, api)

  return cli
    .demandCommand(1, 'Choose a command. Run `poki help` to see all commands.')
    .strictCommands()
    .strictOptions()
    // recommendCommands is deliberately absent: its bare "Did you mean X?"
    // message would bypass unknownCommandError, which embeds suggestions AND
    // the command index for self-correction.
    .showHelpOnFail(false)
    .exitProcess(false)
    .fail((message, error) => {
      if (error instanceof CliError) throw error
      // A yargs validation failure arrives with a message; a command handler
      // exception arrives with only the thrown error and must surface as
      // UNEXPECTED_ERROR with exit 5, not as the caller's input mistake.
      const validationMessage = typeof message === 'string' && message !== '' ? message : undefined
      if (validationMessage === undefined && error !== undefined) throw error
      const reason = validationMessage ?? 'Invalid command input.'
      if (/^Missing required arguments?: .*\bgame\b/.test(reason)) {
        const configError = projectConfigError()
        if (configError !== undefined) throw configError
        throw new CliError('INVALID_INPUT', 'A game ID is required and no project game_id is configured.', 2, {
          details: { option: '--game' },
          hint: 'Pass --game GAME_ID, or run `poki init --game GAME_ID` to configure this directory. `poki games list` shows visible game IDs.'
        })
      }
      const unknownCommand = /^Unknown commands?: (.+)$/.exec(reason)
      if (unknownCommand !== null) throw unknownCommandError(reason, unknownCommand[1], args)
      throw unknownArgumentError(reason, args)
    })
}

export async function runCli (args: string[], api?: ApiClient): Promise<number> {
  const updates = new UpdateCoordinator(CLI_VERSION, requestedFormat(args))
  const client = api ?? new ApiClient()
  client.addBeforeFirstRequestHook(updates.beforeFirstRequest)
  try {
    const help = resolveHelp(args)
    if (help !== undefined) {
      writeStructured(help.document, help.format)
      return 0
    }
    await buildCli(args, client).parseAsync()
    await updates.commandSucceeded()
    return 0
  } catch (error) {
    const reportedError = permissionDeniedWithCommandContext(error, args)
    writeError(reportedError, requestedFormat(args))
    return reportedError instanceof CliError ? reportedError.exitCode : 5
  }
}
