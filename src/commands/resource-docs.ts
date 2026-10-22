import type { Argv } from 'yargs'

import { withFormatOption } from './common'
import { ResourceDocumentation, resourceFieldDetails, resourceFieldIndex } from '../docs/resources'
import { inputError } from '../errors'
import { structuredFormat, writeStructured } from '../output'
import { RESOURCE_API_TIME_ZONE } from '../timezones'

export function registerResourceDiscovery (yargs: Argv, documentation: ResourceDocumentation): Argv {
  return yargs
    .command('fields', `List the documented ${documentation.resource} fields`, fields => withFormatOption(fields), argv => {
      const fields = resourceFieldIndex(documentation)
      writeStructured({
        data: {
          resource: documentation.resource,
          fields,
          references: documentation.references
        },
        meta: { total: fields.length, timestamp_time_zone: RESOURCE_API_TIME_ZONE }
      }, structuredFormat(argv.format))
    })
    .command('field <name>', `Describe one ${documentation.resource} field`, field => withFormatOption(field)
      .positional('name', {
        describe: 'Exact field name returned by the fields command',
        type: 'string',
        demandOption: true
      }), argv => {
      const details = resourceFieldDetails(documentation, argv.name)
      if (details === undefined) {
        throw inputError(`Unknown ${documentation.resource} field '${argv.name}'.`, {
          available_fields: documentation.fields.map(field => field.name)
        })
      }
      writeStructured({ data: details, meta: {} }, structuredFormat(argv.format))
    })
}
