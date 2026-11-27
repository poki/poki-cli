import { auth, refresh } from './auth'
import { Config } from './config'
import { serviceEnvironment } from './service-environment'
import { DEFAULT_UPLOAD_TIMEOUT_MS, timeoutMillisecondsOrDefault } from './timeouts'
import { ProgressOutput, uploadProgress } from './upload-progress'
import { CLI_USER_AGENT } from './version'

import { readFileSync, statSync } from 'fs'
import type { ClientRequest } from 'http'
import { request } from 'https'
import { basename } from 'path'

import FormData from 'form-data'

interface Response {
  statusCode?: number
  data: string
}

export type LegacyUploadFailureKind = 'timeout' | 'network' | 'response'

// The legacy transport predates ApiClient and its error classification, so it
// carries the little the command needs to choose a documented exit code. The
// message keeps the historical human text; the command reports a generic one in
// the structured document so raw backend text never reaches a public surface.
export class LegacyUploadError extends Error {
  readonly kind: LegacyUploadFailureKind
  readonly statusCode?: number

  constructor (message: string, kind: LegacyUploadFailureKind, statusCode?: number) {
    super(message)
    this.name = 'LegacyUploadError'
    this.kind = kind
    this.statusCode = statusCode
  }
}

// A socket-inactivity deadline, not a total one: a legitimate multi-hundred
// megabyte build on a slow connection must not be cut off mid-transfer, while an
// origin that never answers must not stall until the operating system gives up.
// The request had no deadline at all before, and because this transport reaches
// a pinned address rather than a resolved hostname (see AGENTS.md), an origin
// that stops answering is a routine failure mode rather than a theoretical one.
export function legacyUploadTimeoutMs (): number {
  return timeoutMillisecondsOrDefault(process.env.POKI_API_TIMEOUT_MS, DEFAULT_UPLOAD_TIMEOUT_MS)
}

// Injected only so tests can drive the real Node request machinery against a
// loopback server; production always uses the https request above.
export type LegacyTransport = typeof request

// Writing the body in slices lets each write callback report how much of it
// the socket has taken, which is what the progress line shows. Only one slice
// is in flight at a time, so Node never buffers more than a slice of it.
const UPLOAD_SLICE_BYTES = 64 * 1024

function writeBody (req: ClientRequest, body: Buffer, onWritten: (sent: number) => void): void {
  let offset = 0
  const writeNext = (): void => {
    // A destroyed request has already settled through its 'error' event.
    if (req.destroyed) return
    if (offset >= body.length) {
      req.end()
      return
    }
    const end = Math.min(offset + UPLOAD_SLICE_BYTES, body.length)
    req.write(body.subarray(offset, end), error => {
      if (error != null) return
      offset = end
      onWritten(offset)
      writeNext()
    })
  }
  writeNext()
}

async function doit (
  gameId: string,
  filename: string,
  name: string,
  notes: string | undefined,
  makePublic: boolean,
  disableImageCompression: boolean,
  config: Config,
  transport: LegacyTransport,
  progressOutput: ProgressOutput
): Promise<Response> {
  return await new Promise<Response>((resolve, reject) => {
    if (config.access_token === undefined) {
      return reject(new Error('No access token found'))
    }

    const stat = statSync(filename)

    const form = new FormData()

    form.append('file', readFileSync(filename), {
      filepath: basename(filename),
      knownLength: stat.size,
      contentType: 'application/zip'
    })
    if (name !== filename) {
      form.append('label', name)
    }
    if (notes !== undefined) {
      form.append('notes', notes)
    }
    if (makePublic) {
      form.append('make-public', 'true')
    }
    if (disableImageCompression) {
      form.append('disable-image-compression', 'true')
    }

    console.log('uploading...')

    const buffer = form.getBuffer()
    const path = `/games/${gameId}/versions`
    const environment = serviceEnvironment()
    const timeoutMs = legacyUploadTimeoutMs()
    // The socket can outlive this request in the agent's keep-alive pool, so a
    // late timeout or error must not settle an already-answered upload.
    let settled = false
    const settle = (action: () => void): void => {
      if (settled) return
      settled = true
      // End the progress line so what the caller prints next starts on its
      // own row, even when the answer arrives before the body is sent.
      progress.finish()
      action()
    }
    const req = transport({
      hostname: environment.legacyUploadHostname,
      port: 443,
      path,
      method: 'POST',
      timeout: timeoutMs,
      headers: {
        Host: environment.legacyUploadHost,
        Authorization: `${config.access_type ?? 'Bearer'} ${config.access_token ?? ''}`,
        'Content-Length': buffer.length,
        'User-Agent': CLI_USER_AGENT,
        ...form.getHeaders()
      }
    }, res => {
      const data: any[] = []
      res.on('data', chunk => {
        data.push(chunk)
      })
      res.on('end', () => {
        settle(() => resolve({
          statusCode: res.statusCode,
          data: Buffer.concat(data).toString()
        }))
      })
    })

    // 'timeout' only reports the idle socket; without an explicit destroy the
    // request keeps waiting exactly as it did when it had no deadline.
    req.on('timeout', () => {
      req.destroy(new LegacyUploadError(
        `The legacy upload request exceeded ${String(timeoutMs)} ms without transferring data.`,
        'timeout'
      ))
    })

    req.on('error', error => {
      settle(() => reject(error instanceof LegacyUploadError
        ? error
        : new LegacyUploadError(`Could not reach the Poki upload service: ${error.message}`, 'network')))
    })

    // Created only once the request exists: a request that throws while it
    // is being built must not leave a half-drawn progress line behind.
    const progress = uploadProgress(buffer.length, progressOutput)
    writeBody(req, buffer, sent => {
      progress.update(sent)
      if (sent === buffer.length) progress.finish()
    })
  })
}

interface P4dData {
  game_id: string
  id: string | number
}

export function finalizeP4dResponse (response: Response): P4dData {
  if (response.statusCode === 201) {
    try {
      return JSON.parse(response.data) as P4dData
    } catch {
      // A 201 the CLI cannot read still created the version, so this must not
      // look like a rejected upload the caller may safely repeat.
      throw new LegacyUploadError(JSON.stringify(response), 'response', response.statusCode)
    }
  }
  throw new LegacyUploadError(JSON.stringify(response), 'response', response.statusCode)
}

async function uploadToP4D (
  gameId: string,
  filename: string,
  name: string,
  notes: string | undefined,
  makePublic: boolean,
  disableImageCompression: boolean,
  transport: LegacyTransport,
  progressOutput: ProgressOutput
): Promise<P4dData> {
  let config = await auth(false, console.log)
  let response = await doit(gameId, filename, name, notes, makePublic, disableImageCompression, config, transport, progressOutput)

  if (response.statusCode === 401 && config.access_type !== 'Token') {
    try {
      config = await refresh(config, console.log)
    } catch (e) {
      config = await auth(true, console.log)
    }
    response = await doit(gameId, filename, name, notes, makePublic, disableImageCompression, config, transport, progressOutput)
  }

  return finalizeP4dResponse(response)
}

// Keep the original six-argument entry point and its human presentation
// compatible for the deprecated default upload workflow. The trailing
// parameters exist for tests only and keep that call shape intact.
export async function postToP4D (gameId: string, filename: string, name: string, notes: string | undefined, makePublic: boolean, disableImageCompression: boolean, transport: LegacyTransport = request, progressOutput: ProgressOutput = process.stdout): Promise<P4dData> {
  return await uploadToP4D(gameId, filename, name, notes, makePublic, disableImageCompression, transport, progressOutput)
}
