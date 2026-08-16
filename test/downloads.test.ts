import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { link } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { ApiClient } from '../src/api'
import { responseLocation, writeDownload } from '../src/commands/common'
import { CliError, errorDocument } from '../src/errors'
import { apiHarness, completion, jsonApi, parseToon, spawnCli, temporaryDirectory } from './helpers'

function temporaryDownloads (directory: string): string[] {
  return readdirSync(directory).filter(name => name.includes('.poki-download-'))
}

void test('signed response locations must be non-empty strings', () => {
  for (const location of ['', '   ', '\n\t']) {
    assert.throws(() => responseLocation({ location, private_secret: 'hidden' }, 'a download location'), (error: unknown) => {
      assert.ok(error instanceof CliError)
      assert.equal(error.code, 'INVALID_API_RESPONSE')
      assert.deepEqual(error.details, { expected: 'non_empty_location_string', received_kind: 'empty_string' })
      assert.doesNotMatch(JSON.stringify(errorDocument(error)), /private_secret|hidden/)
      return true
    })
  }
})

void test('download writes follow stream backpressure and publish only the complete file', async t => {
  const directory = temporaryDirectory(t, 'stream-download')
  const destination = join(directory, 'version.zip')
  const encoder = new TextEncoder()
  let pulls = 0
  let releaseSecondChunk: (() => void) | undefined
  const secondChunkReleased = new Promise<void>(resolve => { releaseSecondChunk = resolve })
  let requestedSecondChunk: (() => void) | undefined
  const secondChunkRequested = new Promise<void>(resolve => { requestedSecondChunk = resolve })

  const body = new ReadableStream<Uint8Array>({
    async pull (controller) {
      pulls++
      if (pulls === 1) {
        controller.enqueue(encoder.encode('first-'))
        return
      }
      requestedSecondChunk?.()
      await secondChunkReleased
      controller.enqueue(encoder.encode('second'))
      controller.close()
    }
  }, { highWaterMark: 0 })

  const writing = writeDownload(destination, body)
  await secondChunkRequested
  assert.equal(pulls, 2)
  assert.equal(existsSync(destination), false, 'a partial download must not be published')
  assert.equal(temporaryDownloads(directory).length, 1)

  releaseSecondChunk?.()
  const bytes = await writing
  assert.equal(bytes, Buffer.byteLength('first-second'))
  assert.equal(readFileSync(destination, 'utf8'), 'first-second')
  assert.deepEqual(temporaryDownloads(directory), [])
})

void test('concurrent no-force publications never replace the winning destination', async t => {
  const directory = temporaryDirectory(t, 'no-clobber-download')
  const destination = join(directory, 'version.zip')
  const attempts = 8
  let ready = 0
  let release: (() => void) | undefined
  const released = new Promise<void>(resolve => { release = resolve })
  let allReady: (() => void) | undefined
  const readyToPublish = new Promise<void>(resolve => { allReady = resolve })

  const writes = Array.from({ length: attempts }, async (_, index) => {
    let sent = false
    const body = new ReadableStream<Uint8Array>({
      async pull (controller) {
        if (!sent) {
          sent = true
          controller.enqueue(new TextEncoder().encode(`complete-${String(index)}`))
          return
        }
        ready++
        if (ready === attempts) allReady?.()
        await released
        controller.close()
      }
    }, { highWaterMark: 0 })
    return await writeDownload(destination, body)
  })

  await readyToPublish
  release?.()
  const results = await Promise.allSettled(writes)
  const winners = results.flatMap((result, index) => result.status === 'fulfilled' ? [index] : [])
  assert.equal(winners.length, 1)
  assert.equal(readFileSync(destination, 'utf8'), `complete-${String(winners[0])}`)
  for (const result of results) {
    if (result.status === 'fulfilled') continue
    assert.ok(result.reason instanceof CliError)
    assert.equal(result.reason.code, 'INVALID_INPUT')
    assert.match(result.reason.message, /--force/)
  }
  assert.deepEqual(temporaryDownloads(directory), [])
})

function completeBody (text: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start (controller) {
      controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    }
  })
}

// exFAT and FAT volumes, and parts of some network and container mounts, do not
// implement hard links, so the publication primitive is simply unavailable
// there. It used to surface as "Could not write '<destination>'" for a
// destination that was perfectly writable, which made the download impossible
// rather than merely unverified.
function linkUnavailable (code: string): typeof link {
  return (async () => {
    const error: NodeJS.ErrnoException = new Error(`hard links are unavailable (${code})`)
    error.code = code
    throw error
  }) as typeof link
}

void test('a download publishes on filesystems without hard links', async t => {
  for (const code of ['EPERM', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'EMLINK']) {
    const directory = temporaryDirectory(t, `no-hardlink-${code}`)
    const destination = join(directory, 'version.zip')

    const bytes = await writeDownload(destination, completeBody('complete-archive'), false, linkUnavailable(code))

    assert.equal(bytes, Buffer.byteLength('complete-archive'), code)
    assert.equal(readFileSync(destination, 'utf8'), 'complete-archive', code)
    assert.deepEqual(temporaryDownloads(directory), [], code)
  }
})

void test('the no-hard-link fallback still refuses an existing destination without --force', async t => {
  const directory = temporaryDirectory(t, 'no-hardlink-existing')
  const destination = join(directory, 'version.zip')
  writeFileSync(destination, 'original-bytes')

  await assert.rejects(
    writeDownload(destination, completeBody('replacement'), false, linkUnavailable('EPERM')),
    (error: unknown) => {
      assert.ok(error instanceof CliError)
      assert.equal(error.code, 'INVALID_INPUT')
      assert.match(error.message, /--force/)
      return true
    }
  )
  assert.equal(readFileSync(destination, 'utf8'), 'original-bytes')
  assert.deepEqual(temporaryDownloads(directory), [])
})

// The exclusive create is the same atomic test-and-set the hard link performed,
// so losing the race still has to mean losing it completely.
void test('concurrent no-hard-link publications never replace the winning destination', async t => {
  const directory = temporaryDirectory(t, 'no-hardlink-race')
  const destination = join(directory, 'version.zip')
  const attempts = 8
  let ready = 0
  let release: (() => void) | undefined
  const released = new Promise<void>(resolve => { release = resolve })
  let allReady: (() => void) | undefined
  const readyToPublish = new Promise<void>(resolve => { allReady = resolve })

  const writes = Array.from({ length: attempts }, async (_, index) => {
    let sent = false
    const body = new ReadableStream<Uint8Array>({
      async pull (controller) {
        if (!sent) {
          sent = true
          controller.enqueue(new TextEncoder().encode(`complete-${String(index)}`))
          return
        }
        ready++
        if (ready === attempts) allReady?.()
        await released
        controller.close()
      }
    }, { highWaterMark: 0 })
    return await writeDownload(destination, body, false, linkUnavailable('EPERM'))
  })

  await readyToPublish
  release?.()
  const results = await Promise.allSettled(writes)
  const winners = results.flatMap((result, index) => result.status === 'fulfilled' ? [index] : [])
  assert.equal(winners.length, 1)
  assert.equal(readFileSync(destination, 'utf8'), `complete-${String(winners[0])}`)
  for (const result of results) {
    if (result.status === 'fulfilled') continue
    assert.ok(result.reason instanceof CliError)
    assert.equal(result.reason.code, 'INVALID_INPUT')
    assert.match(result.reason.message, /--force/)
  }
  assert.deepEqual(temporaryDownloads(directory), [])
})

// Only errno values that mean "this filesystem has no hard links" select the
// fallback. Anything else is a real failure and must still be reported.
void test('an unrelated link failure is reported rather than silently retried', async t => {
  const directory = temporaryDirectory(t, 'link-failure')
  const destination = join(directory, 'version.zip')

  await assert.rejects(
    writeDownload(destination, completeBody('archive'), false, linkUnavailable('EIO')),
    (error: unknown) => {
      assert.ok(error instanceof CliError)
      assert.equal(error.code, 'INVALID_INPUT')
      assert.match(error.message, /EIO/)
      return true
    }
  )
  assert.equal(existsSync(destination), false, 'nothing is published when publication failed')
  assert.deepEqual(temporaryDownloads(directory), [])
})

void test('a signed body failure keeps the force destination and removes its temporary file', async t => {
  const directory = temporaryDirectory(t, 'failed-download')
  const destination = join(directory, 'existing.zip')
  writeFileSync(destination, 'original-bytes')
  let pulls = 0
  const body = new ReadableStream<Uint8Array>({
    pull (controller) {
      pulls++
      if (pulls === 1) {
        controller.enqueue(new TextEncoder().encode('partial-secret-bytes'))
        return
      }
      controller.error(new Error('signed-body-transport-secret'))
    }
  }, { highWaterMark: 0 })
  const api = new ApiClient('https://api.example.invalid', {
    fetch: (async () => new Response(body, { status: 200 })) as typeof fetch,
    readAuth: () => ({ access_type: 'Bearer', access_token: 'unused' })
  })

  await assert.rejects(api.downloadExternal(
    'https://downloads.example.invalid/version.zip',
    async responseBody => await writeDownload(destination, responseBody, true)
  ), (error: unknown) => {
    assert.ok(error instanceof CliError)
    assert.equal(error.code, 'NETWORK_ERROR')
    assert.equal(error.message, 'Could not reach the signed download location.')
    assert.doesNotMatch(JSON.stringify(errorDocument(error)), /signed-body-transport-secret|partial-secret-bytes/)
    return true
  })
  assert.equal(readFileSync(destination, 'utf8'), 'original-bytes')
  assert.deepEqual(temporaryDownloads(directory), [])
})

void test('a stalled signed body times out without replacing the force destination', async t => {
  const directory = temporaryDirectory(t, 'timeout-download')
  const destination = join(directory, 'existing.zip')
  writeFileSync(destination, 'original-bytes')
  const api = new ApiClient('https://api.example.invalid', {
    fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start (controller) {
          controller.enqueue(new TextEncoder().encode('partial'))
          init?.signal?.addEventListener('abort', () => {
            const error = new Error('private timeout transport detail')
            error.name = 'AbortError'
            controller.error(error)
          }, { once: true })
        }
      })
      return new Response(body, { status: 200 })
    }) as typeof fetch,
    readAuth: () => ({ access_type: 'Bearer', access_token: 'unused' })
  })

  await assert.rejects(api.downloadExternal(
    'https://downloads.example.invalid/version.zip',
    async body => await writeDownload(destination, body, true),
    20
  ), (error: unknown) => {
    assert.ok(error instanceof CliError)
    assert.equal(error.code, 'API_TIMEOUT')
    assert.equal(error.retryable, true)
    assert.doesNotMatch(JSON.stringify(errorDocument(error)), /private timeout transport detail/)
    return true
  })
  assert.equal(readFileSync(destination, 'utf8'), 'original-bytes')
  assert.deepEqual(temporaryDownloads(directory), [])
})

void test('an empty signed body creates an empty file and local write failures stay INVALID_INPUT', async t => {
  const directory = temporaryDirectory(t, 'empty-download')
  const emptyDestination = join(directory, 'empty.zip')
  assert.equal(await writeDownload(emptyDestination, null), 0)
  assert.equal(readFileSync(emptyDestination).byteLength, 0)

  const parentFile = join(directory, 'not-a-directory')
  writeFileSync(parentFile, 'file')
  const api = new ApiClient('https://api.example.invalid', {
    fetch: (async () => new Response('download-bytes', { status: 200 })) as typeof fetch,
    readAuth: () => ({ access_type: 'Bearer', access_token: 'unused' })
  })
  await assert.rejects(api.downloadExternal(
    'https://downloads.example.invalid/version.zip',
    async body => await writeDownload(join(parentFile, 'version.zip'), body)
  ), (error: unknown) => {
    return error instanceof CliError && error.code === 'INVALID_INPUT' && error.exitCode === 2
  })
})

void test('streaming preserves long destination basenames accepted by direct file writes', async t => {
  const directory = temporaryDirectory(t, 'long-download-name')
  // Common filesystems accept 255-byte basenames. The temporary filename must
  // not append its own suffix to this user-provided name and exceed that limit.
  const destination = join(directory, `${'x'.repeat(220)}.zip`)
  const body = new Response('streamed-bytes').body

  assert.equal(await writeDownload(destination, body), Buffer.byteLength('streamed-bytes'))
  assert.equal(readFileSync(destination, 'utf8'), 'streamed-bytes')
  assert.deepEqual(temporaryDownloads(directory), [])
})

// A signal never runs the finally that removes the partial download, so the
// interrupt cleanup registry is the only thing standing between an interrupted
// transfer and a hidden partial file left in the user's output directory.
void test('an interrupted download removes its partial file and reports INTERRUPTED', {
  skip: process.platform === 'win32'
    ? 'child_process.kill cannot deliver a catchable POSIX signal on Windows'
    : false
}, async t => {
  let streaming: NodeJS.Timeout | undefined
  const { directory, env } = await apiHarness(t, (req, res) => {
    if (req.url?.startsWith('/games/') === true) {
      jsonApi(res, { location: '/signed/version.zip' })
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': '999999999' })
    streaming = setInterval(() => res.write(Buffer.alloc(1024)), 20)
    res.on('close', () => clearInterval(streaming))
  }, 'download-interrupt')
  t.after(() => clearInterval(streaming))
  const output = join(directory, 'out')
  mkdirSync(output)

  const destination = join(output, 'build.zip')
  const child = spawnCli(['versions', 'download', 'V', '--game', 'g', '--type', 'source', '--output', destination], { env })
  const finished = completion(child)
  await new Promise(resolve => setTimeout(resolve, 1500))
  assert.equal(temporaryDownloads(output).length, 1, 'the transfer should be in progress with a temporary file')

  child.kill('SIGINT')
  const result = await finished
  assert.equal(result.code, 130, result.stderr)
  const error = JSON.parse(JSON.stringify(parseToon(result.stderr))).error
  assert.equal(error.code, 'INTERRUPTED')
  assert.equal(error.retryable, false)
  assert.deepEqual(temporaryDownloads(output), [], 'the partial download must not survive the interrupt')
  assert.equal(existsSync(destination), false, 'an interrupted transfer must not publish a destination')
})
