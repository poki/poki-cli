import { decodeBearerCredentials, readStoredAuth, refreshStoredAuth } from './auth'
import { Config } from './config'
import { authRequired, AUTH_REQUIRED_HINT, CliError, safeApiErrorResponse } from './errors'
import { serviceEnvironment } from './service-environment'
import { DEFAULT_DOWNLOAD_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS, DEFAULT_UPLOAD_TIMEOUT_MS, timeoutMillisecondsOrDefault } from './timeouts'
import { CLI_USER_AGENT } from './version'

export type ResponseType = 'json' | 'text'

export interface ApiRequest {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  path: string
  query?: URLSearchParams
  body?: unknown
  contentType?: string
  accept?: string
  responseType?: ResponseType
  rawBody?: BodyInit
  timeoutMs?: number
  // Marks a non-GET request whose failure is safe to retry (the read-only
  // analytics POST /_data); timeout and network errors key retryable off this
  // in addition to the HTTP method.
  retrySafe?: boolean
}

export interface ApiResponse<T = unknown> {
  status: number
  headers: Headers
  body: T
}

export interface ApiClientDependencies {
  fetch: typeof globalThis.fetch
  readAuth: () => Config | undefined
  refreshAuth: (config: Config) => Promise<Config>
  beforeFirstRequest: () => Promise<void>
}

export function apiResponseError (status: number, body: unknown, headers: Headers, request: ApiRequest): CliError {
  const safeDetails = safeApiErrorResponse(body)
  const firstError = safeDetails.errors?.[0]
  const firstErrorCode = firstError?.code
  const firstErrorDetail = firstError?.detail
  const firstErrorTitle = firstError?.title
  const message = firstErrorDetail ?? firstErrorTitle ?? `Poki API request failed with status ${status}.`
  // Only the reviewed JSON:API errors array contributes a public code or
  // message. Legacy top-level error/message fields are arbitrary backend
  // payload and therefore collapse to the stable HTTP status contract.
  const sourceCode = firstErrorCode ?? `HTTP_${status}`
  const normalizedCode = sourceCode.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase()
  const explicitPermissionDenied = status === 403 && firstErrorCode === 'permission-denied'
  const code = explicitPermissionDenied
    ? 'PERMISSION_DENIED'
    : normalizedCode === '' || normalizedCode === 'PERMISSION_DENIED'
      ? `HTTP_${status}`
      : normalizedCode
  const method = request.method ?? 'GET'
  const retrySafe = method === 'GET' || request.retrySafe === true
  const transient = status === 408 || status === 429 || status >= 500
  const redirect = status >= 300 && status < 400
  return new CliError(code, message, status === 401 ? 3 : status >= 500 ? 5 : 4, {
    status,
    ...(Object.keys(safeDetails).length === 0 ? {} : { details: safeDetails }),
    retryable: transient && retrySafe,
    requestId: headers.get('x-request-id') ?? headers.get('x-cloud-trace-context') ?? undefined,
    retryAfter: headers.get('retry-after') ?? undefined,
    ...(status === 401
      ? { hint: AUTH_REQUIRED_HINT }
      : (transient || redirect) && !retrySafe
          ? { hint: `The ${method} outcome may be unknown. Read the resource state before deciding whether to retry this mutation.` }
          : {})
  })
}

export class ApiClient {
  readonly baseUrl: string
  private readonly transport: typeof globalThis.fetch
  private readonly readAuth: () => Config | undefined
  private readonly refreshAuth: (config: Config) => Promise<Config>
  private inMemoryAuth: Config | undefined
  private beforeFirstRequest: (() => Promise<void>) | undefined
  private firstRequestPreparation: Promise<void> | undefined
  readonly timeoutMs: number
  readonly uploadTimeoutMs: number
  readonly downloadTimeoutMs: number

  constructor (
    baseUrl = serviceEnvironment().apiUrl,
    dependencies: Partial<ApiClientDependencies> = {}
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, '')
    this.transport = dependencies.fetch ?? globalThis.fetch
    this.readAuth = dependencies.readAuth ?? readStoredAuth
    this.refreshAuth = dependencies.refreshAuth ?? refreshStoredAuth
    this.beforeFirstRequest = dependencies.beforeFirstRequest
    this.timeoutMs = timeoutMillisecondsOrDefault(process.env.POKI_API_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS)
    // Multipart build and asset uploads legitimately take longer than API
    // reads; a 30 s ceiling would abort ordinary multi-megabyte uploads.
    this.uploadTimeoutMs = timeoutMillisecondsOrDefault(process.env.POKI_API_TIMEOUT_MS, DEFAULT_UPLOAD_TIMEOUT_MS)
    // One deadline covers connect, headers, and the complete streamed archive,
    // and a failed transfer discards every byte already written, so signed
    // downloads need the same headroom as the uploads they mirror.
    this.downloadTimeoutMs = timeoutMillisecondsOrDefault(process.env.POKI_API_TIMEOUT_MS, DEFAULT_DOWNLOAD_TIMEOUT_MS)
  }

  addBeforeFirstRequestHook (hook: () => Promise<void>): void {
    const previous = this.beforeFirstRequest
    this.beforeFirstRequest = previous === undefined
      ? hook
      : async () => {
        await previous()
        await hook()
      }
  }

  async request<T = unknown> (request: ApiRequest): Promise<ApiResponse<T>> {
    const config = this.inMemoryAuth ?? decodeBearerCredentials(this.readAuth())
    if (config?.access_token === undefined) {
      throw authRequired()
    }
    this.inMemoryAuth = config

    let response = await this.execute<T>(request, config.access_token)
    if (response.status === 401) {
      if (config.refresh_token !== undefined) {
        try {
          const refreshed = decodeBearerCredentials(await this.refreshAuth(config))
          if (refreshed?.access_token === undefined) {
            throw authRequired('Authentication expired and could not be refreshed.')
          }
          // Keep a successfully refreshed token usable for every later request
          // in this invocation even when the credential file cannot be updated.
          this.inMemoryAuth = refreshed
          // A 401 rejection happens before the server executes the request,
          // so replaying a mutation once after a refresh cannot double-apply.
          response = await this.execute<T>(request, refreshed.access_token)
        } catch (error) {
          if (error instanceof CliError) throw error
          throw authRequired('Authentication expired and could not be refreshed.')
        }
      }
      if (response.status === 401) throw authRequired('Authentication was rejected by the Poki API.')
    }

    if (response.status < 200 || response.status >= 300) {
      throw apiResponseError(response.status, response.body, response.headers, request)
    }
    return response
  }

  resolveExternalLocation (location: string): string {
    return this.externalUrl(location, this.baseUrl).toString()
  }

  // The configured API origin is the complete authenticated transport boundary,
  // so which origins the CLI will contact is decided in exactly one place.
  // Copies of this rule in the request path and in pagination could disagree.
  isApiOrigin (url: URL): boolean {
    return url.origin === new URL(this.baseUrl).origin
  }

  // Resolves the path or absolute link an API request or a followed pagination
  // link names, and refuses anything outside the configured origin.
  resolveApiUrl (path: string, query?: URLSearchParams): URL {
    const url = /^https?:\/\//.test(path)
      ? new URL(path)
      : new URL(this.baseUrl + (path.startsWith('/') ? path : `/${path}`))
    if (!this.isApiOrigin(url)) {
      throw new CliError('INVALID_API_RESPONSE', 'The Poki API returned a pagination link for another origin.', 5, {
        details: { expected: 'configured_api_origin', received_kind: 'different_origin' }
      })
    }
    if (query !== undefined) url.search = query.toString()
    return url
  }

  async downloadExternal<T> (
    location: string,
    consumeBody: (body: ReadableStream<Uint8Array> | null) => Promise<T>,
    timeoutMs = this.downloadTimeoutMs
  ): Promise<ApiResponse<T>> {
    const url = this.externalUrl(location)

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await this.transport(url, {
        method: 'GET',
        headers: { Accept: 'application/octet-stream', 'User-Agent': CLI_USER_AGENT },
        signal: controller.signal
      })

      if (response.status < 200 || response.status >= 300) {
        // Do not leave a failed signed response streaming after the public HTTP
        // error has been classified or let it outlive the request deadline.
        controller.abort()
        try {
          await response.body?.cancel()
        } catch {
          // Preserve the public signed-download error below.
        }
        throw new CliError(`HTTP_${response.status}`, `Signed download failed with status ${response.status}.`, response.status >= 500 ? 5 : 4, {
          status: response.status,
          retryable: response.status === 408 || response.status === 429 || response.status >= 500,
          requestId: response.headers.get('x-request-id') ?? undefined,
          retryAfter: response.headers.get('retry-after') ?? undefined
        })
      }

      const body = await consumeBody(response.body)
      return {
        status: response.status,
        headers: response.headers,
        body
      }
    } catch (error) {
      if (error instanceof CliError) throw error
      if (controller.signal.aborted) {
        throw new CliError('API_TIMEOUT', `The signed download request exceeded ${timeoutMs} ms.`, 5, {
          details: { timeout_ms: timeoutMs },
          retryable: true,
          hint: 'Request a new signed URL, then retry the download or increase --timeout-ms.'
        })
      }
      throw new CliError('NETWORK_ERROR', 'Could not reach the signed download location.', 5, {
        retryable: true
      })
    } finally {
      clearTimeout(timeout)
    }
  }

  private externalUrl (location: string, base?: string): URL {
    let url: URL
    try {
      url = base === undefined ? new URL(location) : new URL(location, base)
    } catch {
      throw new CliError('INVALID_API_RESPONSE', 'The Poki API returned an invalid download URL.', 5, {
        details: {
          expected: base === undefined ? 'absolute_http_or_https_url' : 'http_or_https_url',
          received_kind: 'invalid_url'
        }
      })
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new CliError('INVALID_API_RESPONSE', 'The Poki API returned an unsupported download URL protocol.', 5, {
        details: {
          expected: base === undefined ? 'absolute_http_or_https_url' : 'http_or_https_url',
          received_kind: 'unsupported_protocol'
        }
      })
    }
    return url
  }

  private async execute<T> (request: ApiRequest, accessToken: string): Promise<ApiResponse<T>> {
    const url = this.resolveApiUrl(request.path, request.query)

    const headers: Record<string, string> = {
      Accept: request.accept ?? 'application/vnd.api+json',
      Authorization: `Bearer ${accessToken}`,
      'User-Agent': CLI_USER_AGENT
    }
    let body: BodyInit | undefined = request.rawBody
    if (request.body !== undefined && request.rawBody !== undefined) {
      throw new CliError('INVALID_INPUT', 'An API request cannot have both body and rawBody.', 2)
    }
    if (request.body !== undefined) {
      headers['Content-Type'] = request.contentType ?? 'application/vnd.api+json'
      body = JSON.stringify(request.body)
    }

    if (this.beforeFirstRequest !== undefined) {
      this.firstRequestPreparation ??= this.beforeFirstRequest()
      await this.firstRequestPreparation
    }

    const timeoutMs = request.timeoutMs ?? (request.rawBody !== undefined ? this.uploadTimeoutMs : this.timeoutMs)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    const method = request.method ?? 'GET'
    const readOnly = request.retrySafe === true || method === 'GET'
    try {
      const response = await this.transport(url, {
        method,
        headers,
        body,
        // The configured API origin is the complete authenticated transport
        // boundary. Fetch follows redirects by default, and a 307 or 308 can
        // resend a mutation body to the redirect target. Surface every 3xx to
        // request() instead so mutations retain inspect-before-replay recovery.
        // Signed downloads intentionally keep their separate redirect behavior.
        redirect: 'manual',
        signal: controller.signal
      })

      const text = await response.text()
      let parsed: unknown = text
      const wantsJson = request.responseType !== 'text'
      if (wantsJson && text !== '') {
        try {
          parsed = JSON.parse(text)
        } catch (error) {
          if (response.status >= 200 && response.status < 300) {
            const mutation = method !== 'GET' && request.retrySafe !== true
            throw new CliError('INVALID_API_RESPONSE', 'The Poki API returned invalid JSON.', 5, {
              status: response.status,
              retryable: false,
              requestId: response.headers.get('x-request-id') ?? response.headers.get('x-cloud-trace-context') ?? undefined,
              ...(mutation
                ? { hint: `The ${method} mutation may already have committed. Inspect current resource state and do not replay the mutation.` }
                : {})
            })
          }
        }
      } else if (text === '' && request.responseType !== 'text') {
        parsed = null
      }

      return {
        status: response.status,
        headers: response.headers,
        body: parsed as T
      }
    } catch (error) {
      if (error instanceof CliError) throw error
      if (controller.signal.aborted) {
        throw new CliError('API_TIMEOUT', `The Poki API request exceeded ${timeoutMs} ms.`, 5, {
          details: { method, path: url.pathname, timeout_ms: timeoutMs },
          retryable: readOnly,
          hint: readOnly
            ? 'Retry the read or increase --timeout-ms.'
            : 'Check the resource state before retrying this mutation.'
        })
      }
      throw new CliError('NETWORK_ERROR', 'Could not reach the Poki API.', 5, {
        retryable: readOnly,
        ...(readOnly ? {} : { hint: `The ${method} outcome may be unknown. Read the resource state before deciding whether to retry this mutation.` })
      })
    } finally {
      clearTimeout(timeout)
    }
  }
}
