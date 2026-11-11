import { readFileSync } from 'fs'
import type { Argv } from 'yargs'

import { ApiClient } from '../api'
import { gameABTestsDocumentation, thumbnailABTestsDocumentation } from '../docs/resources'
import { inputError } from '../errors'
import { requireChanges } from '../input'
import { jsonApiDocument } from '../jsonapi'
import { listCapabilities } from '../list-capabilities'
import { getProjectGameId } from '../project'
import { registerResourceDiscovery } from './resource-docs'
import {
  gamePath, getResource, listResources, render, renderList, renderMutation,
  requireConfirmation, resolveMutationInput, withDataOption, withDefaultGameOption,
  withGameActionOptions, withGameMutationOptions, withListOptions, withOutputOptions
} from './common'

const commonFields = { name: 'name', description: 'description', targetSampleSize: 'target_sample_size' }
const variantFields = { versionA: 'version_a_id', versionB: 'version_b_id', device: 'device' }
const variantDescriptions = { versionADescription: 'version_a_description', versionBDescription: 'version_b_description' }
const maxImageBytes = 10 * 1024 * 1024

function fieldMappings (thumbnail: boolean, create: boolean): Record<string, string> {
  return {
    ...commonFields,
    ...(thumbnail ? { targetSampleType: 'target_sample_type', ...(create ? { thumbnailFile: 'thumbnail_b' } : {}) } : { ...variantDescriptions, ...(create ? variantFields : {}) })
  }
}

function withFields (command: Argv, thumbnail: boolean, create: boolean): Argv {
  let result = withGameMutationOptions(withDataOption(command, 'JSON or TOON test fields; mutually exclusive with field flags'), getProjectGameId(), 'Game that owns the test')
    .option('name', { type: 'string', describe: 'Test name; required on create, 3-128 UTF-8 bytes' })
    .option('description', { type: 'string', describe: 'Test description; required for thumbnail tests' })
    .option('target-sample-size', { type: 'number', describe: 'Samples per variant; zero uses the server default on creation' })
  if (thumbnail) {
    result = result.option('target-sample-type', { type: 'string', choices: ['views', 'clicks'], describe: 'Thumbnail sample unit; defaults to clicks on creation' })
    if (create) result = result.option('thumbnail-file', { type: 'string', describe: 'Variant B image, at most 10 MiB; variant A is the current game thumbnail' })
  } else {
    result = result
      .option('version-a-description', { type: 'string', describe: 'Description of variant A' })
      .option('version-b-description', { type: 'string', describe: 'Description of variant B' })
    if (create) {
      result = result
        .option('version-a', { type: 'string', describe: 'Required processed, non-archived version A ID' })
        .option('version-b', { type: 'string', describe: 'Required distinct processed, non-archived version B ID' })
        .option('device', { type: 'string', choices: ['desktop', 'mobile', 'tablet'], describe: 'Optional device restriction; omit for all devices' })
    }
  }
  return result
}

async function testData (argv: Record<string, unknown>, thumbnail: boolean, create: boolean): Promise<Record<string, unknown>> {
  const mappings = fieldMappings(thumbnail, create)
  const data = await resolveMutationInput(argv, { flags: Object.keys(mappings), fields: Object.values(mappings) }, () => {
    const data = Object.fromEntries(Object.entries(mappings).filter(([flag]) => argv[flag] !== undefined).map(([flag, field]) => [field, argv[flag]]))
    if (argv.thumbnailFile !== undefined) {
      try {
        const image = readFileSync(String(argv.thumbnailFile))
        if (image.length > maxImageBytes) throw inputError('thumbnail-file must be at most 10 MiB.')
        data.thumbnail_b = image.toString('base64')
      } catch (error) {
        throw inputError('Could not read thumbnail-file (maximum 10 MiB).', { cause: error instanceof Error ? error.message : String(error) })
      }
    }
    return data
  })
  requireChanges(data)
  if (create || data.name !== undefined) {
    if (typeof data.name !== 'string') throw inputError('name must be a string.')
  }
  for (const field of ['name', 'description', 'version_a_description', 'version_b_description']) {
    if (data[field] === undefined) continue
    if (field.startsWith('version_') && data[field] === null) continue
    if (typeof data[field] !== 'string') throw inputError(`${field} must be a string.`)
    if (field !== 'name' && Buffer.byteLength(data[field]) > 65535) throw inputError(`${field} must contain at most 65535 UTF-8 bytes.`)
  }
  if (thumbnail && (create || data.description !== undefined) && (typeof data.description !== 'string')) throw inputError('description is required for thumbnail tests.')
  if (data.target_sample_size !== undefined) {
    const maximum = thumbnail ? 4294967295 : 2147483647
    // The model checks the lower bound, but not the database column's upper bound.
    if (typeof data.target_sample_size !== 'number' || !Number.isSafeInteger(data.target_sample_size) || data.target_sample_size > maximum) throw inputError(`target_sample_size must be a safe integer no greater than ${maximum}.`)
  }
  if (thumbnail) {
    if (data.target_sample_type !== undefined && (typeof data.target_sample_type !== 'string')) throw inputError('target_sample_type must be a string.')
    if (create) {
      const encoded = typeof data.thumbnail_b === 'string' ? data.thumbnail_b.replace(/[\r\n]/g, '') : ''
      if (encoded === '' || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || Buffer.from(encoded, 'base64').length > maxImageBytes) throw inputError('thumbnail_b must be standard padded base64 encoding an image of at most 10 MiB.')
    }
  } else if (create) {
    for (const field of ['version_a_id', 'version_b_id']) {
      if (typeof data[field] !== 'string' || data[field].trim() === '') throw inputError(`${field} is required.`)
    }
    if (data.device !== undefined && data.device !== null && typeof data.device !== 'string') throw inputError('device must be a string or null.')
  }
  return data
}

export function registerABTestCommands (yargs: Argv, api: ApiClient): Argv {
  const projectGameId = getProjectGameId()
  for (const thumbnail of [false, true]) {
    const kind = thumbnail ? 'thumbnail-ab-tests' : 'game-ab-tests'
    const type = thumbnail ? 'game_thumbnail_ab_tests' : 'ab_tests'
    const documentation = thumbnail ? thumbnailABTestsDocumentation : gameABTestsDocumentation
    const capabilities = thumbnail ? listCapabilities.thumbnailABTests : listCapabilities.gameABTests
    yargs = yargs.command(kind, `Manage ${thumbnail ? 'thumbnail' : 'game version'} A/B tests`, group => {
      let commands = registerResourceDiscovery(group, documentation)
        .command('list', 'List tests and results', list => withDefaultGameOption(withListOptions(list, capabilities, kind), projectGameId), async argv => {
          renderList(await listResources(api, gamePath(argv.game, type), argv, capabilities), argv, kind)
        })
        .command('get <test-id>', 'Inspect one test and its results', get => withDefaultGameOption(withOutputOptions(get), projectGameId)
          .positional('test-id', { type: 'string', demandOption: true, describe: 'A/B test ID' }), async argv => {
          render(await getResource(api, gamePath(argv.game, type, argv.testId), argv, { type, id: String(argv.testId) }, 'A/B test read'), argv)
        })
      for (const create of [true, false]) {
        commands = commands.command(create ? 'create' : 'update <test-id>', create ? 'Create a draft test' : 'Update test details', command => {
          const result = withFields(command, thumbnail, create)
          return create ? result : result.positional('test-id', { type: 'string', demandOption: true, describe: 'A/B test ID' })
        }, async argv => {
          const data = await testData(argv, thumbnail, create)
          const id = create ? undefined : String(argv.testId)
          const path = gamePath(argv.game, type, ...(id === undefined ? [] : [id]))
          const body = jsonApiDocument(type, data, id)
          const previewBody = data.thumbnail_b === undefined ? undefined : jsonApiDocument(type, { ...data, thumbnail_b: { encoding: 'base64', encoded_characters: String(data.thumbnail_b).length, value_omitted: true } }, id)
          await renderMutation(api, argv, { method: create ? 'POST' : 'PATCH', path, body, previewBody, expected: { type, id }, behavior: { sideEffects: [create ? 'Creates a draft; use start to enable the experiment.' : 'Updates test details; the backend restricts sample targets and variant descriptions to drafts.'] } })
        })
      }
      for (const action of ['start', 'stop', 'delete'] as const) {
        commands = commands.command(`${action} <test-id>`, `${action} an A/B test`, command => withGameActionOptions(command, projectGameId, 'Game that owns the test', { destructive: true })
          .positional('test-id', { type: 'string', demandOption: true, describe: 'A/B test ID' }), async argv => {
          requireConfirmation(argv, `${action} an A/B test`)
          const id = String(argv.testId)
          const path = gamePath(argv.game, type, id) + (action === 'delete' ? '' : `/@${action}`)
          const effect = action === 'start'
            ? 'Starts the experiment and changes live variant exposure.'
            : action === 'delete'
              ? 'Deletes a draft test; active tests must be stopped instead.'
              : thumbnail ? 'Cancels the experiment; does not apply the winning thumbnail.' : 'Cancels the experiment and restores the pre-test public version (falling back to variant A).'
          await renderMutation(api, argv, { method: action === 'delete' ? 'DELETE' : 'POST', path, expected: { type, id }, behavior: { destructive: true, sideEffects: [effect] }, action: { result: { type, id, action }, preferResponse: true } })
        })
      }
      return commands.demandCommand(1, `Choose ${kind} list, get, create, update, start, stop, or delete.`)
    }, () => {})
  }
  return yargs
}
