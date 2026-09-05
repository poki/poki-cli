import { createServer, RequestListener } from 'http'
import { randomUUID } from 'crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'

import { getConfigDir, Config } from './config'
import { authRequired, AUTH_LOGIN_USER_ACTION_HINT } from './errors'
import { serviceEnvironment } from './service-environment'
import { DEFAULT_REQUEST_TIMEOUT_MS, timeoutMillisecondsOrDefault } from './timeouts'
import { CLI_USER_AGENT } from './version'

type Log = (message: string) => void
interface BrowserOpenerModule { default: (target: string) => Promise<unknown> }
type BrowserOpenerImport = () => Promise<BrowserOpenerModule>

const maxAuthResponseBytes = 64 * 1024

class AuthRequestError extends Error {}

export async function launchBrowser (
  target: string,
  importOpener: BrowserOpenerImport = async () => await import('open')
): Promise<void> {
  const { default: open } = await importOpener()
  await open(target)
}

function isCredentialToken (value: unknown): value is string {
  // OAuth credentials are placed in HTTP headers. Restrict them to visible
  // ASCII so successful auth responses can never persist a value that Fetch
  // later rejects or that changes when serialized to disk.
  return typeof value === 'string' && /^[\x21-\x7e]+$/.test(value)
}

function decodeCredentials (
  value: unknown,
  options: { requireAccessToken: boolean, allowUploadToken: boolean }
): Config | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const source = value as Record<string, unknown>

  const accessToken = source.access_token
  if (accessToken !== undefined && !isCredentialToken(accessToken)) return undefined
  if (options.requireAccessToken && !isCredentialToken(accessToken)) return undefined

  const refreshToken = source.refresh_token
  if (refreshToken !== undefined && !isCredentialToken(refreshToken)) return undefined

  const accessType = source.access_type
  if (accessType !== undefined && accessType !== 'Bearer' && !(options.allowUploadToken && accessType === 'Token')) return undefined

  return {
    ...(typeof accessToken === 'string' ? { access_token: accessToken } : {}),
    ...(typeof refreshToken === 'string' ? { refresh_token: refreshToken } : {}),
    ...(typeof accessType === 'string' ? { access_type: accessType } : {})
  }
}

export function decodeBearerCredentials (value: unknown): Config | undefined {
  return decodeCredentials(value, { requireAccessToken: true, allowUploadToken: false })
}

export interface AuthStatus {
  authenticated: boolean
  credentials_present: boolean
  source: 'stored' | 'none'
  access_type?: string
  expires_at?: string
  expired?: boolean
  refreshable: boolean
}

export function getAuthPath (): string {
  return join(getConfigDir(), 'auth.json')
}

export function readStoredAuth (): Config | undefined {
  try {
    return decodeCredentials(JSON.parse(readFileSync(getAuthPath(), 'utf8')), {
      requireAccessToken: true,
      allowUploadToken: true
    })
  } catch (error) {
    return undefined
  }
}

function writeStoredAuth (config: Config): void {
  const configDir = getConfigDir()
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true })
  }

  // Publish credentials from a same-directory temporary file, the way completed
  // downloads are published. Writing auth.json directly opens it with O_TRUNC,
  // so an invocation starting while this one refreshes an expired token reads an
  // empty file and reports AUTH_REQUIRED for perfectly valid credentials, and an
  // interruption between open and write empties it permanently. Rename is atomic
  // on the same filesystem, so a concurrent reader always sees either the
  // complete old or the complete new document.
  const temporary = join(configDir, `.poki-auth-${process.pid}-${randomUUID()}.tmp`)
  try {
    // Create the file already restricted: a mode applied after the write leaves
    // the credentials briefly readable, and permanently so if the process dies
    // between the two calls. Repairing the mode here rather than on auth.json
    // also means a world-readable file an older CLI created under the default
    // umask is replaced by the rename instead of receiving the fresh token
    // first.
    writeFileSync(temporary, JSON.stringify(config), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    chmodSync(temporary, '600')
    renameSync(temporary, getAuthPath())
  } catch (error) {
    try {
      unlinkSync(temporary)
    } catch {
      // The temporary file may never have been created; keep the original
      // failure, which describes why the credentials were not persisted.
    }
    throw error
  }
}

function tokenExpiry (token: string | undefined): number | undefined {
  if (token === undefined) return undefined

  try {
    const payload = token.split('.')[1]
    if (payload === undefined) return undefined
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { exp?: unknown }
    if (typeof decoded.exp !== 'number' || !Number.isFinite(decoded.exp)) return undefined
    const expiry = decoded.exp * 1000
    return Number.isFinite(expiry) && !Number.isNaN(new Date(expiry).getTime()) ? expiry : undefined
  } catch (error) {
    return undefined
  }
}

export function getAuthStatus (): AuthStatus {
  const config = readStoredAuth()
  if (config?.access_token === undefined) {
    return {
      authenticated: false,
      credentials_present: false,
      source: 'none',
      refreshable: false
    }
  }

  const expiry = tokenExpiry(config.access_token)
  const expired = expiry !== undefined && expiry <= Date.now()
  const accessType = config.access_type ?? 'Bearer'
  return {
    authenticated: !expired && accessType !== 'Token',
    credentials_present: true,
    source: 'stored',
    access_type: accessType,
    ...(expiry === undefined
      ? {}
      : {
          expires_at: new Date(expiry).toISOString(),
          expired
        }),
    refreshable: config.refresh_token !== undefined
  }
}

export function logoutStoredAuth (): boolean {
  if (!existsSync(getAuthPath())) return false
  unlinkSync(getAuthPath())
  return true
}

function authTimeoutMs (): number {
  return timeoutMillisecondsOrDefault(process.env.POKI_API_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS)
}

function authEndpoint (path: string, baseUrl: string): string {
  try {
    const base = new URL(baseUrl)
    if (base.protocol !== 'http:' && base.protocol !== 'https:') throw new Error('unsupported protocol')
    return new URL(path, base).toString()
  } catch {
    throw new AuthRequestError('The authentication service URL is invalid.')
  }
}

async function cancelResponseBody (response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // Preserve the public authentication error that caused the cancellation.
  }
}

async function boundedResponseText (response: Response, operation: 'exchange' | 'refresh'): Promise<string> {
  const contentLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(contentLength) && contentLength > maxAuthResponseBytes) {
    await cancelResponseBody(response)
    throw new AuthRequestError(`The authentication ${operation} response was too large.`)
  }

  const reader = response.body?.getReader()
  if (reader === undefined) return ''

  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > maxAuthResponseBytes) {
        try {
          await reader.cancel()
        } catch {}
        throw new AuthRequestError(`The authentication ${operation} response was too large.`)
      }
      chunks.push(chunk.value)
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {}
  }
  return Buffer.concat(chunks.map(chunk => Buffer.from(chunk)), bytes).toString('utf8')
}

async function exchange (exchangeToken: string, authUrl: string): Promise<Config> {
  return await postAuth('/auth/exchange', { exchange_token: exchangeToken }, 'exchange', authUrl)
}

async function postAuth (
  path: string,
  body: Record<string, string>,
  operation: 'exchange' | 'refresh',
  authUrl: string
): Promise<Config> {
  const timeoutMs = authTimeoutMs()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    let response: Response
    try {
      response = await fetch(authEndpoint(path, authUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': CLI_USER_AGENT },
        body: JSON.stringify(body),
        redirect: 'manual',
        signal: controller.signal
      })
    } catch (error) {
      if (error instanceof AuthRequestError) throw error
      if (controller.signal.aborted) {
        throw new AuthRequestError(`The authentication ${operation} request exceeded ${String(timeoutMs)} ms.`)
      }
      throw new AuthRequestError(`Could not reach the authentication service for ${operation}.`)
    }

    if (response.status !== 200) {
      await cancelResponseBody(response)
      throw new AuthRequestError(`Authentication ${operation} failed with status ${String(response.status)}.`)
    }

    let data: string
    try {
      data = await boundedResponseText(response, operation)
    } catch (error) {
      if (error instanceof AuthRequestError) throw error
      if (controller.signal.aborted) {
        throw new AuthRequestError(`The authentication ${operation} request exceeded ${String(timeoutMs)} ms.`)
      }
      throw new AuthRequestError(`Could not read the authentication ${operation} response.`)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(data)
    } catch {
      throw new AuthRequestError(`The authentication ${operation} returned invalid JSON.`)
    }
    const credentials = decodeBearerCredentials(parsed)
    if (credentials === undefined) {
      throw new AuthRequestError(`The authentication ${operation} returned invalid credentials.`)
    }

    // Keep the stored credential shape independent of future auth-service
    // response members. In particular, a refresh response must not overwrite
    // project settings or switch API credentials into legacy upload-token
    // mode merely because it contains an unexpected field.
    return credentials
  } finally {
    clearTimeout(timeout)
  }
}

export async function refreshStoredAuth (config: Config, authUrl = serviceEnvironment().authUrl): Promise<Config> {
  const current = decodeCredentials(config, { requireAccessToken: false, allowUploadToken: false })
  if (current?.refresh_token === undefined) {
    throw new Error('No refresh token found')
  }

  const body = await postAuth('/auth/refresh', { refresh_token: current.refresh_token }, 'refresh', authUrl)
  const refreshed = decodeBearerCredentials({ ...current, ...body })
  if (refreshed === undefined) throw new AuthRequestError('The authentication refresh returned invalid credentials.')
  try {
    writeStoredAuth(refreshed)
  } catch {
    // The current auth service keeps the long-lived refresh token unchanged,
    // so persisting its short-lived access token is only a cache optimization.
    // A read-only sandbox must still be able to use the refreshed token for the
    // command that requested it.
  }
  return refreshed
}

export async function refresh (config: Config, log: Log = console.log): Promise<Config> {
  log('refreshing authentication...')
  return await refreshStoredAuth(config)
}

async function interactiveLogin (log: Log): Promise<Config> {
  log('authentication required, opening browser...')

  const environment = serviceEnvironment()

  return await new Promise<Config>((resolve, reject) => {
    const configDir = getConfigDir()
    if (!existsSync(configDir)) {
      try {
        mkdirSync(configDir, { recursive: true })
      } catch (error) {
        reject(error)
        return
      }
    }

    const callback: RequestListener = (req, res) => {
      if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
        res.writeHead(200)
        res.end()
        return
      }

      const url = new URL(req.url as string, 'http://localhost')
      if (url.pathname === '/favicon.ico') {
        res.writeHead(404)
        res.end()
        return
      }

      const exchangeToken = url.searchParams.get('exchange_token')
      if (exchangeToken === null) {
        res.setHeader('Content-Type', 'text/plain')
        res.setHeader('Connection', 'close')
        res.writeHead(200)
        res.end('missing exchange_token', () => shutdown())
        reject(new Error('missing exchange_token'))
        return
      }

      res.setHeader('Content-Type', 'text/html')
      res.setHeader('Connection', 'close')
      res.writeHead(200)
      res.end('You can close this window and return to your terminal', () => shutdown())

      exchange(exchangeToken, environment.authUrl).then(config => {
        writeStoredAuth(config)
        resolve(config)
      }).catch(reject)
    }

    // Only the local browser completes this flow, so the callback listens on
    // loopback rather than every network interface. The callback URL has to
    // keep the `localhost` hostname because the authentication service
    // allowlists it, and that name resolves to either loopback family, so IPv6
    // gets a best-effort second listener on the same port.
    const server = createServer(callback)
    const ipv6Server = createServer(callback)

    // close() only stops the listener. The browser's keep-alive socket - and any
    // speculative preconnect it opened - stay referenced and would hold the
    // event loop open for the full idle timeout after login already succeeded.
    const shutdown = (): void => {
      for (const listener of [server, ipv6Server]) {
        listener.close()
        listener.closeAllConnections()
      }
    }

    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        shutdown()
        reject(new Error('Could not determine the local authentication callback address'))
        return
      }

      let browserOpened = false
      const openBrowser = (): void => {
        if (browserOpened) return
        browserOpened = true
        launchBrowser(`${environment.signInUrl}?cli=${encodeURIComponent(`http://localhost:${address.port}`)}`).catch(error => {
          shutdown()
          reject(error)
        })
      }

      // A host without IPv6 loopback keeps working on the IPv4 listener alone.
      // The error listener stays attached so a later failure on the optional
      // listener cannot surface as an unhandled event.
      ipv6Server.on('error', openBrowser)
      ipv6Server.listen(address.port, '::1', openBrowser)
    })
  })
}

export async function login (log: Log = console.error): Promise<Config> {
  // Without a terminal nobody can complete the browser flow; the structured
  // auth error beats opening a browser and blocking on the callback forever.
  // stdout is deliberately not part of that check: it carries the structured
  // result, so `poki auth login --format json > file` is an ordinary human
  // invocation. stdin and stderr are the streams that stay attached to the
  // session, and a process with neither still refuses.
  if (!(process.stdin.isTTY ?? false) && !(process.stderr.isTTY ?? false)) {
    throw authRequired(
      'Sign-in needs an interactive terminal to open a browser and complete the OAuth flow.',
      AUTH_LOGIN_USER_ACTION_HINT
    )
  }
  return await interactiveLogin(log)
}

// Legacy upload authentication. It intentionally keeps support for upload
// tokens and implicit browser login; API resource commands use readStoredAuth.
export async function auth (force = false, log: Log = console.log): Promise<Config> {
  let config = force ? undefined : readStoredAuth()

  if (typeof process.env.POKI_ACCESS_TOKEN === 'string') {
    console.warn('POKI_ACCESS_TOKEN has been deprecated, please use POKI_UPLOAD_TOKEN')
    config = {
      ...config,
      access_type: 'Token',
      access_token: process.env.POKI_ACCESS_TOKEN
    }
  }

  if (typeof process.env.POKI_UPLOAD_TOKEN === 'string') {
    config = {
      ...config,
      access_type: 'Token',
      access_token: process.env.POKI_UPLOAD_TOKEN
    }
  }

  if (config !== undefined) return config
  // The legacy upload command historically initiated browser login implicitly,
  // including when stdout was not a TTY. Keep that behavior here; the explicit
  // auth login command retains its non-interactive guard.
  return await interactiveLogin(log)
}
