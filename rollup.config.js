import commonjs from '@rollup/plugin-commonjs'
import { babel } from '@rollup/plugin-babel'

export default {
  input: './src/index.js',
  output: [{
    file: './bin/index.js',
    format: 'cjs',
    banner: '#! /usr/bin/env node\n',
    exports: 'none'
  }],
  plugins: [
    babel({ babelHelpers: 'bundled' }),
    commonjs()
  ],
  external: [
    'fs',
    'archiver',
    'https',
    'form-data',
    'http',
    'os',
    'path',
    'open',
    'yargs'
  ]
}
