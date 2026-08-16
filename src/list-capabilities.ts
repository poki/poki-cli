export interface ListCapabilities {
  filter: boolean
  sort: boolean
  pagination: boolean
}

// Current Poki for Developers collection capabilities. This is shared by the
// yargs declarations, request builder, and structured help so unsupported
// options cannot be advertised or silently sent to handlers that ignore them.
export const listCapabilities = {
  games: { filter: false, sort: true, pagination: true },
  versions: { filter: true, sort: true, pagination: true },
  versionActivations: { filter: false, sort: false, pagination: true },
  versionFiles: { filter: false, sort: false, pagination: false },
  playtests: { filter: true, sort: false, pagination: false },
  playerFitTests: { filter: true, sort: false, pagination: false },
  reviews: { filter: true, sort: true, pagination: true },
  gameChangeRequests: { filter: true, sort: true, pagination: true },
  gameEvents: { filter: false, sort: true, pagination: true },
  gameEventFunnels: { filter: false, sort: true, pagination: true },
  playerFeedbackQuestions: { filter: false, sort: true, pagination: true },
  netlibLobbies: { filter: true, sort: true, pagination: true }
} as const satisfies Record<string, ListCapabilities>
