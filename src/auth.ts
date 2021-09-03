import { createServer } from 'http'
import { request } from 'https'
import { writeFileSync, readFileSync, existsSync, mkdirSync, chmodSync } from 'fs'
import { join } from 'path'

import open from 'open'

import { getConfigDir, Config } from './config'

function exchange (exchangeToken: string) {
  return new Promise((resolve, reject) => {
    const req = request({
      hostname: 'auth-production.poki.io',
      port: 443,
      path: '/auth/exchange',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, res => {
      let data = ''
      res.on('data', chunk => {
        data += chunk
      })
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(data)
        } else {
          resolve(JSON.parse(data))
        }
      })
    })

    req.on('error', error => {
      reject(error)
    })

    req.write(JSON.stringify({ exchange_token: exchangeToken }))
    req.end()
  })
}

export function refresh (config: Config) {
  console.log('refreshing authentication...')

  return new Promise<Config>((resolve, reject) => {
    const req = request({
      hostname: 'auth-production.poki.io',
      port: 443,
      path: '/auth/refresh',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      }
    }, res => {
      let data = ''
      res.on('data', chunk => {
        data += chunk
      })
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(data)
        } else {
          const configPath = join(getConfigDir(), 'auth.json')
          const body = JSON.parse(data)

          config.access_token = body.access_token

          writeFileSync(configPath, JSON.stringify(config), 'ascii')

          // Make sure the file isn't readable for everyone.
          chmodSync(configPath, '600')

          resolve(config)
        }
      })
    })

    req.on('error', error => {
      reject(error)
    })

    req.write(JSON.stringify({ refresh_token: config.refresh_token }))
    req.end()
  })
}

export function auth () {
  return new Promise<Config>((resolve, reject) => {
    const configDir = getConfigDir()
    const configPath = join(configDir, 'auth.json')
    let config

    try {
      config = JSON.parse(readFileSync(configPath, 'ascii'))
    } catch (e) {
      // Ignore.
    }

    if (config) {
      resolve(config as Config)
      return
    }

    console.log('authentication required, opening browser...')

    if (!existsSync(configDir)) {
      try {
        mkdirSync(configDir, { recursive: true })
      } catch (err) {
        reject(err)
        return
      }
    }

    const server = createServer(async (req, res) => {
      const q = new URL(req.url as string, 'http://localhost')

      if (q.pathname === '/favicon.ico') {
        res.writeHead(404)
        res.end()
        return
      }

      const exchangeToken = q.searchParams.get('exchange_token')
      if (exchangeToken) {
        res.setHeader('Content-Type', 'text/html')
        res.writeHead(200)
        res.end('You can close this window and return to your terminal')

        const config = await exchange(exchangeToken)

        writeFileSync(configPath, JSON.stringify(config), 'ascii')

        // Make sure the file isn't readable for everyone.
        chmodSync(configPath, '600')

        server.close()

        resolve(config as Config)
      } else {
        res.setHeader('Content-Type', 'text/plain')
        res.writeHead(200)
        res.end('missing exchange_token')

        server.close()

        reject(Error('missing exchange_token'))
      }
    })
    server.on('error', (err) => {
      reject(err)
    })
    server.listen(0, () => {
		const address = server.address();
		if (address === null || typeof address === 'string') return;
      open(`https://developers.poki.com/signin/?cli=${encodeURIComponent(`http://localhost:${address.port}`)}`)
    })
  })
}
