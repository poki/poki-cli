import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { appendUploadFile } from '../src/uploads'
import { createZip } from '../src/zipfile'
import { temporaryDirectory } from './helpers'

void test('appendUploadFile keeps multipart file contents file-backed', async t => {
  const directory = temporaryDirectory(t, 'file-backed-upload')
  const path = join(directory, 'build.zip')
  writeFileSync(path, 'original')

  const form = new FormData()
  await appendUploadFile(form, 'file', path, 'renamed.zip', 'application/zip')

  const part = form.get('file')
  assert.ok(part instanceof Blob)
  assert.equal(part.size, 8)
  assert.equal(part.type, 'application/zip')
  assert.equal(part.name, 'renamed.zip')

  // A Blob constructed from readFileSync would remain an in-memory snapshot.
  // A file-backed Blob notices that its source changed before consumption and
  // refuses the read, proving that appendUploadFile did not eagerly copy it.
  writeFileSync(path, 'changed after the form was constructed')
  await assert.rejects(part.arrayBuffer(), (error: unknown) => {
    return error instanceof DOMException && error.name === 'NotReadableError'
  })
})

void test('a failed archive leaves no partial ZIP behind', {
  skip: process.platform === 'win32' || process.getuid?.() === 0
    ? 'requires POSIX file permissions enforced for a non-root user'
    : false
}, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'poki-cli-partial-archive-'))
  const source = join(directory, 'build')
  mkdirSync(source)
  writeFileSync(join(source, 'index.html'), '<!doctype html><title>Example</title>'.repeat(500))
  const unreadable = join(source, 'unreadable.bin')
  writeFileSync(unreadable, 'x'.repeat(100000))
  chmodSync(unreadable, 0o000)
  t.after(() => {
    chmodSync(unreadable, 0o600)
    rmSync(directory, { recursive: true, force: true })
  })

  const archive = join(directory, 'build.zip')
  await assert.rejects(createZip(archive, source), /EACCES/)
  // Legacy human mode still exits 0 after logging the failure, so a truncated
  // archive would be the only trace left, and it looks like a complete build.
  assert.equal(existsSync(archive), false)
})
