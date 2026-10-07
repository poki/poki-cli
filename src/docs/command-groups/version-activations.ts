import { listCapabilities } from '../../list-capabilities'
import type { CommandSpecBuilder } from './types'

export function addVersionActivationCommandSpecs ({ apiAction, example, gameOption, group, listOptionsFor }: CommandSpecBuilder): void {
  group('version-activations', 'List activation history.')
  apiAction(['version-activations', 'list'], 'List stored public-version activation events in chronological order.', { method: 'GET', path: '/games/:gameID/version-activations', contacts_api: true }, ['can_read_owned_games'], {
    options: [gameOption, ...listOptionsFor(listCapabilities.versionActivations)],
    behavior: [
      'Returns every stored activation event ordered by activated_at ascending and then event ID ascending; repeated activations of the same version remain separate events.',
      'deactivated_at is derived from the next stored activation event and is null when no later stored event exists. It is not a stored or observed deactivation.',
      'A version that has never been activated is absent. activated_by is null when no actor was stored.',
      'Each row is a point event recorded when a different version becomes the sole public track at weight 100. Split allocations, removal of that allocation, and other track transitions may have no row.',
      'deactivated_at and adjacent events do not define continuous effective intervals, and a null value on the final event does not prove current state. Inspect current game state separately; this history cannot reconstruct every past track allocation.',
      'versions.activated_at remains a current-public-version annotation, not historical activation data.'
    ],
    examples: [example('poki version-activations list --all', 'Read every stored activation point event for the project game.')]
  })
}
