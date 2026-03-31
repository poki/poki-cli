import { babel } from '@rollup/plugin-babel'
import resolve from '@rollup/plugin-node-resolve'
import typescript from 'rollup-plugin-typescript2'

export default {
  input: './src/index.ts',
  output: [{
    file: './bin/index.js',
    format: 'cjs',
    banner: '#! /usr/bin/env node\n',
    exports: 'none'
  }],
  plugins: [
    resolve(),
    typescript(),
    babel({ babelHelpers: 'bundled' })
  ],
  external: [
    'fs',
    'archiver',
    'https',
    'form-data',
    'http',
    'os',
    'path',
    'yargs'
  ]
}
