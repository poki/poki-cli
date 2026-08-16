import type { Argv } from 'yargs'

import { ApiClient } from '../api'
import { getAuthStatus } from '../auth'
import { readProjectConfigContext } from '../project'
import { CLI_VERSION } from '../version'
import { getResource, render, withFormatOption, withOutputOptions } from './common'

export function registerDiscoveryCommands (yargs: Argv, api: ApiClient): Argv {
  return yargs
    .command('context', 'Describe the effective local project, API, CLI, and authentication context without contacting the API', context => withFormatOption(context), argv => {
      const project = readProjectConfigContext()
      const auth = getAuthStatus()
      const hints: string[] = []
      if (project.config.game_id === undefined || project.config.game_id === '') {
        hints.push('No project game configured. Run `poki init --game GAME_ID` here, or pass --game to game-scoped commands.')
      }
      if (!auth.authenticated) {
        hints.push('Not authenticated. Run `poki auth login` (opens a browser and needs a human to complete sign-in).')
      }
      render({
        project: {
          source: project.source,
          path: project.path ?? null,
          game_id: project.config.game_id ?? null,
          build_dir: project.config.build_dir ?? null
        },
        api: { base_url: api.baseUrl, timeout_ms: api.timeoutMs },
        cli: { version: CLI_VERSION },
        auth,
        offline: true,
        ...(hints.length === 0 ? {} : { hints })
      }, argv)
    })
    .command('whoami', 'Return the authenticated Poki for Developers user, team relationship, and exact permission identifiers', whoami => withOutputOptions(whoami), async argv => {
      render(await getResource(api, '/users/@me', argv, { type: 'users' }, 'current-user read'), argv)
    })
}
