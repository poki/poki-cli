import { inputError } from './errors'

export interface ListArguments {
  filter?: string[]
  sort?: string[]
  page?: number
  pageSize?: number
}

const fieldPattern = /^[a-zA-Z0-9_.|]+$/

function parseFilters (filters: string[] | undefined): Array<[string, string]> {
  return (filters ?? []).map(filter => {
    const separator = filter.indexOf('=')
    const field = separator < 0 ? '' : filter.slice(0, separator)
    const value = separator < 0 ? '' : filter.slice(separator + 1)
    if (!fieldPattern.test(field) || value === '') {
      throw inputError(`Invalid filter '${filter}'. Use field=value.`)
    }
    return [field, value]
  })
}

export function listSearchParams (args: ListArguments, extra: Array<[string, string]> = []): URLSearchParams {
  const params = new URLSearchParams()
  for (const [field, value] of [...parseFilters(args.filter), ...extra]) {
    params.append(`filter[${field}]`, value)
  }
  if ((args.sort ?? []).length > 0) params.set('sort', (args.sort ?? []).join(','))
  if (args.page !== undefined) params.set('page[number]', String(args.page))
  if (args.pageSize !== undefined) params.set('page[size]', String(args.pageSize))
  return params
}
