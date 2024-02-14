import { auth, refresh } from './auth'
import { Config } from './config'

import { readFileSync, statSync } from 'fs'
import { request } from 'https'
import { basename } from 'path'

import FormData from 'form-data'

interface Response {
  statusCode?: number
  data: string
}

async function doit (gameId: string, filename: string, name: string, notes: string|undefined, makePublic: boolean, disableImageCompression: boolean, config: Config): Promise<Response> {
  return await new Promise<Response>((resolve, reject) => {
    if (config.access_token === undefined) {
      return reject(new Error('No access token found'))
    }

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
    if (notes !== undefined) {
      form.append('notes', notes)
    }
    if (makePublic) {
      form.append('make-public', 'true')
    }
    if (disableImageCompression) {
      form.append('disable-image-compression', 'true')
    }

    console.log('uploading...')

    const buffer = form.getBuffer()
    const path = process.env.API_PATH ?? `/games/${gameId}/versions`
    const req = request({
      hostname: 'devs-api.poki.io',
      port: 443,
      path,
      method: 'POST',
      headers: {
        Authorization: `${config.access_type ?? 'Bearer'} ${config.access_token ?? ''}`,
        'Content-Length': buffer.length,
        'User-Agent': 'poki-cli',
        ...form.getHeaders()
      }
    }, res => {
      const data: any[] = []
      res.on('data', chunk => {
        data.push(chunk)
      })
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          data: Buffer.concat(data).toString()
        })
      })
    })

    req.on('error', error => {
      reject(error)
    })

    req.write(buffer, 'binary')
    req.end()
  })
}

interface P4dData {
  url: string
  game_id: string
  id: number
}

export async function postToP4D (gameId: string, filename: string, name: string, notes: string|undefined, makePublic: boolean, disableImageCompression: boolean): Promise<P4dData> {
  let config = await auth()
  let response = await doit(gameId, filename, name, notes, makePublic, disableImageCompression, config)

  if (response.statusCode === 401 && config.access_type !== 'Token') {
    try {
      config = await refresh(config)
    } catch (e) {
      config = await auth(true)
    }
    response = await doit(gameId, filename, name, notes, makePublic, disableImageCompression, config)
  }

  if (response.statusCode !== 201) {
    throw Error(JSON.stringify(response))
  } else {
    return JSON.parse(response.data)
  }
}
