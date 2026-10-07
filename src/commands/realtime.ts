import type { Argv } from 'yargs'

import { ApiClient } from '../api'
import { CliError, inputError } from '../errors'
import { isRecord } from '../json'
import { getProjectGameId } from '../project'
import { render, requestTimeout, withDefaultGameOption, withRequestOptions } from './common'

type RealtimeMetric = 'users' | 'errors' | 'c2p'

function metricId (value: unknown, option: string): string {
  if (typeof value !== 'string' || value.trim() === '' || value.includes(',')) {
    throw inputError(`${option} must contain one non-empty ID.`)
  }
  return value.trim()
}

function isCount (value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function validMetric (metric: RealtimeMetric, value: unknown): boolean {
  if (metric === 'users') return isCount(value)
  if (!Array.isArray(value)) return false
  if (metric === 'errors') return value.every(isCount)
  return value.every(minute => minute === null || (isRecord(minute) && isCount(minute.pageviews) && isCount(minute.gameplays)))
}

async function readMetrics (api: ApiClient, metric: RealtimeMetric, ids: string[], argv: Record<string, unknown>): Promise<void> {
  const response = await api.request({
    service: 'realtime',
    method: metric === 'users' ? 'GET' : 'POST',
    path: metric === 'users' ? `/metrics/playground/${encodeURIComponent(ids[0])}` : `/metrics/${metric}`,
    ...(metric === 'users' ? {} : { body: ids }),
    accept: 'application/json',
    contentType: 'application/json',
    timeoutMs: requestTimeout(argv),
    retrySafe: true
  })
  const body = response.body
  const values = isRecord(body) ? body.metrics : undefined
  if (!isRecord(body) || !isRecord(values) || ids.some(id => !Object.hasOwn(values, id) || !validMetric(metric, values[id])) ||
    (body.retry_in_seconds !== undefined && !isCount(body.retry_in_seconds))) {
    throw new CliError('INVALID_API_RESPONSE', 'The realtime service returned an invalid metrics document.', 5)
  }
  const metrics = Object.fromEntries(ids.map(id => [id, values[id]]))
  render({
    metrics,
    ...(body.retry_in_seconds === undefined ? {} : { retry_in_seconds: body.retry_in_seconds })
  }, argv)
}

export function registerRealtimeCommands (yargs: Argv, api: ApiClient): Argv {
  const projectGameId = getProjectGameId()
  return yargs.command('realtime', 'Read live Playground users, errors, and C2P metrics', realtime => realtime
    .command('users', 'Read the rolling Playground user estimate for one game', users => withDefaultGameOption(withRequestOptions(users), projectGameId), async argv => {
      await readMetrics(api, 'users', [metricId(argv.game, '--game')], argv)
    })
    .command('errors', 'Read per-minute error counts for one or more versions', errors => withRequestOptions(errors)
      .option('version', { describe: 'Version ID; repeat for multiple versions', type: 'array', string: true, nargs: 1, demandOption: true }), async argv => {
      const ids = [...new Set((argv.version as unknown[]).map(value => metricId(value, '--version')))].sort()
      await readMetrics(api, 'errors', ids, argv)
    })
    .command('c2p', 'Read per-minute pageview and converted-pageview counts for one game', c2p => withDefaultGameOption(withRequestOptions(c2p), projectGameId), async argv => {
      await readMetrics(api, 'c2p', [metricId(argv.game, '--game')], argv)
    })
    .demandCommand(1, 'Choose realtime users, errors, or c2p.'), () => {})
}
