import assert from 'node:assert/strict'
import test from 'node:test'

import { serviceEnvironment } from '../src/service-environment'
import { runCli, runProductCli } from './helpers'

const production = {
  apiUrl: 'https://devs-api.poki.io',
  authUrl: 'https://auth.poki.io',
  signInUrl: 'https://app.poki.dev/signin/',
  legacyUploadHostname: '34.111.107.149',
  legacyUploadHost: 'devs-api.poki.io'
}

const acceptance = {
  apiUrl: 'https://devs-api-acceptance.poki.io',
  authUrl: 'https://auth-acceptance.poki.io',
  signInUrl: 'https://acceptance.devs-app.pages.dev/signin/',
  legacyUploadHostname: '34.102.180.200',
  legacyUploadHost: 'devs-api-acceptance.poki.io',
  configScope: 'acceptance'
}

void test('only the exact acceptance service environment selects acceptance endpoints', () => {
  const cases: Array<{ environment: NodeJS.ProcessEnv, expected: typeof production | typeof acceptance }> = [
    { environment: {}, expected: production },
    { environment: { SERVICE_ENV: '' }, expected: production },
    { environment: { SERVICE_ENV: 'production' }, expected: production },
    { environment: { SERVICE_ENV: 'local' }, expected: production },
    { environment: { SERVICE_ENV: 'Acceptance' }, expected: production },
    { environment: { SERVICE_ENV: 'acceptance' }, expected: acceptance }
  ]

  for (const value of cases) {
    assert.deepEqual(serviceEnvironment(value.environment), value.expected, value.environment.SERVICE_ENV)
  }
})

void test('removed endpoint variables are ignored by both service environments', async () => {
  const removedOverrides = {
    POKI_API_URL: 'https://ignored-api.invalid',
    POKI_AUTH_URL: 'https://ignored-auth.invalid'
  }
  assert.deepEqual(serviceEnvironment(removedOverrides), production)
  assert.deepEqual(serviceEnvironment({ SERVICE_ENV: 'acceptance', ...removedOverrides }), acceptance)

  const productionContext = await runProductCli(['context', '--format', 'json'], { env: removedOverrides })
  assert.equal(productionContext.code, 0, productionContext.stderr)
  assert.equal(JSON.parse(productionContext.stdout).api.base_url, production.apiUrl)

  const acceptanceContext = await runProductCli(['context', '--format', 'json'], {
    env: { SERVICE_ENV: 'acceptance', ...removedOverrides }
  })
  assert.equal(acceptanceContext.code, 0, acceptanceContext.stderr)
  assert.equal(JSON.parse(acceptanceContext.stdout).api.base_url, acceptance.apiUrl)
})

void test('structured help does not reveal the private environment or endpoints', async () => {
  const result = await runCli(['help', '--all', '--full', '--format', 'json'], {
    env: { SERVICE_ENV: 'acceptance' }
  })
  assert.equal(result.code, 0, result.stderr)

  for (const value of [
    'SERVICE_ENV',
    'POKI_API_URL',
    'POKI_AUTH_URL',
    'devs-api-acceptance.poki.io',
    'auth-acceptance.poki.io',
    'acceptance.devs-app.pages.dev',
    '34.102.180.200'
  ]) {
    assert.equal(result.stdout.includes(value), false, value)
  }
})
