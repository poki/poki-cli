import type { Argv } from 'yargs'

import { ApiClient } from '../api'
import { reviewsDocumentation } from '../docs/resources'
import { inputError } from '../errors'
import { containsZeroWidthCharacter, requireChanges } from '../input'
import { jsonApiDocument } from '../jsonapi'
import { listCapabilities } from '../list-capabilities'
import { getProjectGameId } from '../project'
import { registerResourceDiscovery } from './resource-docs'
import {
  gamePath,
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
  withOutputOptions,
  getResource
} from './common'

const requestInput = mutationInputFields({ developerNotes: 'developer_notes' })
const updateInput = mutationInputFields({ developerNotes: 'developer_notes', seen: 'seen_by_developer' })

function reviewPath (game: unknown, version: unknown, review?: unknown): string {
  return gamePath(game, 'versions', version, 'reviews', ...(review === undefined ? [] : [review]))
}

function validateReviewUpdate (data: Record<string, unknown>): void {
  if (Object.hasOwn(data, 'developer_notes') && typeof data.developer_notes !== 'string') {
    throw inputError('developer_notes must be a string.')
  }
  if (Object.hasOwn(data, 'seen_by_developer') && typeof data.seen_by_developer !== 'boolean') {
    throw inputError('seen_by_developer must be a boolean.')
  }
  if (typeof data.developer_notes === 'string' && containsZeroWidthCharacter(data.developer_notes)) {
    throw inputError('developer_notes must not contain zero-width characters.')
  }
}

export function registerReviewCommands (yargs: Argv, api: ApiClient): Argv {
  const projectGameId = getProjectGameId()

  return yargs.command('reviews', 'List, inspect, request, update, and close version reviews', reviews => registerResourceDiscovery(reviews, reviewsDocumentation)
    .command('list', 'List reviews for a game or one version', list => withDefaultGameOption(withListOptions(list, listCapabilities.reviews, 'reviews'), projectGameId, 'Parent game ID')
      .option('version', { describe: 'Restrict to one version ID; omit to list reviews across the game', type: 'string' }), async argv => {
      const path = argv.version === undefined
        ? gamePath(argv.game, 'reviews')
        : reviewPath(argv.game, argv.version)
      renderList(await listResources(api, path, argv, listCapabilities.reviews), argv, 'reviews')
    })
    .command('get <version-id> <review-id>', 'Get one review including report metadata visible to the caller', get => withDefaultGameOption(withOutputOptions(get), projectGameId, 'Parent game ID')
      .positional('version-id', { describe: 'Version ID', type: 'string', demandOption: true })
      .positional('review-id', { describe: 'Review ID', type: 'string', demandOption: true }), async argv => {
      const reviewID = String(argv.reviewId)
      render(await getResource(api, reviewPath(argv.game, argv.versionId, reviewID), argv, { type: 'reviews', id: reviewID }, 'review read'), argv)
    })
    .command('request', 'Request a review for a processed version', request => withGameMutationOptions(withDataOption(request, 'JSON or TOON object containing developer_notes'), projectGameId, 'Parent game ID')
      .option('version', { describe: 'Processed version ID to review', type: 'string', demandOption: true })
      .option('developer-notes', { describe: 'Required notes for the reviewer', type: 'string' }), async argv => {
      const data = await resolveMutationInput(argv, requestInput, () => ({ developer_notes: argv.developerNotes }))
      if (typeof data.developer_notes !== 'string' || data.developer_notes.trim() === '') throw inputError('developer_notes is required.')
      if (containsZeroWidthCharacter(data.developer_notes)) throw inputError('developer_notes must not contain zero-width characters.')
      const path = reviewPath(argv.game, argv.version)
      const body = jsonApiDocument('reviews', data)
      await renderMutation(api, argv, { method: 'POST', path, body, expected: { type: 'reviews' }, behavior: { sideEffects: ['Queues QA and notifies game watchers.'] } })
    })
    .command('update <version-id> <review-id>', 'Update developer notes or mark a review response seen', update => withGameMutationOptions(withDataOption(update, 'JSON or TOON object containing developer_notes and/or seen_by_developer'), projectGameId, 'Parent game ID')
      .positional('version-id', { describe: 'Version ID', type: 'string', demandOption: true })
      .positional('review-id', { describe: 'Review ID', type: 'string', demandOption: true })
      .option('developer-notes', { describe: 'Replacement developer notes', type: 'string' })
      .option('seen', { describe: 'Set seen_by_developer', type: 'boolean' }), async argv => {
      const data = await resolveMutationInput(argv, updateInput, () => ({
        ...(argv.developerNotes === undefined ? {} : { developer_notes: argv.developerNotes }),
        ...(argv.seen === undefined ? {} : { seen_by_developer: argv.seen })
      }))
      requireChanges(data)
      validateReviewUpdate(data)
      const path = reviewPath(argv.game, argv.versionId, argv.reviewId)
      const body = jsonApiDocument('reviews', data, String(argv.reviewId))
      await renderMutation(api, argv, { method: 'PATCH', path, body, expected: { type: 'reviews', id: String(argv.reviewId) }, behavior: { sideEffects: ['Updates the review and audit history.'] } })
    })
    .command('close <version-id> <review-id>', 'Close a pending review without approving or rejecting it', close => withGameMutationOptions(close, projectGameId, 'Parent game ID', { destructive: true })
      .positional('version-id', { describe: 'Version ID', type: 'string', demandOption: true })
      .positional('review-id', { describe: 'Pending review ID', type: 'string', demandOption: true }), async argv => {
      requireConfirmation(argv, 'Closing a review')
      const path = reviewPath(argv.game, argv.versionId, argv.reviewId)
      const body = jsonApiDocument('reviews', { status: 'closed' }, String(argv.reviewId))
      await renderMutation(api, argv, { method: 'PATCH', path, body, expected: { type: 'reviews', id: String(argv.reviewId) }, behavior: { destructive: true, sideEffects: ['Removes the pending review from the QA queue.'] } })
    })
    .demandCommand(1, 'Choose reviews list, get, request, update, or close.'), () => {})
}
