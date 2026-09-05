import { inputError } from '../errors'
import { asStrings } from './common'

export const deviceCategories = ['any', 'desktop', 'mobile'] as const
export const audienceOrientations = ['both', 'portrait', 'landscape'] as const

// A category ceiling is one command's product rule, so the command supplies
// both the number and the message rather than this shared module naming a
// command in errors raised for every audience surface.
export interface CategoryLimit {
  max: number
  message: string
}

interface AudienceInputOptions {
  defaults?: boolean
  categoryLimit?: CategoryLimit
}

function categoryIDsValue (value: unknown, limit?: CategoryLimit): string | undefined {
  if (value === undefined) return undefined
  const values = asStrings(value) ?? []
  if (values.some(category => !/^\d+$/.test(category))) {
    throw inputError('--category values must be non-negative integer IDs.')
  }
  if (limit !== undefined && values.length > limit.max) throw inputError(limit.message)
  return values.join(',')
}

export function audienceInputFromFlags (
  argv: Record<string, unknown>,
  options: AudienceInputOptions = {}
): Record<string, unknown> {
  const data: Record<string, unknown> = {}
  if (options.defaults === true || argv.deviceCategory !== undefined) {
    data.device_category = argv.deviceCategory ?? 'any'
  }
  if (options.defaults === true || argv.orientation !== undefined) {
    data.orientation = argv.orientation ?? 'both'
  }
  const categories = categoryIDsValue(argv.category, options.categoryLimit)
  if (options.defaults === true || categories !== undefined) {
    data.categories = categories ?? ''
  }
  return data
}

export function applyAudienceInputDefaults (data: Record<string, unknown>): void {
  data.device_category ??= 'any'
  data.orientation ??= 'both'
  data.categories ??= ''
}

export function validateAudienceInput (
  data: Record<string, unknown>,
  options: Pick<AudienceInputOptions, 'categoryLimit'> = {}
): void {
  if (typeof data.device_category !== 'string' || !deviceCategories.includes(data.device_category as typeof deviceCategories[number])) {
    throw inputError('device_category must be any, desktop, or mobile.')
  }
  if (typeof data.orientation !== 'string' || !audienceOrientations.includes(data.orientation as typeof audienceOrientations[number])) {
    throw inputError('orientation must be both, portrait, or landscape.')
  }
  if (typeof data.categories !== 'string' || (data.categories !== '' && !/^\d+(,\d+)*$/.test(data.categories))) {
    throw inputError('categories must be a comma-separated list of integer IDs.')
  }
  const limit = options.categoryLimit
  if (limit !== undefined && data.categories !== '' && data.categories.split(',').length > limit.max) {
    throw inputError(limit.message)
  }
}
