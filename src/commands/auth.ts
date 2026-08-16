import type { Argv } from 'yargs'

import { getAuthStatus, login, logoutStoredAuth } from '../auth'
import { inputError } from '../errors'
import { withFormatOption } from './common'
import { structuredFormat, writeStructured } from '../output'

export function registerAuthCommands (yargs: Argv): Argv {
  return yargs.command('auth', 'Manage the OAuth credentials used by Poki API commands', auth => auth
    .command('login', 'Open the Poki sign-in flow and save OAuth credentials', loginCommand => withFormatOption(loginCommand), async argv => {
      await login(message => process.stderr.write(`${message}\n`))
      writeStructured(getAuthStatus(), structuredFormat(argv.format))
    })
    .command('status', 'Describe saved authentication without printing any token', status => withFormatOption(status), argv => {
      writeStructured(getAuthStatus(), structuredFormat(argv.format))
    })
    .command('logout', 'Remove saved OAuth credentials from this computer', logout => withFormatOption(logout)
      .option('dry-run', {
        describe: 'Preview the credential-file deletion without changing it',
        type: 'boolean',
        default: false
      })
      .option('yes', {
        describe: 'Confirm deletion of the saved credential file',
        type: 'boolean',
        default: false
      }), argv => {
      if (argv.dryRun) {
        writeStructured({ operation: 'delete_saved_oauth_credentials', dry_run: true }, structuredFormat(argv.format))
        return
      }
      if (!argv.yes) throw inputError('Deleting saved OAuth credentials requires --yes. Use --dry-run to preview it.')
      writeStructured({ logged_out: logoutStoredAuth() }, structuredFormat(argv.format))
    })
    .demandCommand(1, 'Choose auth login, auth status, or auth logout.'), () => {})
}
