import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { decode } from '@toon-format/toon'
import test from 'node:test'

import { renderList } from '../src/commands/rendering'
import { developerFieldsForKind } from '../src/developer-surface'
import { helpDocument } from '../src/docs/commands'
import { CliError } from '../src/errors'
import { csvString, requestedFormat, structuredString } from '../src/output'
import { applyListView, resourceSummaryFields, ResourceListKind } from '../src/views'
import { authEnvironment, jsonApi, listen, runCli, temporaryDirectory } from './helpers'

void test('TOON output losslessly preserves JSON data and JSON output is minified', () => {
  const value = {
    data: [
      { type: 'games', id: 'game-1', title: 'One', nullable: null, tags: ['a', 'b'] },
      { type: 'games', id: 'game-2', title: 'Two', nullable: null, tags: ['c'] }
    ],
    meta: {
      timestamp: '2026-08-05T12:00:00Z',
      relationship: { type: 'teams', id: 'team-1' },
      unknown_server_field: { enabled: true }
    }
  }

  const toon = structuredString(value)
  const json = structuredString(value, 'json')
  assert.deepEqual(decode(toon), value)
  assert.deepEqual(JSON.parse(json), value)
  assert.ok(toon.endsWith('\n'))
  assert.ok(json.endsWith('\n'))
  assert.doesNotMatch(json, /\n\s+/)
  assert.equal(requestedFormat(['games', 'list', '--format', 'json']), 'json')
  assert.equal(requestedFormat(['games', 'list']), 'toon')
})

void test('TOON output round-trips hostile strings, numbers, and empty containers', () => {
  const fixture = {
    tabbed: 'before\tafter',
    newline: 'line one\nline two',
    quoted: 'she said "hello" twice',
    leading_dash: '-starts-with-dash',
    leading_equals: '=starts-with-equals',
    leading_colon: ':starts-with-colon',
    unicode: 'emoji 🎮🚀 with CJK 汉字 and kana テスト',
    empty_string: '',
    empty_array: [],
    empty_object: {},
    zero: 0,
    negative_fraction: -1.5,
    huge: 1e21,
    long_string: 'x'.repeat(5000)
  }

  const toon = structuredString(fixture)
  assert.deepEqual(decode(toon), fixture)
  assert.ok(toon.endsWith('\n'))
  const json = structuredString(fixture, 'json')
  assert.deepEqual(JSON.parse(json), fixture)

  // The same values must survive inside a realistic list document.
  const document = { data: [fixture, { ...fixture, zero: 1 }], meta: { total: 2 } }
  assert.deepEqual(decode(structuredString(document)), document)
})

// renderList writes CSV straight to stdout, so its contract is observed by
// capturing that stream instead of a returned document.
function captureStdout (run: () => void): string {
  const chunks: string[] = []
  const original = process.stdout.write
  process.stdout.write = ((chunk: unknown): boolean => {
    chunks.push(String(chunk))
    return true
  }) as typeof process.stdout.write
  try {
    run()
  } finally {
    process.stdout.write = original
  }
  return chunks.join('')
}

const gameRows = [
  { type: 'games', id: '1', title: 'One' },
  { type: 'games', id: '2', title: 'Two' }
]

void test('--format csv fails closed on every incomplete list result', () => {
  const rejects = (meta: Record<string, unknown>): void => {
    assert.throws(() => captureStdout(() => renderList({ data: gameRows, meta }, { format: 'csv' }, 'games')), (error: unknown) => {
      assert.ok(error instanceof CliError)
      assert.equal(error.code, 'INVALID_INPUT')
      assert.equal(error.exitCode, 2)
      assert.match(error.message, /cannot represent pagination truncation metadata/)
      assert.match(error.message, /Rerun as JSON or TOON/)
      assert.deepEqual((error.details as { pagination: Record<string, unknown> }).pagination, { ...meta, view: 'summary' })
      return true
    })
  }

  // An ordinary numbered page never sets truncated: it reports has_next beside
  // the backend total, and CSV discards both.
  rejects({ total: 100, page: 1, page_size: 2, has_next: true })
  // A bounded --all keeps failing through the same guard.
  rejects({ fetched: 2, page: 1, page_size: 2, pages_fetched: 1, truncated: true, has_next: true, bounds: { max_items: 2 } })

  const complete = captureStdout(() => renderList(
    { data: gameRows, meta: { total: 2, page: 1, page_size: 30, has_next: false } }, { format: 'csv' }, 'games'))
  assert.equal(complete, 'type,id,title\ngames,1,One\ngames,2,Two\n')
})

void test('--format csv exports an empty collection as a self-describing header', () => {
  const empty = { data: [], meta: { total: 0, page: 1, page_size: 30 } }

  const summary = captureStdout(() => renderList(empty, { format: 'csv' }, 'games'))
  assert.equal(summary, `${resourceSummaryFields.games.join(',')}\n`)

  const selected = captureStdout(() => renderList(empty, { format: 'csv', fields: 'title, public_version' }, 'games'))
  assert.equal(selected, 'type,id,title,public_version\n')

  const full = captureStdout(() => renderList(empty, { format: 'csv', full: true }, 'games'))
  assert.equal(full.split('\n').length, 2)
  assert.match(full, /^type,id,/)

  // Declared columns describe an empty collection only; rows keep deciding the
  // header whenever there are any.
  assert.equal(csvString([], ['type', 'id']), 'type,id\n')
  assert.equal(csvString([{ type: 'games', id: '1' }], ['type', 'id', 'title']), 'type,id\ngames,1\n')
})

// The empty-collection header is derived from the view definitions instead of
// from rows, so it is pinned against the projection every non-empty export
// uses; a drifting --fields or --full rule would otherwise make an empty export
// describe columns a populated one never contains.
void test('the empty CSV header matches the columns the same view projects', () => {
  const kinds = Object.keys(resourceSummaryFields) as ResourceListKind[]
  for (const kind of kinds) {
    const available = developerFieldsForKind(kind)
    const probe = Object.fromEntries(available.map(field => [field, `${kind}:${field}`]))
    const selected = available.filter(field => field !== 'type' && field !== 'id').slice(0, 2).join(',')
    const views: Array<{ full?: boolean, fields?: string }> = [{}, { full: true }, { fields: selected }]
    for (const args of views) {
      const projected = applyListView({ data: [probe], meta: {} }, args, kind) as { data: [Record<string, unknown>] }
      const header = captureStdout(() => renderList({ data: [], meta: {} }, { ...args, format: 'csv' }, kind))
      assert.equal(header, `${Object.keys(projected.data[0]).join(',')}\n`, kind)
    }
  }
})

void test('games list --format csv rejects a paged export and stays self-describing when empty', async t => {
  const directory = temporaryDirectory(t, 'output-csv')
  let body: Record<string, unknown> = {}
  const server = createServer((_req, res) => {
    jsonApi(res, body)
  })
  const base = await listen(t, server)
  const env = authEnvironment(directory, base)
  const page = [
    { type: 'games', id: '1', attributes: { title: 'One' } },
    { type: 'games', id: '2', attributes: { title: 'Two' } }
  ]

  body = { data: page, meta: { total: 100 }, links: { next: `${base}/games?page%5Bnumber%5D=2&page%5Bsize%5D=2` } }
  const json = await runCli(['games', 'list', '--page-size', '2', '--format', 'json'], { env })
  assert.equal(json.code, 0, json.stderr)
  const paged = JSON.parse(json.stdout) as { meta: Record<string, unknown> }
  assert.equal(paged.meta.has_next, true)
  assert.equal(paged.meta.total, 100)

  // The same two rows without that metadata would present 2 of 100 games as
  // the complete result.
  const incomplete = await runCli(['games', 'list', '--page-size', '2', '--format', 'csv'], { env })
  assert.equal(incomplete.code, 2, incomplete.stdout)
  assert.equal(incomplete.stdout, '')
  assert.match(incomplete.stderr, /INVALID_INPUT/)
  assert.match(incomplete.stderr, /cannot represent pagination truncation metadata/)

  // The Poki API sends no links member and reports a per-page meta.total, so a
  // page that filled the requested size is indistinguishable from the first
  // page of a far larger collection: this document is byte-identical to page 1
  // of 95 games at --page-size 2. CSV carries rows alone, so it must refuse.
  body = { data: page, meta: { total: 2 } }
  const unproven = await runCli(['games', 'list', '--page-size', '2', '--format', 'csv'], { env })
  assert.equal(unproven.code, 2, unproven.stdout)
  assert.equal(unproven.stdout, '')
  assert.match(unproven.stderr, /cannot represent pagination truncation metadata/)

  // A page shorter than the requested size is the one single-page result the
  // CLI can prove complete without an authoritative link.
  const complete = await runCli(['games', 'list', '--page-size', '30', '--format', 'csv'], { env })
  assert.equal(complete.code, 0, complete.stderr)
  assert.equal(complete.stdout, 'type,id,title\ngames,1,One\ngames,2,Two\n')

  body = { data: [], meta: { total: 0 } }
  const none = await runCli(['games', 'list', '--format', 'csv'], { env })
  assert.equal(none.code, 0, none.stderr)
  assert.equal(none.stdout, `${resourceSummaryFields.games.join(',')}\n`)
})

// The Poki API's own list renderer emits no JSON:API links member at all, so
// keying completeness off an authoritative next link left the CSV guard dead
// against every real response: a full first page exported as if it were the
// whole collection, with exit 0 and no signal in the rows.
void test('a full page without a links member reports has_next and is refused as CSV', async t => {
  const directory = temporaryDirectory(t, 'output-csv-linkless')
  const games = Array.from({ length: 95 }, (_value, index) => ({
    type: 'games',
    id: String(index + 1),
    attributes: { title: `Game ${String(index + 1)}` }
  }))
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const size = Number(url.searchParams.get('page[size]') ?? 30)
    const number = Number(url.searchParams.get('page[number]') ?? 1)
    const rows = games.slice((number - 1) * size, number * size)
    // Mirrors the backend exactly: a per-page total and no links member.
    jsonApi(res, { data: rows, meta: { total: rows.length } })
  })
  const base = await listen(t, server)
  const env = authEnvironment(directory, base)

  const json = await runCli(['games', 'list', '--format', 'json'], { env })
  assert.equal(json.code, 0, json.stderr)
  const page = JSON.parse(json.stdout) as { data: unknown[], meta: Record<string, unknown> }
  assert.equal(page.data.length, 30)
  assert.equal(page.meta.has_next, true)

  const csv = await runCli(['games', 'list', '--format', 'csv'], { env })
  assert.equal(csv.code, 2, csv.stdout)
  assert.equal(csv.stdout, '')
  assert.match(csv.stderr, /cannot represent pagination truncation metadata/)

  // The last page is short, which proves exhaustion without a link.
  const tail = await runCli(['games', 'list', '--page', '4', '--format', 'json'], { env })
  assert.equal(tail.code, 0, tail.stderr)
  assert.equal((JSON.parse(tail.stdout) as { meta: Record<string, unknown> }).meta.has_next, false)

  // --all completes the numeric scan, so the export it produces is provable.
  const all = await runCli(['games', 'list', '--all', '--format', 'csv'], { env })
  assert.equal(all.code, 0, all.stderr)
  assert.equal(all.stdout.trim().split('\n').length, 96)
})

void test('progressive help documents stay within the 5000-byte budget', () => {
  const root = structuredString(helpDocument([]))
  const games = structuredString(helpDocument(['games']))
  const versions = structuredString(helpDocument(['versions']))
  assert.ok(Buffer.byteLength(root) <= 5000, `root help is ${Buffer.byteLength(root)} bytes`)
  assert.ok(Buffer.byteLength(games) <= 5000, `games help is ${Buffer.byteLength(games)} bytes`)
  assert.ok(Buffer.byteLength(versions) <= 5000, `versions help is ${Buffer.byteLength(versions)} bytes`)
})
