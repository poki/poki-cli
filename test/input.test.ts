import assert from 'node:assert/strict'
import { encode } from '@toon-format/toon'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { CliError } from '../src/errors'
import { readStructuredSource, requireAllowedFields } from '../src/input'
import { temporaryDirectory } from './helpers'

void test('structured input auto-detects JSON and TOON inline and in files', async t => {
  const directory = temporaryDirectory(t, 'input')
  const file = join(directory, 'input.json')
  const toonFile = join(directory, 'input.toon')
  writeFileSync(file, '{"title":"From file"}')
  writeFileSync(toonFile, encode({ title: 'From TOON file', nested: { enabled: true } }))

  assert.deepEqual(await readStructuredSource('{"title":"Inline"}'), { title: 'Inline' })
  assert.deepEqual(await readStructuredSource('title: Inline TOON'), { title: 'Inline TOON' })
  assert.deepEqual(await readStructuredSource(`@${file}`), { title: 'From file' })
  assert.deepEqual(await readStructuredSource(`@${toonFile}`), { title: 'From TOON file', nested: { enabled: true } })
})

void test('structured input rejects arrays, invalid documents, and unsupported fields', async () => {
  await assert.rejects(readStructuredSource('[]'), (error: unknown) => {
    return error instanceof CliError && error.code === 'INVALID_INPUT'
  })
  await assert.rejects(readStructuredSource('{invalid'), (error: unknown) => {
    return error instanceof CliError && error.code === 'INVALID_INPUT'
  })
  // JSON-shaped input must surface the JSON syntax error instead of being
  // misparsed as TOON into garbage field names.
  await assert.rejects(readStructuredSource('{"title": 1,}'), (error: unknown) => {
    return error instanceof CliError && error.message.includes('must contain valid JSON.')
  })
  await assert.rejects(readStructuredSource('   '), (error: unknown) => {
    return error instanceof CliError && error.message.includes('is empty')
  })
  assert.throws(() => requireAllowedFields({ title: 'ok', surprise: true }, ['title']), (error: unknown) => {
    return error instanceof CliError && error.message.includes('surprise')
  })
})
