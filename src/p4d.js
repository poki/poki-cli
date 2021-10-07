import { auth, refresh } from './auth'

import { readFileSync, statSync } from 'fs'
import { request } from 'https'
import { basename } from 'path'

const FormData = require('form-data')

async function doit (gameId, filename, name, notes, makePublic, config) {
  return new Promise((resolve, reject) => {
    const stat = statSync(filename)

    const form = new FormData()

    form.append('file', readFileSync(filename), {
      filepath: basename(filename),
      knownLength: stat.size,
      contentType: 'application/zip'
    })
    if (name !== filename) {
      form.append('label', name)
    }
    if (notes) {
      form.append('notes', notes)
    }
    if (makePublic) {
      form.append('make-public', 'true')
    }

    console.log('uploading...')

    const buffer = form.getBuffer()
    const req = request({
      hostname: 'devs-api.poki.io',
      port: 443,
      path: `/games/${gameId}/versions`,
      method: 'POST',
      headers: {
        Authorization: `${config.access_type || 'Bearer'} ${config.access_token}`,
        'Content-Length': buffer.length,
        'User-Agent': 'poki-cli',
        ...form.getHeaders()
      }
    }, res => {
      const data = []
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          data: Buffer.concat(data).toString()
        })
      })
      res.on('data', chunk => {
        data.push(chunk)
      })
    })

    req.on('error', error => {
      reject(error)
    })

    req.write(buffer, 'binary')
    req.end()
  })
}

export async function postToP4D (gameId, filename, name, notes, makePublic) {
  let config = await auth()
  let response = await doit(gameId, filename, name, notes, makePublic, config)

  if (response.statusCode === 401) {
    config = await refresh(config)
    response = await doit(gameId, filename, name, notes, makePublic, config)
  }

  if (response.statusCode !== 201) {
    throw Error(response)
  } else {
    return JSON.parse(response.data)
  }
}
