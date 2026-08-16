import { ApiClient } from '../src/api'
import { refreshStoredAuth } from '../src/auth'
import { runProcess } from '../src/process'

const unreachable = 'http://127.0.0.1:1'
const apiUrl = process.env.POKI_CLI_TEST_API_URL ?? unreachable
const authUrl = process.env.POKI_CLI_TEST_AUTH_URL ?? unreachable
const api = new ApiClient(apiUrl, {
  refreshAuth: async config => await refreshStoredAuth(config, authUrl)
})

runProcess(process.argv.slice(2), api)
