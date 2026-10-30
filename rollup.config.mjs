import { readdirSync, readFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import json from '@rollup/plugin-json'
import resolve from '@rollup/plugin-node-resolve'
import typescript from '@rollup/plugin-typescript'

const shebang = '#! /usr/bin/env node'
const licenceFile = /^(licence|license|copying)(\.\w+)?$/i
const nodeModules = `${sep}node_modules${sep}`

// Returns the package directory a bundled module was resolved from, or
// undefined for first-party source and plugin-generated modules.
function packageRoot (moduleId) {
  const start = moduleId.lastIndexOf(nodeModules)
  if (start === -1) return undefined
  const segments = moduleId.slice(start + nodeModules.length).split(sep)
  const depth = segments[0].startsWith('@') ? 2 : 1
  return moduleId.slice(0, start + nodeModules.length) + segments.slice(0, depth).join(sep)
}

function readLicence (root) {
  const name = readdirSync(root).find(entry => licenceFile.test(entry))
  return name === undefined ? undefined : readFileSync(join(root, name), 'utf8').trim()
}

// Every package that is not listed in `external` below is inlined into
// bin/index.js, and package.json#files publishes that single file, so a bundled
// package's licence notice has nowhere else to live. The notices are derived
// from the modules rollup actually included rather than hard-coded, so a
// package that stops being external ships its notice without anyone
// remembering, and one whose licence cannot be read fails the build instead of
// shipping unattributed. scripts/verify-package.mjs asserts the result survives
// into an install.
function banner (chunk) {
  const roots = [...new Set(chunk.moduleIds.map(packageRoot).filter(root => root !== undefined))].sort()
  if (roots.length === 0) return `${shebang}\n`

  const packages = roots.map(root => {
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    const licence = readLicence(root)
    if (licence === undefined) {
      throw new Error(`${manifest.name} is bundled into bin/index.js but ships no licence file; add its notice or make it external.`)
    }
    return { name: manifest.name, version: manifest.version, licence: manifest.license ?? 'see notice', text: licence }
  })

  const lines = [
    'This file bundles the third-party packages listed below. Each of their',
    'licences requires its notice to be included with the bundled code, and',
    'this file is the only one the npm package publishes.',
    '',
    `Bundled packages: ${packages.map(bundled => bundled.name).join(', ')}`,
    ...packages.flatMap(bundled => [
      '',
      `---- ${bundled.name} ${bundled.version} (${bundled.licence}) ----`,
      '',
      ...bundled.text.split('\n')
    ])
  ]
  if (lines.some(line => line.includes('*/'))) {
    throw new Error('a bundled licence notice would terminate the banner comment early.')
  }

  // The shebang has to stay the very first bytes of the file for the published
  // bin to stay executable, so the notice follows it.
  return `${shebang}\n/*\n${lines.map(line => ` *${line === '' ? '' : ` ${line}`}`).join('\n')}\n */\n`
}

export default {
  input: './src/index.ts',
  output: [{
    file: './bin/index.js',
    format: 'cjs',
    banner,
    exports: 'none'
  }],
  plugins: [
    resolve(),
    json(),
    typescript()
  ],
  // Node builtins are externalized by the resolve plugin. These are the runtime
  // packages the published bundle still requires, which is exactly what
  // scripts/verify-package.mjs cross-checks against dependencies.
  external: [
    'archiver',
    'form-data',
    'open',
    'yargs'
  ]
}
