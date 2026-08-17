import assert from 'node:assert/strict'
import { constants } from 'node:fs'
import { access, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { dirname, join, sep } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { isBuiltin } from 'node:module'

import { prepareReleaseGitTag, publishReleaseGitTag } from './release-git-tag.mjs'
import { releasePublishIsDryRun, resolveReleasePublishArguments } from './release-tag.mjs'

const projectDirectory = fileURLToPath(new URL('..', import.meta.url))
// Windows command scripts require a shell and newer Node releases reject
// spawning npm.cmd directly. Invoke npm's JavaScript entry point with the
// active Node executable instead, preserving every argument without a shell.
const npmCommand = process.platform === 'win32' ? process.execPath : 'npm'
const npmArgumentPrefix = process.platform === 'win32'
  ? [join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')]
  : []
const arguments_ = process.argv.slice(2)
const shouldPublish = arguments_.includes('--publish')
const publishArguments = arguments_.filter(argument => argument !== '--publish' && argument !== '--require-clean' && argument !== '--')
let resolvedPublishArguments = publishArguments
let projectManifest
let gitTagPlan

assert.equal(
  shouldPublish || publishArguments.length === 0,
  true,
  'npm publish options are accepted only together with --publish'
)
assert.equal(
  publishArguments.some(argument => argument === '--ignore-scripts' || argument === '--no-ignore-scripts' || argument.startsWith('--ignore-scripts=')),
  false,
  'release publication owns npm lifecycle execution; do not pass an ignore-scripts option'
)
if (shouldPublish) {
  projectManifest = JSON.parse(await readFile(join(projectDirectory, 'package.json'), 'utf8'))
  resolvedPublishArguments = resolveReleasePublishArguments(projectManifest.version, publishArguments)
}

function run (command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024
  })
  if (result.error !== undefined) {
    throw new Error(`${command} could not be started.`, { cause: result.error })
  }
  if (result.status !== 0) {
    throw new Error([
      `${command} ${args.join(' ')} failed with exit code ${String(result.status)}.`,
      result.stdout?.trim(),
      result.stderr?.trim()
    ].filter(Boolean).join('\n'))
  }
  return result.stdout ?? ''
}

function runNpm (args, cwd) {
  return run(npmCommand, [...npmArgumentPrefix, ...args], cwd)
}

function parsePackResult (output) {
  const starts = [...output.matchAll(/\[\s*\{\s*"id"\s*:/g)]
  const start = starts.at(-1)?.index
  assert.notEqual(start, undefined, 'npm pack did not return a JSON result')
  return JSON.parse(output.slice(start))
}

function runPublish (archive, args) {
  // The archive has already run prepack in the clean index checkout and has
  // passed every package-install check below. Publish those exact bytes and do
  // not give npm a chance to rebuild a different archive from the worktree.
  const result = spawnSync(npmCommand, [...npmArgumentPrefix, 'publish', archive, ...args, '--ignore-scripts'], {
    cwd: projectDirectory,
    stdio: 'inherit'
  })
  if (result.error !== undefined) {
    throw new Error('npm publish could not be started.', { cause: result.error })
  }
  if (result.status !== 0) {
    throw new Error(result.signal === null
      ? `npm publish failed with exit code ${String(result.status)}.`
      : `npm publish was terminated by ${String(result.signal)}.`)
  }
}

if (process.argv.includes('--require-clean')) {
  const unstaged = run('git', ['diff', '--name-only', '--no-ext-diff'], projectDirectory).trim()
  const untracked = run('git', ['ls-files', '--others', '--exclude-standard'], projectDirectory).trim()
  assert.equal(unstaged, '', 'release package verification requires every tracked working-tree change to be in the active Git index')
  assert.equal(untracked, '', 'release package verification requires every non-ignored file to be in the active Git index')
}

if (shouldPublish && !releasePublishIsDryRun(resolvedPublishArguments)) {
  gitTagPlan = prepareReleaseGitTag(projectDirectory, projectManifest.version)
}

// Keep the index checkout below the project so build tools resolve the real
// parent node_modules directory. A Windows junction here makes TypeScript's
// filesystem watcher observe canonical paths outside the watched junction and
// abort Node 24 inside libuv before Rollup can finish the prepack build.
const temporaryDirectory = await mkdtemp(join(projectDirectory, '.poki-cli-package-'))

try {
  // Build exactly what is in the index. Reading paths from the index and bytes
  // from the worktree would let unstaged edits (or untracked files) make a
  // package check pass even though they are absent from the reviewed index.
  run('git', [
    'checkout-index',
    '--all',
    '--force',
    '--ignore-skip-worktree-bits',
    `--prefix=${temporaryDirectory}${sep}`
  ], projectDirectory)

  const packDirectory = join(temporaryDirectory, 'packed')
  await mkdir(packDirectory)
  const packResult = parsePackResult(runNpm(
    ['pack', '--ignore-scripts=false', '--json', '--pack-destination', packDirectory],
    temporaryDirectory
  ))
  assert.equal(Array.isArray(packResult), true, 'npm pack did not return a JSON result array')
  assert.equal(packResult.length, 1, 'npm pack returned an unexpected number of package results')
  assert.equal(
    packResult[0].files.some(file => file.path === 'bin/index.js'),
    true,
    'the npm package does not contain bin/index.js'
  )

  const installDirectory = join(temporaryDirectory, 'installed')
  await mkdir(installDirectory)
  runNpm([
    'install',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--prefix', installDirectory,
    join(packDirectory, packResult[0].filename)
  ], temporaryDirectory)

  const installedPackageDirectory = join(installDirectory, 'node_modules', '@poki', 'cli')
  const packageJson = JSON.parse(await readFile(join(installedPackageDirectory, 'package.json'), 'utf8'))
  const installedCli = join(installedPackageDirectory, 'bin', 'index.js')
  const version = run(process.execPath, [installedCli, '--version'], installDirectory).trim()
  assert.equal(version, packageJson.version, 'the packaged CLI did not print the package version')

  // Invoke the package-manager-created entry point too. This verifies the bin
  // declaration and, on POSIX, the packaged executable mode and shebang.
  const installedBinDirectory = join(installDirectory, 'node_modules', '.bin')
  const shimVersion = process.platform === 'win32'
    ? run(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'poki.cmd --version'], installedBinDirectory).trim()
    : run(join(installedBinDirectory, 'poki'), ['--version'], installDirectory).trim()
  assert.equal(shimVersion, packageJson.version, 'the installed poki executable did not print the package version')

  run(process.execPath, [
    '--input-type=module',
    '--eval',
    'const { ZipArchive } = await import("archiver"); if (typeof ZipArchive !== "function") process.exit(1)'
  ], installDirectory)

  const help = JSON.parse(run(process.execPath, [installedCli, 'help', '--format', 'json'], installDirectory))
  assert.equal(help.command, 'poki', 'the installed CLI did not return root structured help')
  assert.equal(Array.isArray(help.commands), true, 'the installed CLI help did not contain commands')
  assert.notEqual(help.commands.length, 0, 'the installed CLI help command list was empty')

  // The default encoding proves the bundled TOON encoder runs from an install
  // that never downloads it; only bundled-at-build packages may leave the
  // runtime dependency list.
  const toonHelp = run(process.execPath, [installedCli, 'help'], installDirectory)
  assert.equal(toonHelp.includes('command: poki'), true, 'the installed CLI did not return TOON root help')

  // Every package the shipped bundle still loads has to be a declared runtime
  // dependency, and every declared runtime dependency has to be one the bundle
  // actually loads. Rollup's external list is the only thing that decides
  // which is which, so drift either way breaks an install nobody tested.
  const bundle = await readFile(installedCli, 'utf8')
  const loaded = new Set([...bundle.matchAll(/(?:require|import)\(\s*(['"])([^'"]+)\1\s*\)/g)]
    .map(match => match[2])
    .filter(specifier => !specifier.startsWith('node:') && !isBuiltin(specifier))
    .map(specifier => specifier.startsWith('@')
      ? specifier.split('/').slice(0, 2).join('/')
      : specifier.split('/')[0]))
  const declared = Object.keys(packageJson.dependencies ?? {})
  assert.deepEqual(
    [...loaded].filter(name => !declared.includes(name)),
    [],
    'the shipped bundle loads a package that is not a runtime dependency'
  )
  assert.deepEqual(
    declared.filter(name => !loaded.has(name)),
    [],
    'a runtime dependency is bundled or unused; move it to devDependencies'
  )

  assert.equal(loaded.has('open'), true, 'the shipped bundle does not load the external open package')
  await access(
    join(installDirectory, 'node_modules', 'open', 'xdg-open'),
    process.platform === 'win32' ? constants.F_OK : constants.X_OK
  )

  // A package rollup inlines is redistributed by us, and its licence requires
  // the notice to travel with that copy. The tarball is LICENSE, README.md,
  // package.json and bin/index.js, so the bundle banner is the only place the
  // notice can ride along. rollup.config.mjs generates it from the modules it
  // bundled; this asserts the generated notice reaches an install intact, and
  // compares it against the upstream licence file instead of a copy of that
  // text, so it fails if the banner is dropped, truncated, or left stale.
  const bannerText = bundle.split('\n').map(line => line.replace(/^ \* ?/, '')).join('\n')
  assert.equal(bundle.startsWith('#! /usr/bin/env node\n'), true, 'the packaged bundle does not start with the node shebang')
  const bundledPackages = bannerText.match(/^Bundled packages: (.+)$/m)?.[1].split(', ') ?? []
  assert.notEqual(bundledPackages.length, 0, 'the packaged bundle carries no third-party licence notice')
  for (const name of bundledPackages) {
    const packageDirectory = join(projectDirectory, 'node_modules', name)
    const licenceFile = (await readdir(packageDirectory)).find(entry => /^(licence|license|copying)(\.\w+)?$/i.test(entry))
    assert.notEqual(licenceFile, undefined, `the bundled package ${name} ships no licence file to check the notice against`)
    const licence = await readFile(join(packageDirectory, licenceFile), 'utf8')
    for (const paragraph of licence.trim().split('\n\n')) {
      assert.equal(bannerText.includes(paragraph), true, `the packaged bundle inlines ${name} without its full licence notice`)
    }
  }

  if (shouldPublish) {
    runPublish(join(packDirectory, packResult[0].filename), resolvedPublishArguments)
    if (gitTagPlan !== undefined) publishReleaseGitTag(gitTagPlan)
  }
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true })
}
