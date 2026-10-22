import type { Argv } from 'yargs'

import { ApiClient } from '../api'
import { versionActivationsDocumentation } from '../docs/resources'
import { listCapabilities } from '../list-capabilities'
import { getProjectGameId } from '../project'
import { gamePath, listResources, renderList, withDefaultGameOption, withListOptions } from './common'
import { registerResourceDiscovery } from './resource-docs'

export function registerVersionActivationCommands (yargs: Argv, api: ApiClient): Argv {
  const projectGameId = getProjectGameId()

  return yargs.command('version-activations', 'List stored public-version activations', activations => registerResourceDiscovery(activations, versionActivationsDocumentation)
    .command('list', 'List stored activation events in chronological order', list => withDefaultGameOption(withListOptions(list, listCapabilities.versionActivations, 'version-activations'), projectGameId, 'Game whose version activations to list'), async argv => {
      const path = gamePath(argv.game, 'version-activations')
      renderList(await listResources(api, path, argv, listCapabilities.versionActivations), argv, 'version-activations')
    })
    .demandCommand(1, 'Choose version-activations list, fields, or field.'), () => {})
}
