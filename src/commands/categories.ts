import type { Argv } from 'yargs'

import { ApiClient } from '../api'
import { CliError } from '../errors'
import { isRecord } from '../json'
import { render, requestTimeout, withRequestOptions } from './common'

export function registerCategoryCommands (yargs: Argv, api: ApiClient): Argv {
  return yargs.command('categories', 'Discover current Poki content categories', categories => categories
    .command('list', 'List current category IDs, titles, and types', list => withRequestOptions(list), async argv => {
      const { body } = await api.request({ path: '/categories', accept: 'application/json', timeoutMs: requestTimeout(argv) })
      if (!Array.isArray(body) || !body.every(category => isRecord(category) &&
        Number.isSafeInteger(category.id) && typeof category.title === 'string' && typeof category.category_type === 'string')) {
        throw new CliError('INVALID_API_RESPONSE', 'The Poki API returned an invalid categories document.', 5)
      }
      const data = body.map(({ id, title, category_type: categoryType }) => ({ id, title, category_type: categoryType }))
      render({ data, meta: { total: data.length } }, argv)
    })
    .demandCommand(1, 'Choose categories list.'), () => {})
}
