import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { createServer, request as httpRequest, IncomingMessage, RequestOptions } from 'node:http'
import { Socket } from 'node:net'
import { join } from 'node:path'
import test, { TestContext } from 'node:test'

import { runInterruptCleanups } from '../src/errors'
import { LegacyTransport, postToP4D } from '../src/p4d'
import { formatBytes, ProgressOutput, uploadProgress, uploadProgressLine } from '../src/upload-progress'
import { temporaryDirectory } from './helpers'

function recordingOutput (isTTY: boolean, columns = 80): ProgressOutput & { writes: string[] } {
  const writes: string[] = []
  return { isTTY, columns, writes, write: text => writes.push(text) }
}

void test('formatBytes uses decimal units and never shows 1000 of a unit', () => {
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(999), '999 B')
  assert.equal(formatBytes(1000), '1.0 KB')
  assert.equal(formatBytes(999_999), '1.0 MB')
  assert.equal(formatBytes(12_345_678), '12.3 MB')
  assert.equal(formatBytes(2_500_000_000), '2.5 GB')
})

void test('uploadProgressLine shows the bar, percentage, bytes, and rate', () => {
  assert.equal(uploadProgressLine(0, 2000, 0), `[${'-'.repeat(30)}]   0%  0 B / 2.0 KB`)
  assert.equal(uploadProgressLine(1000, 2000, 1000), `[${'#'.repeat(15)}${'-'.repeat(15)}]  50%  1.0 KB / 2.0 KB  1.0 KB/s`)
  assert.equal(uploadProgressLine(2000, 2000, 500), `[${'#'.repeat(30)}] 100%  2.0 KB / 2.0 KB  4.0 KB/s`)
})

void test('uploadProgressLine never fills or wraps the terminal', () => {
  const samples: Array<[number, number, number]> = [
    [0, 8_400_000, 0],
    [123_456, 8_400_000, 900],
    [123_456_789, 987_654_321, 12_345],
    [987_654_321, 987_654_321, 1]
  ]
  for (let columns = 1; columns <= 120; columns++) {
    for (const [sent, total, elapsed] of samples) {
      const line = uploadProgressLine(sent, total, elapsed, columns)
      assert.ok(line.length < columns || (columns === 1 && line === ''), `${line.length} < ${columns}: ${line}`)
    }
  }
})

void test('uploadProgressLine sheds detail on narrow terminals but keeps the percentage', () => {
  const [sent, total, elapsed] = [123_456, 8_400_000, 900]
  assert.equal(uploadProgressLine(sent, total, elapsed, 80), `[${'-'.repeat(30)}]   1%  123.5 KB / 8.4 MB  137.2 KB/s`)
  assert.equal(uploadProgressLine(sent, total, elapsed, 40), `[${'-'.repeat(13)}]   1%  123.5 KB / 8.4 MB`)
  assert.equal(uploadProgressLine(sent, total, elapsed, 20), `[${'-'.repeat(12)}]   1%`)
  assert.equal(uploadProgressLine(sent, total, elapsed, 10), '  1%')
  assert.equal(uploadProgressLine(total, total, elapsed, 4), '100')
})

void test('uploadProgress writes nothing when the output is not a terminal', () => {
  const output = recordingOutput(false)
  const progress = uploadProgress(100, output)
  progress.update(50)
  progress.update(100)
  progress.finish()
  assert.deepEqual(output.writes, [])
})

void test('uploadProgress throttles redraws and ends its line exactly once', () => {
  const output = recordingOutput(true)
  let clock = 0
  const progress = uploadProgress(1000, output, () => clock)
  assert.equal(output.writes.length, 1, 'renders 0% immediately')

  clock = 50
  progress.update(100)
  assert.equal(output.writes.length, 1, 'skips redraws inside the render interval')

  clock = 150
  progress.update(400)
  assert.equal(output.writes.length, 2)
  assert.equal(output.writes[1], `\r${uploadProgressLine(400, 1000, 150)}\x1b[K`)

  clock = 160
  progress.update(1000)
  assert.equal(output.writes.length, 3, 'always draws the final 100%')
  assert.equal(output.writes[2], `\r${uploadProgressLine(1000, 1000, 160)}\x1b[K`)

  progress.finish()
  progress.finish()
  progress.update(1000)
  assert.deepEqual(output.writes.slice(3), ['\n'])
})

void test('uploadProgress redraws the latest count before ending an interrupted line', () => {
  const output = recordingOutput(true)
  let clock = 0
  const progress = uploadProgress(1000, output, () => clock)
  clock = 10
  progress.update(300)
  progress.finish()
  assert.equal(output.writes[1], `\r${uploadProgressLine(300, 1000, 10)}\x1b[K`)
  assert.equal(output.writes[2], '\n')
})

async function uploadThroughLoopback (t: TestContext, output: ProgressOutput): Promise<{ archive: Buffer, received: Buffer, contentLength: number, logs: unknown[][] }> {
  const directory = temporaryDirectory(t, 'upload-progress')
  const archivePath = join(directory, 'build.zip')
  // Several slices, and not a multiple of the slice size.
  const archive = randomBytes(300 * 1024 + 123)
  writeFileSync(archivePath, archive)

  let received = Buffer.alloc(0)
  let contentLength = -1
  const server = createServer((req, res) => {
    contentLength = Number(req.headers['content-length'])
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      received = Buffer.concat(chunks)
      res.writeHead(201, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ game_id: 'game-1', id: 42 }))
    })
  })
  t.after(() => server.close())
  const port = await new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    assert.ok(address !== null && typeof address !== 'string')
    resolve(address.port)
  }))

  const transport = ((options: RequestOptions, callback?: (res: IncomingMessage) => void) => httpRequest({
    ...options,
    protocol: 'http:',
    hostname: '127.0.0.1',
    port,
    agent: false
  }, callback)) as LegacyTransport

  const logs: unknown[][] = []
  const originalLog = console.log
  console.log = (...args: unknown[]) => { logs.push(args) }
  const previousToken = process.env.POKI_UPLOAD_TOKEN
  process.env.POKI_UPLOAD_TOKEN = 'tok'
  t.after(() => {
    console.log = originalLog
    if (previousToken === undefined) delete process.env.POKI_UPLOAD_TOKEN
    else process.env.POKI_UPLOAD_TOKEN = previousToken
  })

  const data = await postToP4D('game-1', archivePath, 'Release', undefined, false, false, transport, output)
  assert.deepEqual(data, { game_id: 'game-1', id: 42 })
  return { archive, received, contentLength, logs }
}

void test('legacy upload draws progress on a terminal and still sends the exact body', async t => {
  const output = recordingOutput(true)
  const { archive, received, contentLength, logs } = await uploadThroughLoopback(t, output)

  assert.equal(contentLength, received.length, 'Content-Length matches the sliced body')
  assert.ok(received.includes(archive), 'the archive bytes arrive intact')
  assert.deepEqual(logs, [['uploading...']], 'the human text is unchanged')

  const lines = output.writes.filter(text => text !== '\n')
  assert.ok(lines.length >= 2, 'draws at least the start and the end')
  const total = formatBytes(received.length)
  assert.ok(lines[0].startsWith(`\r[${'-'.repeat(30)}]   0%  0 B / ${total}`), lines[0])
  assert.ok(lines[lines.length - 1].startsWith(`\r[${'#'.repeat(30)}] 100%  ${total} / ${total}`), lines[lines.length - 1])
  assert.deepEqual(output.writes.filter(text => text === '\n'), ['\n'], 'ends the line exactly once')
  assert.equal(output.writes[output.writes.length - 1], '\n')

  const written = output.writes.length
  runInterruptCleanups()
  assert.equal(output.writes.length, written, 'a settled upload leaves no interrupt cleanup behind')
})

void test('an interrupt mid-upload ends the progress line before the error is reported', async t => {
  const directory = temporaryDirectory(t, 'upload-interrupt')
  const archivePath = join(directory, 'build.zip')
  // Far more than the loopback socket buffers hold, so with the server not
  // reading, the body is provably still being sent when the interrupt lands.
  writeFileSync(archivePath, randomBytes(32 * 1024 * 1024))

  const connections: Socket[] = []
  let requestArrived: () => void = () => {}
  const arrived = new Promise<void>(resolve => { requestArrived = resolve })
  const server = createServer(req => {
    // Never read the body or answer, so the upload stays open.
    req.pause()
    requestArrived()
  })
  server.on('connection', socket => connections.push(socket))
  t.after(() => {
    for (const socket of connections) socket.destroy()
    server.close()
  })
  const port = await new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    assert.ok(address !== null && typeof address !== 'string')
    resolve(address.port)
  }))
  const transport = ((options: RequestOptions, callback?: (res: IncomingMessage) => void) => httpRequest({
    ...options,
    protocol: 'http:',
    hostname: '127.0.0.1',
    port,
    agent: false
  }, callback)) as LegacyTransport

  const originalLog = console.log
  console.log = () => {}
  const previousTimeout = process.env.POKI_API_TIMEOUT_MS
  const previousToken = process.env.POKI_UPLOAD_TOKEN
  process.env.POKI_API_TIMEOUT_MS = '300'
  process.env.POKI_UPLOAD_TOKEN = 'tok'
  t.after(() => {
    console.log = originalLog
    if (previousTimeout === undefined) delete process.env.POKI_API_TIMEOUT_MS
    else process.env.POKI_API_TIMEOUT_MS = previousTimeout
    if (previousToken === undefined) delete process.env.POKI_UPLOAD_TOKEN
    else process.env.POKI_UPLOAD_TOKEN = previousToken
  })

  const output = recordingOutput(true)
  const outcome = postToP4D('game-1', archivePath, 'Release', undefined, false, false, transport, output)
    .then(() => undefined, (error: unknown) => error)
  await arrived
  assert.ok(output.writes.length > 0, 'the progress line is on screen')
  assert.notEqual(output.writes[output.writes.length - 1], '\n', 'and still open')

  // What the SIGINT handler in src/process.ts runs before writing the error.
  runInterruptCleanups()
  assert.equal(output.writes[output.writes.length - 1], '\n')

  // The request then times out; settling must not end the line a second time.
  assert.ok(await outcome instanceof Error)
  assert.deepEqual(output.writes.filter(text => text === '\n'), ['\n'])
})

void test('legacy upload output is unchanged when stdout is not a terminal', async t => {
  const output = recordingOutput(false)
  const { archive, received, logs } = await uploadThroughLoopback(t, output)

  assert.ok(received.includes(archive))
  assert.deepEqual(logs, [['uploading...']])
  assert.deepEqual(output.writes, [])
})
