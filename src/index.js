import { unlinkSync, writeFileSync, readFileSync } from 'fs'

import yargs from 'yargs'

import { createZip } from './zipfile'
import { postToP4D } from './p4d'

async function upload (gameId, buildDir, filename, name, notes, makePublic) {
  await createZip(filename, buildDir)

  try {
    const data = await postToP4D(gameId, filename, name, notes, makePublic)

    console.log(`
Version uploaded successfully

Your build is still processing, once that is done the following links will be available:
  QA: https://qa.po.ki/#?url=${data.url}
  Preview: https://poki.com/en/preview/${data.game_id}/${data.id}
`)
  } catch (err) {
    console.error(err)
  }

  unlinkSync(filename)

  process.exit(0)
}

function init (gameId, buildDir) {
  writeFileSync('poki.json', JSON.stringify({
    game_id: gameId,
    build_dir: buildDir
  }, null, 2) + '\n', 'ascii')
}

let config = {}
try {
  config = JSON.parse(readFileSync('poki.json', 'ascii'))
} catch (ignore) {
  try {
    const packagejson = JSON.parse(readFileSync('package.json', 'ascii'))

    if (packagejson.poki) {
      config = packagejson.poki
    }
  } catch (ignore) {}
}

const filename = `${new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().split('.')[0].replace('T', '-').replace(/:/g, '')}.zip`

const argv = yargs(process.argv.slice(2))
  .command('init', 'Create a poki.json configuration file', function (yargs) {
    return yargs
      .option('game', {
        alias: 'g',
        describe: 'Poki for Developers game ID',
        demandOption: true,
        type: 'string'
      })
      .option('build-dir', {
        alias: 'b',
        describe: 'Directory to upload',
        default: 'dist',
        type: 'string'
      })
  })
  .command('upload', 'Upload a new version to Poki for Developers', function (yargs) {
    return yargs
      .option('game', {
        alias: 'g',
        describe: 'Poki for Developers game ID',
        demandOption: !config.game_id,
        default: config.game_id,
        type: 'string'
      })
      .option('build-dir', {
        alias: 'b',
        describe: 'Directory to upload',
        default: config.build_dir || 'dist',
        type: 'string'
      })
      .option('name', {
        alias: 'n',
        describe: 'Version name',
        default: filename,
        type: 'string'
      })
      .option('notes', {
        alias: 'o',
        describe: 'Version notes',
        type: 'string'
      })
      .option('make-public', {
        alias: 'l',
        describe: 'Make version public after upload',
        default: false,
        type: 'boolean'
      })
  })
  .demandCommand(1)
  .example([
    [`$0 init --game ${config.game_id || 'f85c728f-1055-4777-92fa-841eb40ee723'} --build-dir ${config.build_dir || 'dist'}`],
    ['$0 upload --name "New Version Name"'],
    ['$0 upload --name "$(git rev-parse --short HEAD)" --notes "$(git log -1 --pretty=%B)"']
  ])
  .help('h')
  .alias('h', 'help')
  .wrap(94) // Make sure our examples fit.
  .argv

if (argv._.includes('init')) {
  init(argv.game, argv.buildDir)
} else if (argv._.includes('upload')) {
  upload(argv.game, argv.buildDir, filename, argv.name, argv.notes, argv.makePublic)
}
