import { auth, refresh } from './auth'
import { Config } from './config'

import { createReadStream, statSync } from 'fs'
import { request } from 'https'
import { basename } from 'path'

import FormData from 'form-data'

interface Response {
  statusCode?: number
  data: string
}

async function doit (gameId: string, filename: string, name: string, notes: string | undefined, config: Config): Promise<Response> {
  return await new Promise<Response>((resolve, reject) => {
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
        Authorization: `${config.access_type || 'Bearer'} ${config.access_token}`,
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

export async function postToP4D (gameId: string, filename: string, name: string, notes?: string) {
  let config = await auth()
  let response = await doit(gameId, filename, name, notes, config)

  if (response.statusCode === 401) {
    config = await refresh(config)
    response = await doit(gameId, filename, name, notes, config)
  }

  if (response.statusCode !== 201) {
    throw Error(JSON.stringify(response))
  } else {
    return JSON.parse(response.data)
  }
}
