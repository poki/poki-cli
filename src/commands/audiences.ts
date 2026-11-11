import type { Argv } from 'yargs'

import { audienceCatalog } from '../audiences'
import { render, withFormatOption } from './common'

export function registerAudienceCommands (yargs: Argv): Argv {
  return yargs.command('audiences', 'Discover bundled Poki content-category names and IDs without API access', audiences => audiences
    .command('list', 'List bundled content-category names, IDs, and testing availability', list => withFormatOption(list)
      .option('testing-only', {
        describe: 'Return only categories enabled for Playtest and Player Fit targeting',
        type: 'boolean',
        default: false
      }), argv => {
      const data = argv.testingOnly
        ? audienceCatalog.filter(audience => audience.enabled_for_testing)
        : audienceCatalog
      render({
        data,
        meta: {
          total: data.length,
          testing_only: argv.testingOnly,
          bundled_snapshot: true,
          snapshot_advisory: true,
          mutation_backend_authoritative: true,
          refresh_requires_cli_update: true,
          usage: {
            games: '--suggested-category NAME',
            playtest_requests: '--category ID',
            player_fit_tests: '--category ID'
          }
        }
      }, argv)
    })
    .demandCommand(1, 'Choose audiences list.'), () => {})
}
