import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test, { TestContext } from 'node:test'

import { ApiClient } from '../src/api'
import { CliError, errorDocument, safeErrorCause } from '../src/errors'
import { CLI_USER_AGENT } from '../src/version'
import { listen } from './helpers'

function enableSetTimeoutMock (t: TestContext): void {
  try {
    t.mock.timers.enable({ apis: ['setTimeout'] })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ERR_INVALID_ARG_TYPE') throw error

    // Node 20.7 uses the original array argument. Newer supported runtimes use
    // the options object represented by the current @types/node declarations.
    const timers = t.mock.timers
    const enableLegacyTimers = timers.enable as unknown as (timers: string[]) => void
    enableLegacyTimers.call(timers, ['setTimeout'])
  }
}

function jsonResponse (status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/vnd.api+json' }
  })
}

async function readDownloadBody (body: ReadableStream<Uint8Array> | null): Promise<Uint8Array> {
  return new Uint8Array(await new Response(body).arrayBuffer())
}

void test('the API client refreshes once on 401 and replays reads and mutations with the new Bearer token', async () => {
  for (const method of ['GET', 'POST'] as const) {
    const authorizations: string[] = []
    const userAgents: string[] = []
    let refreshes = 0
    // A 401 is rejected before execution, so the client replays reads and
    // mutations alike exactly once with the refreshed token.
    const transport = (async (_input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      authorizations.push(headers.get('Authorization') ?? '')
      userAgents.push(headers.get('User-Agent') ?? '')
      return authorizations.length === 1
        ? jsonResponse(401, { errors: [{ title: 'expired' }] })
        : jsonResponse(200, { data: { type: 'games', id: 'game-1' } })
    }) as typeof fetch

    const api = new ApiClient('https://example.invalid', {
      fetch: transport,
      readAuth: () => ({ access_type: 'Bearer', access_token: 'old-token', refresh_token: 'refresh-token' }),
      refreshAuth: async config => {
        refreshes++
        return { ...config, access_token: 'new-token' }
      }
    })

    const response = method === 'GET'
      ? await api.request({ path: '/games/game-1' })
      : await api.request({ method, path: '/games', body: { data: {} } })
    assert.equal(response.status, 200, method)
    assert.equal(refreshes, 1, method)
    assert.deepEqual(authorizations, ['Bearer old-token', 'Bearer new-token'], method)
    assert.deepEqual(userAgents, [CLI_USER_AGENT, CLI_USER_AGENT], method)
  }
})

void test('a repeated 401 becomes the standard auth-required error without a second refresh', async () => {
  for (const method of ['GET', 'POST'] as const) {
    let requests = 0
    let refreshes = 0
    const api = new ApiClient('https://example.invalid', {
      fetch: (async () => {
        requests++
        return jsonResponse(401, { errors: [{ title: 'nope' }] })
      }) as typeof fetch,
      readAuth: () => ({ access_type: 'Bearer', access_token: 'old-token', refresh_token: 'refresh-token' }),
      refreshAuth: async config => {
        refreshes++
        return { ...config, access_token: 'new-token' }
      }
    })

    const request = method === 'GET'
      ? api.request({ path: '/games' })
      : api.request({ method, path: '/games', body: { data: {} } })
    await assert.rejects(request, (error: unknown) => {
      return error instanceof CliError && error.code === 'AUTH_REQUIRED' && error.exitCode === 3
    })
    assert.equal(requests, 2, method)
    assert.equal(refreshes, 1, method)
  }
})

void test('upload-token credentials are never accepted by the generic API client', async () => {
  let called = false
  const api = new ApiClient('https://example.invalid', {
    fetch: (async () => {
      called = true
      return jsonResponse(200, {})
    }) as typeof fetch,
    readAuth: () => ({ access_type: 'Token', access_token: 'upload-token' })
  })

  await assert.rejects(api.request({ path: '/games' }), (error: unknown) => {
    return error instanceof CliError && error.code === 'AUTH_REQUIRED'
  })
  assert.equal(called, false)
})

void test('the API client rejects malformed runtime credentials before constructing an Authorization header', async () => {
  const invalidCredentials: unknown[] = [
    { access_type: 'Bearer', access_token: null },
    { access_type: 'Bearer', access_token: 'bad\u0000token' },
    { access_type: 'Bearer', access_token: 'töken' },
    { access_type: 'Bearer', access_token: 'access-1', refresh_token: 42 },
    { access_type: 'Unexpected', access_token: 'access-1' }
  ]

  for (const credentials of invalidCredentials) {
    let called = false
    const api = new ApiClient('https://example.invalid', {
      fetch: (async () => {
        called = true
        return jsonResponse(200, {})
      }) as typeof fetch,
      readAuth: () => credentials as never
    })
    await assert.rejects(api.request({ path: '/games' }), (error: unknown) => {
      return error instanceof CliError && error.code === 'AUTH_REQUIRED'
    })
    assert.equal(called, false)
  }

  let requests = 0
  const invalidRefresh = new ApiClient('https://example.invalid', {
    fetch: (async () => {
      requests++
      return jsonResponse(401, { errors: [{ title: 'expired' }] })
    }) as typeof fetch,
    readAuth: () => ({ access_type: 'Bearer', access_token: 'old-token', refresh_token: 'refresh-token' }),
    refreshAuth: async () => ({ access_type: 'Bearer', access_token: 'new\u0000token' })
  })
  await assert.rejects(invalidRefresh.request({ path: '/games' }), (error: unknown) => {
    return error instanceof CliError && error.code === 'AUTH_REQUIRED'
  })
  assert.equal(requests, 1)
})

void test('API 4xx, 5xx, and transport failures use their documented exit classes', async () => {
  const clientFor = (transport: typeof fetch): ApiClient => new ApiClient('https://example.invalid', {
    fetch: transport,
    readAuth: () => ({ access_type: 'Bearer', access_token: 'test-token' })
  })

  const forbidden = clientFor((async () => jsonResponse(403, {
    errors: [{ code: 'permission-denied', detail: 'This field is admin-only.' }]
  })) as typeof fetch)
  await assert.rejects(forbidden.request({ path: '/games' }), (error: unknown) => {
    return error instanceof CliError &&
      error.code === 'PERMISSION_DENIED' &&
      error.status === 403 &&
      error.exitCode === 4
  })

  const genericForbidden = clientFor((async () => jsonResponse(403, {
    errors: [{ code: 'forbidden', title: 'This operation is not allowed in the current state.' }]
  })) as typeof fetch)
  await assert.rejects(genericForbidden.request({ path: '/games' }), (error: unknown) => {
    return error instanceof CliError &&
      error.code === 'FORBIDDEN' &&
      error.status === 403 &&
      error.exitCode === 4
  })

  const unavailable = clientFor((async () => jsonResponse(503, {
    errors: [{ code: 'unavailable', title: 'Try later' }]
  })) as typeof fetch)
  await assert.rejects(unavailable.request({ path: '/games' }), (error: unknown) => {
    return error instanceof CliError && error.status === 503 && error.exitCode === 5
  })

  const offline = clientFor((async () => { throw new Error('socket unavailable') }) as typeof fetch)
  await assert.rejects(offline.request({ path: '/games' }), (error: unknown) => {
    return error instanceof CliError && error.code === 'NETWORK_ERROR' && error.exitCode === 5
  })

  const validationError = clientFor((async () => jsonResponse(400, {
    error: 'private-backend-error-code',
    message: 'private backend validation text',
    internal: { secret: 'legacy-shape-secret' }
  })) as typeof fetch)
  await assert.rejects(validationError.request({ path: '/games' }), (error: unknown) => {
    assert.ok(error instanceof CliError)
    assert.equal(error.code, 'HTTP_400')
    assert.equal(error.message, 'Poki API request failed with status 400.')
    assert.equal(error.details, undefined)
    assert.equal(error.exitCode, 4)
    assert.doesNotMatch(JSON.stringify(errorDocument(error)), /private|legacy-shape-secret/)
    return true
  })

  const malformedClientError = clientFor((async () => new Response('not json', {
    status: 422,
    headers: { 'Content-Type': 'application/json' }
  })) as typeof fetch)
  await assert.rejects(malformedClientError.request({ path: '/games' }), (error: unknown) => {
    return error instanceof CliError && error.code === 'HTTP_422' && error.exitCode === 4
  })

  const malformedSuccess = clientFor((async () => new Response('not json', {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  })) as typeof fetch)
  await assert.rejects(malformedSuccess.request({ path: '/games' }), (error: unknown) => {
    return error instanceof CliError && error.code === 'INVALID_API_RESPONSE' && error.exitCode === 5
  })
})

void test('PERMISSION_DENIED requires both HTTP 403 and the exact JSON:API error code', async () => {
  const clientFor = (status: number, body: unknown): ApiClient => new ApiClient('https://example.invalid', {
    fetch: (async () => jsonResponse(status, body)) as typeof fetch,
    readAuth: () => ({ access_type: 'Bearer', access_token: 'test-token' })
  })

  await assert.rejects(clientFor(400, {
    errors: [{
      code: 'permission-denied',
      title: 'Invalid use of the code',
      source: { pointer: '/private' },
      meta: { required_permissions: ['admin'], internal_acl_result: 'denied' }
    }],
    meta: { granted_permissions: ['developer'] }
  }).request({ path: '/games' }), (error: unknown) => {
    assert.ok(error instanceof CliError)
    assert.equal(error.code, 'HTTP_400')
    assert.equal(error.status, 400)
    assert.equal(error.exitCode, 4)
    assert.deepEqual(error.details, {
      errors: [{ code: 'permission-denied', title: 'Invalid use of the code' }]
    })
    assert.doesNotMatch(JSON.stringify(errorDocument(error)), /pointer|required_permissions|granted_permissions|internal_acl_result/)
    return true
  })

  await assert.rejects(clientFor(403, {
    errors: [{ code: 'permission_denied', title: 'Near miss' }]
  }).request({ path: '/games' }), (error: unknown) => {
    return error instanceof CliError && error.code === 'HTTP_403' && error.status === 403
  })

  await assert.rejects(clientFor(403, {
    error: 'permission-denied',
    message: 'Legacy non-JSON:API shape'
  }).request({ path: '/games' }), (error: unknown) => {
    return error instanceof CliError && error.code === 'HTTP_403' && error.status === 403
  })
})

void test('backend error details and nested causes expose only reviewed JSON:API error fields', async () => {
  const api = new ApiClient('https://example.invalid', {
    fetch: (async () => jsonResponse(503, {
      errors: [{
        status: '503',
        code: 'unavailable',
        title: 'Try later',
        detail: 'The service is temporarily unavailable.',
        source: { pointer: '/private' },
        meta: {
          required_permissions: ['admin'],
          granted_permissions: ['developer'],
          internal_acl_result: 'denied'
        },
        future_private_field: 'private'
      }],
      meta: { impersonator: { id: 'admin-1' }, internal_document_field: 'private' },
      arbitrary_payload: { secret: true }
    })) as typeof fetch,
    readAuth: () => ({ access_type: 'Bearer', access_token: 'test-token' })
  })

  await assert.rejects(api.request({ path: '/games' }), (error: unknown) => {
    assert.ok(error instanceof CliError)
    const apiResponse = {
      errors: [{
        status: '503',
        code: 'unavailable',
        title: 'Try later',
        detail: 'The service is temporarily unavailable.'
      }]
    }
    assert.deepEqual(error.details, apiResponse)
    assert.deepEqual(errorDocument(error).error.details, apiResponse)
    assert.deepEqual(safeErrorCause(error), {
      code: 'UNAVAILABLE',
      message: 'The service is temporarily unavailable.',
      status: 503,
      retryable: true,
      api_response: apiResponse
    })
    assert.doesNotMatch(JSON.stringify(errorDocument(error)), /private|required_permissions|granted_permissions|internal_acl|impersonator|secret/)
    return true
  })
})

void test('malformed successful mutation JSON is non-retryable and must not replay the mutation', async () => {
  let requests = 0
  const api = new ApiClient('https://example.invalid', {
    fetch: (async () => {
      requests++
      return new Response('not json and potentially sensitive', {
        status: 201,
        headers: {
          'Content-Type': 'application/json',
          'X-Request-Id': 'req-malformed-success'
        }
      })
    }) as typeof fetch,
    readAuth: () => ({ access_type: 'Bearer', access_token: 'test-token' })
  })

  await assert.rejects(api.request({ method: 'POST', path: '/games', body: { data: {} } }), (error: unknown) => {
    assert.ok(error instanceof CliError)
    assert.equal(error.code, 'INVALID_API_RESPONSE')
    assert.equal(error.status, 201)
    assert.equal(error.retryable, false)
    assert.equal(error.requestId, 'req-malformed-success')
    assert.equal(error.details, undefined)
    assert.match(error.hint ?? '', /Inspect current resource state/)
    assert.match(error.hint ?? '', /do not replay the mutation/)
    assert.doesNotMatch(JSON.stringify(errorDocument(error)), /potentially sensitive/)
    return true
  })
  assert.equal(requests, 1)
})

void test('a 429 carries retryable, retry_after, and request_id from the response headers', async () => {
  const api = new ApiClient('https://example.invalid', {
    fetch: (async () => new Response('{}', {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': '7',
        'X-Request-Id': 'req-1'
      }
    })) as typeof fetch,
    readAuth: () => ({ access_type: 'Bearer', access_token: 'test-token' })
  })

  await assert.rejects(api.request({ path: '/games' }), (error: unknown) => {
    return error instanceof CliError &&
      error.code === 'HTTP_429' &&
      error.status === 429 &&
      error.exitCode === 4 &&
      error.retryable &&
      error.retryAfter === '7' &&
      error.requestId === 'req-1'
  })
})

void test('transient mutation responses are not retryable unless the request is explicitly retry-safe', async () => {
  for (const status of [408, 429, 503]) {
    const api = new ApiClient('https://example.invalid', {
      fetch: (async () => jsonResponse(status, { error: `http-${status}` })) as typeof fetch,
      readAuth: () => ({ access_type: 'Bearer', access_token: 'test-token' })
    })

    await assert.rejects(api.request({ method: 'POST', path: '/games', body: { data: {} } }), (error: unknown) => {
      return error instanceof CliError &&
        error.status === status &&
        !error.retryable &&
        (error.hint ?? '').includes('outcome may be unknown')
    }, String(status))
  }

  const analytics = new ApiClient('https://example.invalid', {
    fetch: (async () => jsonResponse(503, { error: 'unavailable' })) as typeof fetch,
    readAuth: () => ({ access_type: 'Bearer', access_token: 'test-token' })
  })
  await assert.rejects(analytics.request({ method: 'POST', path: '/_data', body: {}, retrySafe: true }), (error: unknown) => {
    return error instanceof CliError && error.retryable
  })
})

void test('absolute pagination URLs cannot send Bearer credentials to another origin', async () => {
  let called = false
  const api = new ApiClient('https://example.invalid', {
    fetch: (async () => {
      called = true
      return jsonResponse(200, {})
    }) as typeof fetch,
    readAuth: () => ({ access_type: 'Bearer', access_token: 'test-token' })
  })

  await assert.rejects(api.request({ path: 'https://attacker.invalid/next' }), (error: unknown) => {
    return error instanceof CliError && error.code === 'INVALID_API_RESPONSE' && error.exitCode === 5
  })
  assert.equal(called, false)
})

void test('authenticated API redirects are never followed while signed download redirects remain enabled', async t => {
  let targetRequests = 0
  let targetAuthorization: string | undefined
  const target = createServer((req, res) => {
    targetRequests++
    targetAuthorization = req.headers.authorization
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' })
    res.end(Uint8Array.from([80, 75, 3, 4]))
  })
  const targetUrl = await listen(t, target)

  const sourceAuthorizations: Array<string | undefined> = []
  const sourceBodies: string[] = []
  const source = createServer((req, res) => {
    if (req.url === '/signed-download') {
      res.writeHead(302, { Location: `${targetUrl}/signed-target` })
      res.end()
      return
    }

    let body = ''
    req.setEncoding('utf8')
    req.on('data', chunk => { body += String(chunk) })
    req.on('end', () => {
      sourceAuthorizations.push(req.headers.authorization)
      sourceBodies.push(body)
      const status = Number(req.url?.split('/').at(-1))
      res.writeHead(status, { Location: `${targetUrl}/api-target` })
      res.end()
    })
  })
  const sourceUrl = await listen(t, source)
  const api = new ApiClient(sourceUrl, {
    readAuth: () => ({ access_type: 'Bearer', access_token: 'test-token' })
  })

  const redirectStatuses = [301, 302, 303, 307, 308]
  for (const status of redirectStatuses) {
    await assert.rejects(api.request({
      method: 'POST',
      path: `/redirect/${String(status)}`,
      body: { data: { type: 'games', attributes: { title: 'Example' } } }
    }), (error: unknown) => {
      assert.ok(error instanceof CliError)
      assert.equal(error.code, `HTTP_${String(status)}`)
      assert.equal(error.status, status)
      assert.equal(error.retryable, false)
      assert.match(error.hint ?? '', /outcome may be unknown/i)
      assert.match(error.hint ?? '', /resource state/i)
      return true
    }, String(status))
  }

  assert.equal(targetRequests, 0)
  assert.deepEqual(sourceAuthorizations, redirectStatuses.map(() => 'Bearer test-token'))
  assert.equal(sourceBodies.length, redirectStatuses.length)
  assert.ok(sourceBodies.every(body => body.includes('"title":"Example"')))

  const download = await api.downloadExternal(`${sourceUrl}/signed-download`, readDownloadBody)
  assert.deepEqual([...download.body], [80, 75, 3, 4])
  assert.equal(targetRequests, 1)
  assert.equal(targetAuthorization, undefined)
})

void test('signed downloads never forward API credentials and reject unsupported URLs', async () => {
  let authorization: string | null | undefined
  let userAgent: string | null | undefined
  const api = new ApiClient('https://api.example.invalid', {
    fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      authorization = headers.get('Authorization')
      userAgent = headers.get('User-Agent')
      return new Response(Uint8Array.from([80, 75, 3, 4]), {
        status: 200,
        headers: { 'Content-Type': 'application/zip' }
      })
    }) as typeof fetch,
    readAuth: () => ({ access_type: 'Bearer', access_token: 'must-not-be-read' })
  })

  const response = await api.downloadExternal('https://downloads.example.invalid/version.zip', readDownloadBody)
  assert.equal(authorization, null)
  assert.equal(userAgent, CLI_USER_AGENT)
  assert.deepEqual([...response.body], [80, 75, 3, 4])

  await assert.rejects(api.downloadExternal('file:///tmp/version.zip', readDownloadBody), (error: unknown) => {
    assert.ok(error instanceof CliError)
    assert.equal(error.code, 'INVALID_API_RESPONSE')
    assert.deepEqual(error.details, { expected: 'absolute_http_or_https_url', received_kind: 'unsupported_protocol' })
    assert.doesNotMatch(JSON.stringify(errorDocument(error)), /file:|\/tmp\/version/)
    return true
  })

  await assert.rejects(api.downloadExternal('not-a-url-download-secret', readDownloadBody), (error: unknown) => {
    assert.ok(error instanceof CliError)
    assert.equal(error.code, 'INVALID_API_RESPONSE')
    assert.deepEqual(error.details, { expected: 'absolute_http_or_https_url', received_kind: 'invalid_url' })
    assert.doesNotMatch(JSON.stringify(error), /download-secret/)
    return true
  })
})

// A transport that never responds but honors the request AbortSignal the way
// fetch does: it rejects with an AbortError-like error when the signal fires.
function hangingTransport (): typeof fetch {
  return (async (_input: string | URL | Request, init?: RequestInit) => {
    return await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const error = new Error('This operation was aborted')
        error.name = 'AbortError'
        reject(error)
      })
    })
  }) as typeof fetch
}

function stalledBodyTransport (): typeof fetch {
  return (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = new ReadableStream<Uint8Array>({
      start (controller) {
        controller.enqueue(new TextEncoder().encode('{"partial":'))
        init?.signal?.addEventListener('abort', () => {
          const error = new Error('This operation was aborted while reading the response body')
          error.name = 'AbortError'
          controller.error(error)
        }, { once: true })
      }
    })
    return new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    })
  }) as typeof fetch
}

// A signed archive whose headers arrive at once but whose body only completes
// when the test releases it, so a test can hold one transfer open across a
// mocked deadline the way a multi-megabyte build does across a real one.
function slowArchiveTransport (transferStarted: () => void, released: Promise<void>): typeof fetch {
  return (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = new ReadableStream<Uint8Array>({
      start (controller) {
        init?.signal?.addEventListener('abort', () => {
          const error = new Error('This operation was aborted while streaming the archive')
          error.name = 'AbortError'
          controller.error(error)
        }, { once: true })
      },
      async pull (controller) {
        transferStarted()
        await released
        controller.enqueue(new TextEncoder().encode('archive-bytes'))
        controller.close()
      }
    })
    return new Response(body, { status: 200 })
  }) as typeof fetch
}

function releasable (): { released: Promise<void>, release: () => void } {
  let release: (() => void) | undefined
  const released = new Promise<void>(resolve => { release = resolve })
  return { released, release: () => release?.() }
}

function failedBodyTransport (): typeof fetch {
  return (async () => {
    const body = new ReadableStream<Uint8Array>({
      start (controller) {
        controller.error(new Error('response body stream failed'))
      }
    })
    return new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    })
  }) as typeof fetch
}

void test('API timeouts map to API_TIMEOUT and only reads are marked retryable', async () => {
  const api = new ApiClient('https://example.invalid', {
    fetch: hangingTransport(),
    readAuth: () => ({ access_type: 'Bearer', access_token: 'test-token' })
  })

  await assert.rejects(api.request({ path: '/games', timeoutMs: 10 }), (error: unknown) => {
    return error instanceof CliError &&
      error.code === 'API_TIMEOUT' &&
      error.exitCode === 5 &&
      error.retryable &&
      (error.hint ?? '').includes('Retry the read')
  })

  await assert.rejects(api.request({ method: 'POST', path: '/games', body: { data: {} }, timeoutMs: 10 }), (error: unknown) => {
    return error instanceof CliError &&
      error.code === 'API_TIMEOUT' &&
      error.exitCode === 5 &&
      !error.retryable &&
      (error.hint ?? '').includes('resource state')
  })
})

void test('API timeouts remain active while response bodies are consumed', async () => {
  const api = new ApiClient('https://example.invalid', {
    fetch: stalledBodyTransport(),
    readAuth: () => ({ access_type: 'Bearer', access_token: 'test-token' })
  })

  await assert.rejects(api.request({ path: '/games', timeoutMs: 20 }), (error: unknown) => {
    return error instanceof CliError &&
      error.code === 'API_TIMEOUT' &&
      error.retryable &&
      (error.hint ?? '').includes('Retry the read')
  })

  await assert.rejects(api.request({ method: 'POST', path: '/games', body: { data: {} }, timeoutMs: 20 }), (error: unknown) => {
    return error instanceof CliError &&
      error.code === 'API_TIMEOUT' &&
      !error.retryable &&
      (error.hint ?? '').includes('resource state')
  })

  await assert.rejects(api.request({ method: 'POST', path: '/_data', body: {}, retrySafe: true, timeoutMs: 20 }), (error: unknown) => {
    return error instanceof CliError && error.code === 'API_TIMEOUT' && error.retryable
  })

  await assert.rejects(api.downloadExternal('https://downloads.example.invalid/version.zip', readDownloadBody, 20), (error: unknown) => {
    return error instanceof CliError &&
      error.code === 'API_TIMEOUT' &&
      error.retryable &&
      (error.hint ?? '').includes('signed URL')
  })
})

void test('response body read failures use method-aware network error classification', async () => {
  const api = new ApiClient('https://example.invalid', {
    fetch: failedBodyTransport(),
    readAuth: () => ({ access_type: 'Bearer', access_token: 'test-token' })
  })

  await assert.rejects(api.request({ path: '/games' }), (error: unknown) => {
    assert.ok(error instanceof CliError)
    assert.equal(error.code, 'NETWORK_ERROR')
    assert.equal(error.retryable, true)
    assert.equal(error.details, undefined)
    assert.doesNotMatch(JSON.stringify(errorDocument(error)), /response body stream failed/)
    return true
  })

  await assert.rejects(api.request({ method: 'POST', path: '/games', body: { data: {} } }), (error: unknown) => {
    return error instanceof CliError &&
      error.code === 'NETWORK_ERROR' &&
      !error.retryable &&
      (error.hint ?? '').includes('outcome may be unknown')
  })
})

void test('signed download timeouts and HTTP failures use their documented classes', async () => {
  const timedOut = new ApiClient('https://api.example.invalid', {
    fetch: hangingTransport(),
    readAuth: () => ({ access_type: 'Bearer', access_token: 'test-token' })
  })
  await assert.rejects(timedOut.downloadExternal('https://downloads.example.invalid/version.zip', readDownloadBody, 10), (error: unknown) => {
    assert.ok(error instanceof CliError)
    assert.equal(error.code, 'API_TIMEOUT')
    assert.equal(error.exitCode, 5)
    assert.equal(error.retryable, true)
    assert.deepEqual(error.details, { timeout_ms: 10 })
    assert.match(error.hint ?? '', /signed URL/)
    assert.doesNotMatch(JSON.stringify(errorDocument(error)), /downloads\.example\.invalid/)
    return true
  })

  const failed = new ApiClient('https://api.example.invalid', {
    fetch: (async () => { throw new Error('transport-secret-from-signed-host') }) as typeof fetch,
    readAuth: () => ({ access_type: 'Bearer', access_token: 'test-token' })
  })
  await assert.rejects(failed.downloadExternal('https://private-download.example.invalid/secret.zip', readDownloadBody), (error: unknown) => {
    assert.ok(error instanceof CliError)
    assert.equal(error.code, 'NETWORK_ERROR')
    assert.equal(error.details, undefined)
    assert.doesNotMatch(JSON.stringify(errorDocument(error)), /transport-secret|private-download|secret\.zip/)
    return true
  })

  const clientFor = (status: number): ApiClient => new ApiClient('https://api.example.invalid', {
    fetch: (async () => new Response('missing', { status })) as typeof fetch,
    readAuth: () => ({ access_type: 'Bearer', access_token: 'test-token' })
  })
  await assert.rejects(clientFor(404).downloadExternal('https://downloads.example.invalid/version.zip', readDownloadBody), (error: unknown) => {
    return error instanceof CliError &&
      error.code === 'HTTP_404' &&
      error.status === 404 &&
      error.exitCode === 4 &&
      !error.retryable
  })
  await assert.rejects(clientFor(503).downloadExternal('https://downloads.example.invalid/version.zip', readDownloadBody), (error: unknown) => {
    return error instanceof CliError &&
      error.code === 'HTTP_503' &&
      error.exitCode === 5 &&
      error.retryable
  })

  let cancelled = false
  const stalledFailure = new ApiClient('https://api.example.invalid', {
    fetch: (async () => new Response(new ReadableStream<Uint8Array>({
      cancel () {
        cancelled = true
      }
    }), { status: 503 })) as typeof fetch,
    readAuth: () => ({ access_type: 'Bearer', access_token: 'test-token' })
  })
  await assert.rejects(stalledFailure.downloadExternal('https://downloads.example.invalid/version.zip', readDownloadBody), (error: unknown) => {
    return error instanceof CliError && error.code === 'HTTP_503'
  })
  assert.equal(cancelled, true)
})

void test('a signed archive transfer outlives the ordinary request budget but honors an explicit timeout', async t => {
  enableSetTimeoutMock(t)
  const clientFor = (transport: typeof fetch): ApiClient => new ApiClient('https://api.example.invalid', {
    fetch: transport,
    readAuth: () => ({ access_type: 'Bearer', access_token: 'unused' })
  })

  const slow = releasable()
  const slowStarted = releasable()
  const transfer = clientFor(slowArchiveTransport(slowStarted.release, slow.released))
    .downloadExternal('https://downloads.example.invalid/version.zip', readDownloadBody)
  await slowStarted.released
  // Longer than the 30000 ms ordinary request budget, well inside the download
  // one: a multi-megabyte archive must not be aborted and discarded here.
  t.mock.timers.tick(60000)
  slow.release()
  assert.equal(new TextDecoder().decode((await transfer).body), 'archive-bytes')

  const boundedStarted = releasable()
  const bounded = clientFor(slowArchiveTransport(boundedStarted.release, releasable().released))
    .downloadExternal('https://downloads.example.invalid/version.zip', readDownloadBody, 45000)
  await boundedStarted.released
  t.mock.timers.tick(60000)
  await assert.rejects(bounded, (error: unknown) => {
    assert.ok(error instanceof CliError)
    assert.equal(error.code, 'API_TIMEOUT')
    assert.deepEqual(error.details, { timeout_ms: 45000 })
    return true
  })
})

void test('POKI_API_TIMEOUT_MS accepts only supported integer milliseconds and otherwise uses the 30000 ms fallback', () => {
  const original = process.env.POKI_API_TIMEOUT_MS
  try {
    process.env.POKI_API_TIMEOUT_MS = 'soon'
    assert.equal(new ApiClient('https://example.invalid').timeoutMs, 30000)
    process.env.POKI_API_TIMEOUT_MS = '-5'
    assert.equal(new ApiClient('https://example.invalid').timeoutMs, 30000)
    process.env.POKI_API_TIMEOUT_MS = '0'
    assert.equal(new ApiClient('https://example.invalid').timeoutMs, 30000)
    process.env.POKI_API_TIMEOUT_MS = '1.5'
    assert.equal(new ApiClient('https://example.invalid').timeoutMs, 30000)
    process.env.POKI_API_TIMEOUT_MS = '2147483648'
    assert.equal(new ApiClient('https://example.invalid').timeoutMs, 30000)
    process.env.POKI_API_TIMEOUT_MS = '2147483647'
    assert.equal(new ApiClient('https://example.invalid').timeoutMs, 2147483647)
    process.env.POKI_API_TIMEOUT_MS = '2500'
    assert.equal(new ApiClient('https://example.invalid').timeoutMs, 2500)
    delete process.env.POKI_API_TIMEOUT_MS
    assert.equal(new ApiClient('https://example.invalid').timeoutMs, 30000)
  } finally {
    if (original === undefined) delete process.env.POKI_API_TIMEOUT_MS; else process.env.POKI_API_TIMEOUT_MS = original
  }
})

void test('multipart uploads and signed archive downloads get the longer timeout ceiling', () => {
  const original = process.env.POKI_API_TIMEOUT_MS
  try {
    delete process.env.POKI_API_TIMEOUT_MS
    const defaults = new ApiClient('https://example.invalid')
    assert.equal(defaults.timeoutMs, 30000)
    assert.equal(defaults.uploadTimeoutMs, 300000)
    assert.equal(defaults.downloadTimeoutMs, 300000)

    // A single POKI_API_TIMEOUT_MS override governs every ceiling.
    process.env.POKI_API_TIMEOUT_MS = '5000'
    const overridden = new ApiClient('https://example.invalid')
    assert.equal(overridden.timeoutMs, 5000)
    assert.equal(overridden.uploadTimeoutMs, 5000)
    assert.equal(overridden.downloadTimeoutMs, 5000)
  } finally {
    if (original === undefined) delete process.env.POKI_API_TIMEOUT_MS; else process.env.POKI_API_TIMEOUT_MS = original
  }
})

void test('errorDocument never emits an empty or undefined details key', () => {
  assert.deepEqual(errorDocument(new Error('boom')), {
    error: { code: 'UNEXPECTED_ERROR', message: 'boom', retryable: false }
  })
  assert.deepEqual(errorDocument(new CliError('EXAMPLE', 'no details', 4)), {
    error: { code: 'EXAMPLE', message: 'no details', retryable: false }
  })
  assert.equal('details' in errorDocument(new Error('boom')).error, false)
})

void test('safeErrorCause omits arbitrary command details while preserving recovery-relevant outer fields', () => {
  const cause = safeErrorCause(new CliError('EXAMPLE', 'Example failure.', 5, {
    status: 502,
    details: { arbitrary: { secret: true } },
    hint: 'Use the documented recovery action.',
    retryable: true,
    requestId: 'req-2',
    retryAfter: '3'
  }))

  assert.deepEqual(cause, {
    code: 'EXAMPLE',
    message: 'Example failure.',
    status: 502,
    retryable: true,
    request_id: 'req-2',
    retry_after: '3',
    hint: 'Use the documented recovery action.'
  })
  assert.doesNotMatch(JSON.stringify(cause), /secret|arbitrary/)
})
