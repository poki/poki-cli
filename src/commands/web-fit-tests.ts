import type { Argv } from 'yargs'

import { ApiClient } from '../api'
import { inputError } from '../errors'
import { getProjectGameId } from '../project'
import { gamePath, mutationPreview, normalizeMutationResponse, render, requestTimeout, requireConfirmation, withGameActionOptions } from './common'

export function registerWebFitTestCommands (yargs: Argv, api: ApiClient): Argv {
  return yargs.command('web-fit-tests', 'Request Web Fit testing', tests => tests
    .command('request', 'Request Web Fit for a game version', request => withGameActionOptions(request, getProjectGameId(), 'Game to test', { destructive: true })
      .option('version', { type: 'string', demandOption: true, describe: 'Version ID to test' })
      .option('golden-ticket', { type: 'boolean', default: false, describe: 'Use the team golden ticket; backend eligibility and cooldown apply' }), async argv => {
      if (argv.version.trim() === '') throw inputError('version must be a non-empty version ID.')
      requireConfirmation(argv, 'Requesting Web Fit testing')
      const path = gamePath(argv.game, '_webfit')
      const body = { version_id: argv.version, golden_ticket: argv.goldenTicket }
      if (mutationPreview('POST', path, body, argv, { destructive: true, sideEffects: ['Requests Web Fit, changes the game testing state and replaces all tracks with this version at 100% public traffic, and notifies the Poki team. A golden-ticket request may consume the team ticket.'] })) return
      const response = await api.request({ method: 'POST', path, body, contentType: 'application/json', timeoutMs: requestTimeout(argv) })
      normalizeMutationResponse(response.body, response.status, 'POST', path, { type: 'games', id: String(argv.game) })
      render(argv.raw === true ? response.body : { data: { game_id: argv.game, version_id: argv.version, requested: true, golden_ticket: argv.goldenTicket }, meta: {} }, argv)
    })
    .demandCommand(1, 'Choose web-fit-tests request.'), () => {})
}
