import type { Argv } from 'yargs'

import { ApiClient } from '../api'
import { inputError } from '../errors'
import { isRecord } from '../json'
import { getProjectGameId } from '../project'
import { getResource, readExpectedResource, render, withOutputOptions } from './common'

export function registerLimitCommands (yargs: Argv, api: ApiClient): Argv {
  return yargs.command('limits', 'Inspect testing limits and current usage', limits => limits
    .command('get', 'Read current game/team testing limits and remaining capacity', get => withOutputOptions(get)
      .option('game', { type: 'string', describe: 'Game ID; otherwise uses the project game when no team is supplied' })
      .option('team', { type: 'string', describe: 'Team ID; mutually exclusive with game' })
      .conflicts('game', 'team'), async argv => {
      const game = argv.game ?? (argv.team === undefined ? getProjectGameId() : undefined)
      let team = argv.team
      if (game === undefined && team === undefined) {
        const me = await readExpectedResource(api, '/users/@me', argv, { type: 'users' }, 'current user')
        const relation = me.normalized.team
        team = typeof me.normalized.team_id === 'string'
          ? me.normalized.team_id
          : isRecord(relation) && typeof relation.id === 'string' ? relation.id : undefined
        if (team === undefined) throw inputError('No project game or current team is available. Supply --game or --team.')
      }
      const id = game ?? team
      if (id === undefined || id.trim() === '') throw inputError('A non-empty game or team ID is required.')
      const path = `/${game === undefined ? 'teams' : 'games'}/${encodeURIComponent(id)}/@quota`
      render(await getResource(api, path, argv, { type: 'quotas', id }, 'testing limits'), argv)
    })
    .demandCommand(1, 'Choose limits get.'), () => {})
}
