const fs = require('fs')

const archiver = require('archiver')

export function createZip (filename, dir) {
  return new Promise((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 6 } })
    const stream = fs.createWriteStream(filename)

    archive
      .directory(dir, false)
      .on('error', err => reject(err))
      .pipe(stream)

    stream.on('close', () => resolve())
    archive.finalize()
  })
}
