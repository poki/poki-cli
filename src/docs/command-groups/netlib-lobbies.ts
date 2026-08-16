import { listCapabilities } from '../../list-capabilities'
import type { CommandSpecBuilder } from './types'

export function addNetlibLobbyCommandSpecs ({ apiAction, example, gameOption, group, listOptionsFor }: CommandSpecBuilder): void {
  group('netlib-lobbies', 'Inspect live Netlib lobbies for one developer-owned game.')
  apiAction(['netlib-lobbies', 'list'], 'List live Netlib lobbies with bounded pagination.', { method: 'GET', path: '/games/:gameID/netlib/lobbies', contacts_api: true }, ['can_read_owned_netlib_lobbies'], { options: [gameOption, ...listOptionsFor(listCapabilities.netlibLobbies)], behavior: ['Supports JSON:API filters, sorting, and pagination; the API defaults to peer_count descending.', 'peer_count includes disconnected ghosts; subtract ghosts to derive the currently connected peer count.', 'Private lobby codes are sensitive connection credentials and should not be published.'], examples: [example('poki netlib-lobbies list --filter public=true --sort -created_at --all', 'List public lobbies for the project game from newest to oldest.')] })
}
