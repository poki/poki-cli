import commonjs from '@rollup/plugin-commonjs'
import { babel } from '@rollup/plugin-babel'
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
    typescript(),
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
