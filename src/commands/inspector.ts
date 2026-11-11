import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Argv } from 'yargs'

import { inputError, registerInterruptCleanup } from '../errors'
import { InspectorClient, MAX_INSPECTOR_UPLOAD_BYTES } from '../inspector'
import { readProjectConfigContext } from '../project'
import { appendUploadFile } from '../uploads'
import { createZip } from '../zipfile'
import { mutationPreview, render, requestTimeout, withMutationOptions, withUploadOutputOptions } from './common'

export function registerInspectorCommands (yargs: Argv, inspector: InspectorClient): Argv {
  return yargs.command('inspector', 'Upload builds for testing in Inspector', commands => commands
    .command('upload', 'Zip a build and return a shareable Inspector URL', upload => withMutationOptions(withUploadOutputOptions(upload))
      .option('build-dir', { describe: 'Non-empty existing directory; defaults to project build_dir or dist', type: 'string' })
      .option('disable-transforms', { describe: 'Disable upload transforms', type: 'boolean', default: false }), async argv => {
      const requestedBuildDir = String(argv.buildDir ?? readProjectConfigContext().config.build_dir ?? 'dist')
      if (requestedBuildDir.trim() === '') throw inputError('--build-dir must be a non-empty directory path.')
      const buildDir = resolve(requestedBuildDir)
      try {
        if (!statSync(buildDir).isDirectory()) throw new Error('not a directory')
        if (readdirSync(buildDir).length === 0) throw new Error('directory is empty')
      } catch {
        throw inputError(`Build directory '${buildDir}' must be an accessible, non-empty directory.`, { build_dir: buildDir })
      }

      if (mutationPreview('POST', new URL('/v0/builds', inspector.baseUrl).toString(), {
        multipart: true,
        file: { source_directory: buildDir, archive_name: 'build.zip' },
        'disable-transforms': argv.disableTransforms
      }, argv, { sideEffects: ['Uploads a shareable build to Inspector and starts background image analysis.'] })) return

      const temporaryDirectory = mkdtempSync(join(tmpdir(), 'poki-cli-inspector-'))
      const cleanup = (): void => { rmSync(temporaryDirectory, { recursive: true, force: true }) }
      const unregister = registerInterruptCleanup(cleanup)
      try {
        const archivePath = join(temporaryDirectory, 'build.zip')
        try {
          await createZip(archivePath, buildDir)
        } catch {
          throw inputError('Could not archive the build directory.', { build_dir: buildDir })
        }
        if (statSync(archivePath).size > MAX_INSPECTOR_UPLOAD_BYTES) {
          throw inputError('The Inspector build ZIP must be no larger than 1 GiB.')
        }
        const form = new FormData()
        await appendUploadFile(form, 'file', archivePath, 'build.zip', 'application/zip')
        if (argv.disableTransforms) form.append('disable-transforms', 'true')
        const result = await inspector.upload(form, requestTimeout(argv))
        render(argv.raw === true ? result.raw : { data: result.data, meta: {} }, argv)
      } finally {
        unregister()
        // Cleanup must not replace a result after the remote upload committed.
        try { cleanup() } catch {}
      }
    })
    .demandCommand(1, 'Choose inspector upload.'), () => {})
}
