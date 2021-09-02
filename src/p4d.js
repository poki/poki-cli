import { auth, refresh } from './auth'

import { createReadStream, statSync } from 'fs'
import { request } from 'https'
import { basename } from 'path'

const FormData = require('form-data')

async function doit (gameId, filename, name, notes, config) {
  return new Promise((resolve, reject) => {
    const stat = statSync(filename)

    const form = new FormData()

    form.append('file', createReadStream(filename, {
      highWaterMark: 1024 * 1024 // 1mb
    }), {
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

    console.log('uploading...')

    const req = request({
      hostname: 'devs-api.poki.io',
      port: 443,
      path: `/games/${gameId}/versions`,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.access_token}`,
        ...form.getHeaders()
      }
    }, res => {
      let data = ''
      res.on('data', chunk => {
        data += chunk
      })
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          data
        })
      })
    })

    req.on('error', error => {
      reject(error)
    })

    form.pipe(req)
  })
}

export async function postToP4D (gameId, filename, name, notes) {
  let config = await auth()
  let response = await doit(gameId, filename, name, notes, config)

  if (response.statusCode === 401) {
    config = await refresh(config)
    response = await doit(gameId, filename, name, notes, config)
  }

  if (response.statusCode !== 201) {
    throw Error(response)
  } else {
    return JSON.parse(response.data)
  }
}
