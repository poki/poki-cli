import { createWriteStream } from 'fs'

import archiver, { ArchiverError } from 'archiver'

export async function createZip (filename: string, dir: string): Promise<void> {
  return await new Promise<void>((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 6 } })
    const stream = createWriteStream(filename)

    archive
      .directory(dir, false)
      .on('error', (err: typeof ArchiverError) => reject(err))
      .pipe(stream)

    stream.on('close', () => resolve())
    stream.on('error', err => reject(err))

    archive.finalize().catch(err => {
      reject(err)
    })
  })
}
