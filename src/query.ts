import { inputError } from './errors'
import { ListCapabilities } from './list-capabilities'

export interface ListArguments {
  filter?: string[]
  sort?: string[]
  page?: number
  pageSize?: number
}

const fieldPattern = /^[a-zA-Z0-9_.]+(?:\|[a-zA-Z0-9_.]+)*$/

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

// The API splits comma-separated alternatives and treats colons as operators.
// Validate that grammar before forwarding it so values cannot silently disappear.
export function validateListQuery (args: ListArguments, capabilities: ListCapabilities): void {
  const grouped = new Map<string, string[]>()
  for (const [field, value] of parseFilters(args.filter)) {
    const fields = field.split('|')
    if (capabilities.filterFields !== undefined && fields.some(name => capabilities.filterFields?.includes(name) !== true)) {
      throw inputError(`Unsupported filter field '${field}'.`, { allowed_fields: capabilities.filterFields })
    }
    if (fields.length > 1 && fields.some(name => ['track', 'gameplay.device_category'].includes(name))) {
      throw inputError('track and gameplay.device_category must be filtered separately.')
    }
    grouped.set(field, [...(grouped.get(field) ?? []), ...value.split(',')])
  }
  for (const [field, values] of grouped) {
    const firstOperator = values[0].split(':')[0]
    const groupedOperator = firstOperator === 'not_in' && values[0].includes(':')
    for (const [index, value] of values.entries()) {
      if (field === 'track' && !['public', ':public', 'not:public'].includes(value)) {
        throw inputError('Only the public track filter is supported. Use track=public or track=not:public.')
      }
      const parts = value.split(':')
      const operator = parts.length > 1 ? parts[0] : ''
      if (operator === 'full_like') {
        throw inputError('full_like is not supported by this endpoint; its fields do not have full-text indexes.')
      }
      const operandCount = parts.length - 1
      const supported = ['', 'not', 'less', 'before', 'greater', 'after', 'between', 'not_in']
      const specialAllowed = field === 'track' ? ['', 'not'] : field === 'gameplay.device_category' ? [''] : supported
      const validOperands = parts.length === 1 || (operandCount === (operator === 'between' ? 2 : 1) && parts.slice(1).every(part => part.trim() !== '') &&
        !(operator === 'between' && parts[2] === 'null'))
      const valid = value.trim() !== '' && specialAllowed.includes(operator) &&
        !(field === 'gameplay.device_category' && parts.length > 1) &&
        !(groupedOperator && index > 0 && parts.length > 1) &&
        !(operator === 'not_in' && index > 0) &&
        validOperands
      if (!valid) {
        throw inputError(`Invalid filter value '${value}' for '${field}'. Colons are reserved for supported filter operators; literal colon-containing values cannot be used here.`)
      }
    }
  }
  for (const field of (args.sort ?? []).flatMap(value => value.split(','))) {
    const name = field.startsWith('-') ? field.slice(1) : field
    if (!/^[a-zA-Z0-9_]+$/.test(name) || (capabilities.sortFields !== undefined && !capabilities.sortFields.includes(name))) {
      throw inputError(`Unsupported sort field '${field}'.`, { allowed_fields: capabilities.sortFields })
    }
  }
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
