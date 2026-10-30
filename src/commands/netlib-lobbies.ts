import type { Argv } from 'yargs'

import { ApiClient } from '../api'
import { netlibLobbiesDocumentation } from '../docs/resources'
import { listCapabilities } from '../list-capabilities'
import { getProjectGameId } from '../project'
import { gamePath, listResources, renderList, withDefaultGameOption, withListOptions } from './common'
import { registerResourceDiscovery } from './resource-docs'

export function registerNetlibLobbyCommands (yargs: Argv, api: ApiClient): Argv {
  const projectGameId = getProjectGameId()

  return yargs.command('netlib-lobbies', 'List live Netlib lobbies for one developer-owned game', lobbies => registerResourceDiscovery(lobbies, netlibLobbiesDocumentation)
    .command('list', 'List live Netlib lobbies with filters, sorting, and bounded pagination', list => withDefaultGameOption(withListOptions(list, listCapabilities.netlibLobbies, 'netlib-lobbies'), projectGameId, 'Game whose Netlib lobbies to list'), async argv => {
      const path = gamePath(argv.game, 'netlib', 'lobbies')
      renderList(await listResources(api, path, argv, listCapabilities.netlibLobbies), argv, 'netlib-lobbies')
    })
    .demandCommand(1, 'Choose netlib-lobbies list.'), () => {})
}
