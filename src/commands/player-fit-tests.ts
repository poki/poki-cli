import type { Argv } from 'yargs'

import { ApiClient } from '../api'
import { playerFitTestsDocumentation } from '../docs/resources'
import { inputError } from '../errors'
import { jsonApiDocument } from '../jsonapi'
import { listCapabilities } from '../list-capabilities'
import { getProjectGameId } from '../project'
import {
  applyAudienceInputDefaults,
  audienceInputFromFlags,
  audienceOrientations,
  CategoryLimit,
  deviceCategories,
  validateAudienceInput
} from './audience-input'
import { registerResourceDiscovery } from './resource-docs'
import {
  asStrings,
  gamePath,
  getFromCollection,
  listResources,
  mutationInputFields,
  render,
  renderList,
  renderMutation,
  requireConfirmation,
  resolveMutationInput,
  withDataOption,
  withDefaultGameOption,
  withGameMutationOptions,
  withListOptions,
  withOutputOptions
} from './common'

const createInput = mutationInputFields({
  deviceCategory: 'device_category',
  category: 'categories',
  categoryOnly: 'category_only',
  orientation: 'orientation',
  country: 'countries'
})
const categoryLimit: CategoryLimit = { max: 5, message: 'Player Fit tests support at most five categories.' }

function countriesValue (value: unknown): string {
  const values = asStrings(value) ?? []
  if (values.some(country => !/^[A-Z]{2}$/.test(country))) {
    throw inputError('--country values must be uppercase two-letter country codes.')
  }
  return values.join(',')
}

function validateCreateData (data: Record<string, unknown>): void {
  validateAudienceInput(data, { categoryLimit })
  if (typeof data.countries !== 'string') throw inputError('countries must be a comma-separated list of uppercase two-letter country codes.')
  const countries = data.countries
  if (countries !== '' && !/^[A-Z]{2}(,[A-Z]{2})*$/.test(countries)) {
    throw inputError('countries must be a comma-separated list of uppercase two-letter country codes.')
  }
  if (typeof data.category_only !== 'boolean') throw inputError('category_only must be a boolean.')
}

export function registerPlayerFitTestCommands (yargs: Argv, api: ApiClient): Argv {
  const projectGameId = getProjectGameId()

  return yargs.command('player-fit-tests', 'List, inspect, and create Player Fit tests', tests => registerResourceDiscovery(tests, playerFitTestsDocumentation)
    .command('list', 'List Player Fit tests for a game', list => withDefaultGameOption(withListOptions(list, listCapabilities.playerFitTests, 'player-fit-tests'), projectGameId, 'Use the developer-accessible tests for this game'), async argv => {
      renderList(await listResources(api, gamePath(argv.game, 'player_fit_tests'), argv, listCapabilities.playerFitTests), argv, 'player-fit-tests')
    })
    .command('get <test-id>', 'Get one Player Fit test from its game-scoped collection', get => withDefaultGameOption(withOutputOptions(get), projectGameId, 'Game ID that owns the test')
      .positional('test-id', { describe: 'Player Fit test ID', type: 'string', demandOption: true }), async argv => {
      render(await getFromCollection(api, gamePath(argv.game, 'player_fit_tests'), argv, listCapabilities.playerFitTests, 'id', { type: 'player_fit_tests', id: String(argv.testId) }, {
        label: 'Player Fit test',
        hint: 'Run `poki player-fit-tests list` to see visible test IDs.'
      }), argv)
    })
    .command('create', 'Create a Player Fit test with the product-defined target of 500 gameplays', create => withGameMutationOptions(withDataOption(create, 'JSON or TOON audience-settings object, @file, or - for stdin; version remains a flag and game may come from project configuration'), projectGameId, 'Game ID that owns the version')
      .option('version', { describe: 'Version ID to test', type: 'string', demandOption: true })
      .option('device-category', { describe: 'Device audience', choices: deviceCategories })
      .option('orientation', { describe: 'Required screen orientation', choices: audienceOrientations })
      .option('category', { describe: 'Numeric category ID; repeat up to five times', type: 'array', string: true })
      .option('category-only', { describe: 'Restrict recruitment to the selected categories', type: 'boolean' })
      .option('country', { describe: 'Uppercase two-letter country code; repeat for multiple countries', type: 'array', string: true }), async argv => {
      const data = await resolveMutationInput(argv, createInput, () => ({
        ...audienceInputFromFlags(argv, { defaults: true, categoryLimit }),
        category_only: argv.categoryOnly ?? false,
        countries: countriesValue(argv.country)
      }))
      applyAudienceInputDefaults(data)
      data.category_only ??= false
      data.countries ??= ''
      validateCreateData(data)

      const attributes = {
        ...data,
        game_id: argv.game,
        version_id: argv.version,
        target_gameplays: 500
      }
      const body = jsonApiDocument('player_fit_tests', attributes)
      await renderMutation(api, argv, { method: 'POST', path: gamePath(argv.game, 'player_fit_tests'), body, expected: { type: 'player_fit_tests' }, behavior: { sideEffects: ['Starts recruitment and may advance the self-service stage or notify watchers.'] } })
    })
    .command('stop <test-id>', 'Stop an active Player Fit test', stop => withGameMutationOptions(stop, projectGameId, 'Game ID that owns the test', { destructive: true })
      .positional('test-id', { describe: 'Player Fit test ID', type: 'string', demandOption: true }), async argv => {
      requireConfirmation(argv, 'Stopping a Player Fit test')
      const id = String(argv.testId)
      await renderMutation(api, argv, { method: 'POST', path: `${gamePath(argv.game, 'player_fit_tests', id)}/@stop`, expected: { type: 'player_fit_tests', id }, behavior: { destructive: true, sideEffects: ['Permanently stops recruitment for this test.'] }, action: { result: { id, stopped: true } } })
    })
    .demandCommand(1, 'Choose player-fit-tests list, get, create, or stop.'), () => {})
}
