import { createWriteStream } from 'fs'

import archiver, { ArchiverError } from 'archiver'

export function createZip (filename: string, dir: string) {
  return new Promise<void>((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 6 } })
    const stream = createWriteStream(filename)

    archive
      .directory(dir, false)
      .on('error', (err: typeof ArchiverError) => reject(err))
      .pipe(stream)

    stream.on('close', () => resolve())
    archive.finalize()
  })
}
