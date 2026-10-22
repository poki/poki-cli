import assert from 'node:assert/strict'
import { isAbsolute, join, resolve } from 'node:path'
import test from 'node:test'

import { getConfigDir } from '../src/config'

void test('credential configuration roots never resolve relative to the current working directory', t => {
  const environmentVariable = process.platform === 'win32' ? 'LOCALAPPDATA' : 'XDG_CONFIG_HOME'
  const originalValue = process.env[environmentVariable]
  const originalServiceEnvironment = process.env.SERVICE_ENV
  t.after(() => {
    if (originalValue === undefined) Reflect.deleteProperty(process.env, environmentVariable)
    else process.env[environmentVariable] = originalValue
    if (originalServiceEnvironment === undefined) Reflect.deleteProperty(process.env, 'SERVICE_ENV')
    else process.env.SERVICE_ENV = originalServiceEnvironment
  })

  Reflect.deleteProperty(process.env, environmentVariable)
  Reflect.deleteProperty(process.env, 'SERVICE_ENV')
  const fallback = getConfigDir()
  assert.equal(isAbsolute(fallback), true)

  process.env[environmentVariable] = ''
  assert.equal(getConfigDir(), fallback)

  process.env[environmentVariable] = 'relative-config'
  assert.equal(getConfigDir(), fallback)

  const absoluteRoot = resolve('absolute-config-root')
  process.env[environmentVariable] = absoluteRoot
  assert.equal(getConfigDir(), join(absoluteRoot, process.platform === 'win32' ? 'Poki' : 'poki'))
})

void test('acceptance credentials and update state use an isolated config scope', () => {
  const environmentVariable = process.platform === 'win32' ? 'LOCALAPPDATA' : 'XDG_CONFIG_HOME'
  const absoluteRoot = resolve('service-environment-config-root')
  const base = join(absoluteRoot, process.platform === 'win32' ? 'Poki' : 'poki')

  assert.equal(getConfigDir({ [environmentVariable]: absoluteRoot }), base)
  assert.equal(getConfigDir({ [environmentVariable]: absoluteRoot, SERVICE_ENV: 'production' }), base)
  assert.equal(getConfigDir({ [environmentVariable]: absoluteRoot, SERVICE_ENV: 'acceptance' }), join(base, 'acceptance'))
})
