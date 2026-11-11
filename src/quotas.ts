import { isRecord } from './json'

export const quotaLimitKeys = [
  'player_fit_game_daily_quota', 'player_fit_team_daily_quota',
  'playtest_game_daily_quota', 'playtest_team_daily_quota', 'webfit_team_active_quota'
] as const

export function safeQuotaMetadata (value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value) || !quotaLimitKeys.some(key => value.limit_key === key)) return undefined
  if (value.scope !== 'game' && value.scope !== 'team') return undefined
  if (typeof value.scope_id !== 'string' || typeof value.unit !== 'string') return undefined

  const result: Record<string, unknown> = {
    limit_key: value.limit_key, scope: value.scope, scope_id: value.scope_id, unit: value.unit
  }

  for (const key of ['limit', 'used', 'remaining', 'requested']) {
    const number = value[key]
    if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 0) return undefined
    result[key] = number
  }

  if (value.resets_at === null || (typeof value.resets_at === 'string' && Number.isFinite(Date.parse(value.resets_at)))) result.resets_at = value.resets_at

  return result
}
