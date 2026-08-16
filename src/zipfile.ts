import { createWriteStream, rmSync, statSync } from 'fs'

import type { ArchiverError } from 'archiver'

export async function createZip (filename: string, dir: string): Promise<void> {
  // Archiver 8 is ESM-only while the published CLI bundle is CommonJS.
  // Dynamic import keeps the CLI compatible with the complete supported Node
  // range instead of relying on newer require(ESM) support.
  const { ZipArchive } = await import('archiver')
  return await new Promise<void>((resolve, reject) => {
    // archiver silently produces an empty archive for a missing source
    // directory, which would otherwise get uploaded as an empty build.
    try {
      if (!statSync(dir).isDirectory()) {
        reject(new Error(`'${dir}' is not a directory`))
        return
      }
    } catch (error) {
      reject(error)
      return
    }

    const archive = new ZipArchive({ zlib: { level: 6 } })
    const stream = createWriteStream(filename)

    // A failure part-way through leaves a truncated archive behind. The legacy
    // human upload logs the failure and still exits 0, so an orphaned file is
    // all a caller would find, and it looks like a complete build. Close the
    // stream before removing the path: an open handle blocks removal on
    // Windows.
    let failing = false
    const failWith = (error: unknown): void => {
      // Closing the stream mid-archive raises a follow-up write error, but the
      // first failure is the one that explains why the archive is incomplete.
      if (failing) return
      failing = true
      const removeArchive = (): void => {
        try {
          rmSync(filename, { force: true })
        } catch (ignore) {}
        reject(error)
      }
      if (stream.destroyed) removeArchive()
      else stream.once('close', removeArchive).destroy()
    }

    archive
      .directory(dir, false)
      .on('error', (err: ArchiverError) => failWith(err))
      .pipe(stream)

    stream.on('close', () => {
      if (!failing) resolve()
    })
    stream.on('error', err => failWith(err))

    archive.finalize().catch(err => {
      failWith(err)
    })
  })
}
