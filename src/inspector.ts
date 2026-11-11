import { CliError, safeApiErrorResponse } from './errors'
import { isRecord } from './json'
import { DEFAULT_UPLOAD_TIMEOUT_MS, timeoutMillisecondsOrDefault } from './timeouts'
import { CLI_USER_AGENT } from './version'

// The Inspector frontend currently uses the production API for every upload.
// Keep this pair together rather than selecting an API the frontend cannot read.
export const INSPECTOR_API_URL = 'https://inspector-api.poki.io'
export const INSPECTOR_URL = 'https://inspector.poki.dev/'
export const MAX_INSPECTOR_UPLOAD_BYTES = 1024 * 1024 * 1024

interface InspectorBuild {
  id: string
  urn: string
  inspector_url: string
  url: string
  root_folder?: string
  size?: number
}

function buildIdentity (id: string): { id: string, urn: string, inspector_url: string } {
  const urn = `upload-${id}`
  const link = new URL(INSPECTOR_URL)
  link.searchParams.set('game', urn)
  return { id, urn, inspector_url: link.toString() }
}

function validHostedUrl (value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.username === '' && url.password === ''
  } catch {
    return false
  }
}

export class InspectorClient {
  readonly uploadTimeoutMs: number

  constructor (
    readonly baseUrl = INSPECTOR_API_URL,
    private readonly transport: typeof globalThis.fetch = globalThis.fetch
  ) {
    this.uploadTimeoutMs = timeoutMillisecondsOrDefault(process.env.POKI_API_TIMEOUT_MS, DEFAULT_UPLOAD_TIMEOUT_MS)
  }

  async upload (form: FormData, timeoutMs = this.uploadTimeoutMs): Promise<{ data: InspectorBuild, raw: Record<string, unknown> }> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    const unknownOutcomeHint = 'The upload may have completed, but its ID is unknown. Inspector has no upload-list or idempotency API. Do not retry automatically; a new upload creates another build.'
    try {
      const response = await this.transport(new URL('/v0/builds', this.baseUrl), {
        method: 'POST',
        headers: { Accept: 'application/json', 'User-Agent': CLI_USER_AGENT },
        body: form,
        redirect: 'manual',
        signal: controller.signal
      })
      const text = await response.text()
      let body: unknown
      try { body = JSON.parse(text) } catch {}
      const requestId = response.headers.get('x-request-id') ?? response.headers.get('x-cloud-trace-context') ?? undefined
      if (response.status < 200 || response.status >= 300) {
        const details = safeApiErrorResponse(body)
        const first = details.errors?.[0]
        const knownCode = ['invalid-zip-file', 'file-too-large', 'file-transfer-failed'].includes(first?.code ?? '')
        throw new CliError(knownCode ? String(first?.code).replaceAll('-', '_').toUpperCase() : `HTTP_${response.status}`,
          first?.detail ?? first?.title ?? `Inspector upload failed with status ${response.status}.`, response.status >= 500 ? 5 : 4, {
            status: response.status,
            details,
            requestId,
            retryAfter: response.headers.get('retry-after') ?? undefined,
            hint: response.status >= 500 || response.status < 400 || response.status === 408
              ? unknownOutcomeHint
              : 'Correct the rejected request before uploading again. Inspector does not use developer OAuth credentials.'
          })
      }

      const identity = isRecord(body) && typeof body.id === 'string' && /^[0-9a-v]{20}$/.test(body.id)
        ? buildIdentity(body.id)
        : undefined
      if (!isRecord(body) || identity === undefined || !validHostedUrl(body.url) ||
        (body.root_folder !== undefined && typeof body.root_folder !== 'string') ||
        (body.size !== undefined && (typeof body.size !== 'number' || !Number.isSafeInteger(body.size) || body.size < 0))) {
        throw new CliError('INVALID_API_RESPONSE', 'The successful Inspector upload response did not contain a valid build.', 5, {
          status: response.status,
          requestId,
          details: identity === undefined ? { upload_outcome: 'unknown' } : { created: identity },
          hint: identity === undefined ? unknownOutcomeHint : 'Do not upload again. Open details.created.inspector_url to inspect the uploaded build.'
        })
      }
      return {
        data: {
          ...identity,
          url: body.url,
          ...(typeof body.root_folder === 'string' ? { root_folder: body.root_folder } : {}),
          ...(typeof body.size === 'number' ? { size: body.size } : {})
        },
        raw: body
      }
    } catch (error) {
      if (error instanceof CliError) throw error
      if (controller.signal.aborted) {
        throw new CliError('API_TIMEOUT', `The Inspector upload exceeded ${timeoutMs} ms.`, 5, {
          details: { timeout_ms: timeoutMs }, hint: unknownOutcomeHint
        })
      }
      throw new CliError('NETWORK_ERROR', 'Could not complete the Inspector upload.', 5, { hint: unknownOutcomeHint })
    } finally {
      clearTimeout(timeout)
    }
  }
}
