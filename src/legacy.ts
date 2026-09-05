import { existsSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'fs'
import type { Argv } from 'yargs'

import { Config } from './config'
import { AUTH_LOGIN_USER_ACTION_HINT, CliError, registerInterruptCleanup } from './errors'
import { structuredFormat, writeStructured } from './output'
import { LegacyUploadError, postToP4D } from './p4d'
import { createZip } from './zipfile'

export function uploadFilename (now = new Date()): string {
  return `${new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().split('.')[0].replace('T', '-').replace(/:/g, '')}.zip`
}

// src/project.ts reads poki.json as UTF-8, so writing it as ASCII would mangle
// every non-ASCII build_dir into bytes no reader can resolve while the success
// document still echoed the value the caller supplied. The 0.1.x encoding was
// an artifact, not a compatibility invariant: an ASCII poki.json is byte-identical
// either way.
export function initializeProject (gameId: string, buildDir: string): void {
  writeFileSync('poki.json', JSON.stringify({
    game_id: gameId,
    build_dir: buildDir
  }, null, 2) + '\n', 'utf8')
}

export function uploadSuccessText (data: { id: string | number, game_id: string }): string {
  return `
Version uploaded successfully

Your build is still processing, once that is done the following links will be available:
  Inspector: https://inspector.poki.dev/?game=poki-${data.id}
  Preview: https://poki.com/en/preview/${data.game_id}/${data.id}
`
}

// The original upload command treated malformed or missing poki.json as a
// reason to try package.json#poki. Keep that behavior isolated from the newer
// project reader, whose fail-closed parsing is intentional for every new
// command.
export function readLegacyProjectConfig (): Config {
  let config: Config = {}
  try {
    // Read as UTF-8 to agree with the writer above and with src/project.ts.
    // 'ascii' strips the high bit, so a correctly encoded poki.json produced by
    // this command, by hand, or by another tool decoded to mojibake here while
    // the modern reader resolved it correctly.
    config = JSON.parse(readFileSync('poki.json', 'utf8')) as Config
  } catch (ignore) {
    try {
      const packagejson = JSON.parse(readFileSync('package.json', 'utf8')) as { poki?: unknown }
      if (typeof packagejson.poki === 'object' && packagejson.poki !== null) {
        config = packagejson.poki as Config
      }
    } catch (ignore) {}
  }
  return config
}

type LegacyPost = (
  gameId: string,
  filename: string,
  name: string,
  notes: string | undefined,
  makePublic: boolean,
  disableImageCompression: boolean
) => Promise<{ id: string | number, game_id: string }>

function uploadNotes (notes: string | undefined): string {
  return ((notes ?? '') + '\n\nUploaded using poki-cli').trim()
}

// The raw archive failure has already been written to stderr, where the 0.1.x
// command left it. This is the machine-readable half a pipeline can act on.
function legacyArchiveFailure (buildDir: string): CliError {
  return new CliError('INVALID_INPUT', `Could not create the upload archive from '${buildDir}'.`, 2, {
    details: { build_dir: buildDir },
    hint: 'Check that the build directory exists and that the current directory is writable. The underlying failure is reported above this document.'
  })
}

// Legacy upload failures are mutation failures: the request may already have
// been accepted, so none of them is retryable and every one points at an
// inspection command first. Backend response text stays on stderr above rather
// than entering the structured document, matching every other public error.
function legacyUploadFailure (error: unknown): CliError {
  const legacy = error instanceof LegacyUploadError ? error : undefined
  const status = legacy?.statusCode
  const inspect = 'The upload may already have been accepted. Run `poki versions list` to check before uploading again.'

  if (legacy?.kind === 'timeout') {
    return new CliError('API_TIMEOUT', 'The legacy upload request timed out before the Poki API responded.', 5, {
      retryable: false,
      hint: `${inspect} POKI_API_TIMEOUT_MS raises the inactivity deadline.`
    })
  }

  if (legacy?.kind === 'response' && status !== undefined) {
    if (status === 401) {
      return new CliError('AUTH_REQUIRED', 'The Poki API rejected the legacy upload credentials.', 3, {
        status,
        retryable: false,
        hint: `${AUTH_LOGIN_USER_ACTION_HINT} Alternatively, the developer can configure POKI_UPLOAD_TOKEN in their own environment. Then upload again.`
      })
    }
    // A 2xx the CLI could not read means the version was created. Reporting it
    // as a rejected upload would invite a duplicate build.
    if (status >= 200 && status < 300) {
      return new CliError('INVALID_API_RESPONSE', 'The legacy upload was accepted but the Poki API response could not be read.', 5, {
        status,
        retryable: false,
        hint: 'The version was created. Run `poki versions list` to identify it and do not upload the build again.'
      })
    }
    return new CliError(`HTTP_${String(status)}`, `The Poki API rejected the legacy upload with status ${String(status)}.`, status >= 500 ? 5 : 4, {
      status,
      retryable: false,
      hint: inspect
    })
  }

  return new CliError('NETWORK_ERROR', 'Could not complete the legacy upload request to the Poki API.', 5, {
    retryable: false,
    hint: inspect
  })
}

export async function legacyHumanUpload (
  gameId: string,
  buildDir: string,
  filename: string,
  name: string,
  notes: string | undefined,
  makePublic: boolean,
  disableImageCompression: boolean,
  post: LegacyPost = postToP4D
): Promise<void> {
  // Before the LLM-facing command expansion, upload created its timestamped
  // archive in the current directory and completed successfully however it
  // failed, so a pipeline could not tell a published build from a lost one.
  // The human presentation below is unchanged; the exit status is not.
  // An interrupt never reaches the unlink below, and the archive lands in the
  // project directory where the next --build-dir . run would package it.
  const removeArchiveOnInterrupt = registerInterruptCleanup(() => { rmSync(filename, { force: true }) })
  try {
    try {
      await createZip(filename, buildDir)
    } catch (error) {
      // createZip removes its own partial output, so the absent archive and
      // this line remain the human signal that no build was produced.
      console.error(error)
      throw legacyArchiveFailure(buildDir)
    }

    let failure: unknown
    try {
      const data = await post(gameId, filename, name, uploadNotes(notes), makePublic, disableImageCompression)
      console.log(uploadSuccessText(data))
    } catch (error) {
      console.error(error)
      failure = error
    }

    // The archive is removed after either outcome, exactly as before.
    unlinkSync(filename)
    if (failure !== undefined) throw legacyUploadFailure(failure)
  } finally {
    removeArchiveOnInterrupt()
  }
}

export function registerLegacyCommands (yargs: Argv): Argv {
  const config = readLegacyProjectConfig()
  const projectGameId = typeof config.game_id === 'string' && config.game_id.trim() !== ''
    ? config.game_id
    : undefined
  const filename = uploadFilename()

  return yargs
    .command('init', 'Create a poki.json configuration file', init => init
      .option('game', {
        alias: 'g',
        describe: 'Poki for Developers game ID',
        demandOption: true,
        type: 'string'
      })
      .option('build-dir', {
        alias: 'b',
        describe: 'Directory to upload',
        default: 'dist',
        type: 'string'
      })
      .option('force', {
        describe: 'Replace an existing poki.json file',
        default: false,
        type: 'boolean'
      })
      .option('format', {
        describe: 'Structured result encoding',
        choices: ['toon', 'json'] as const,
        default: 'toon'
      }), argv => {
      if (existsSync('poki.json') && !argv.force) {
        throw new CliError('INVALID_INPUT', 'poki.json already exists. Pass --force to replace it.', 2, {
          details: { path: 'poki.json', confirmation_flag: '--force' }
        })
      }
      initializeProject(argv.game, argv.buildDir)
      writeStructured({ created: true, path: 'poki.json', game_id: argv.game, build_dir: argv.buildDir }, structuredFormat(argv.format))
    })
    .command('upload', 'Deprecated human upload; use `poki versions upload` for structured output', upload => upload
      .option('game', {
        alias: 'g',
        describe: 'Poki for Developers game ID',
        demandOption: projectGameId === undefined,
        ...(projectGameId === undefined ? {} : { default: projectGameId }),
        type: 'string'
      })
      .option('build-dir', {
        alias: 'b',
        describe: 'Directory to upload; existing empty directories are allowed for legacy compatibility',
        default: config.build_dir ?? 'dist',
        type: 'string'
      })
      .option('name', {
        alias: 'n',
        describe: 'Version name',
        default: filename,
        type: 'string'
      })
      .option('notes', {
        alias: 'o',
        describe: 'Version notes',
        type: 'string'
      })
      .option('make-public', {
        alias: 'l',
        describe: 'Make version public after upload',
        default: false,
        type: 'boolean'
      })
      .option('disable-image-compression', {
        alias: 'i',
        describe: 'Disable image compression',
        default: false,
        type: 'boolean'
      })
      .check(argv => {
        if (typeof argv.game !== 'string' || argv.game.trim() === '') {
          throw new CliError('INVALID_INPUT', 'A game ID is required and no project game_id is configured.', 2, {
            details: { option: '--game' },
            hint: 'Pass --game GAME_ID, or run `poki init --game GAME_ID` to configure this directory. `poki games list` shows visible game IDs.'
          })
        }
        return true
      }), async argv => {
      // The historical entry point logged every failure and still completed
      // successfully, which made a failed upload indistinguishable from a
      // published one in any pipeline. Failures now reach the process boundary
      // like every other command's and carry a documented exit code; the human
      // detail legacyHumanUpload writes to stderr is unchanged.
      await legacyHumanUpload(
        String(argv.game).trim(),
        argv.buildDir,
        filename,
        argv.name,
        argv.notes,
        argv.makePublic,
        argv.disableImageCompression
      )
    })
}
