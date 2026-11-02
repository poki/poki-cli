import { ApiClient } from '../src/api'
import { refreshStoredAuth } from '../src/auth'
import { runProcess } from '../src/process'
import { InspectorClient } from '../src/inspector'

const unreachable = 'http://127.0.0.1:1'
const apiUrl = process.env.POKI_CLI_TEST_API_URL ?? unreachable
const authUrl = process.env.POKI_CLI_TEST_AUTH_URL ?? unreachable
const api = new ApiClient(apiUrl, {
  realtimeUrl: process.env.POKI_CLI_TEST_REALTIME_URL ?? unreachable,
  refreshAuth: async (config, signal) => await refreshStoredAuth(config, authUrl, signal)
})

const inspector = new InspectorClient(process.env.POKI_CLI_TEST_INSPECTOR_URL ?? unreachable)

runProcess(process.argv.slice(2), api, inspector)
