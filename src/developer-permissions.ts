// This catalog is the complete permission vocabulary surfaced by the
// developer CLI. The backend can return additional role-wide capabilities,
// but normalized CLI output and help intentionally omit permissions that do
// not belong to a supported developer workflow.
export const developerPermissionCatalog = [
  { code: 'can_activate_approved_versions', description: 'Activate a completed version with an approved review when direct traffic-track editing is unavailable.' },
  { code: 'can_create_owned_game_change_requests', description: 'Request supported title, thumbnail, or content-security-policy changes for a game belonging to the current user or team.' },
  { code: 'can_create_owned_games', description: 'Create a game for the current user’s team.' },
  { code: 'can_create_owned_player_feedback_question', description: 'Queue a generated player-feedback question for a game belonging to the current user or team.' },
  { code: 'can_create_owned_reviews', description: 'Request a review for a version belonging to the current user or team.' },
  { code: 'can_create_owned_versions', description: 'Create or upload a version for a game belonging to the current user or team.' },
  { code: 'can_delete_owned_player_feedback_question', description: 'Delete a generated player-feedback question for a game belonging to the current user or team.' },
  { code: 'can_edit_game_selected_fields', description: 'Update the selected game fields that the developer API exposes as directly editable.' },
  { code: 'can_edit_owned_game_events', description: 'Create, update, or delete event definitions and funnels for a game belonging to the current user or team.' },
  { code: 'can_edit_owned_game_tracks', description: 'Replace traffic-track allocation for a game belonging to the current user or team.' },
  { code: 'can_edit_owned_player_fit_tests', description: 'Create or stop Player Fit tests for a game belonging to the current user or team.' },
  { code: 'can_edit_owned_playtests', description: 'Create or cancel Playtest requests and edit recordings for a game belonging to the current user or team.' },
  { code: 'can_edit_owned_reviews', description: 'Update or close reviews for a game belonging to the current user or team.' },
  { code: 'can_edit_owned_versions', description: 'Update, archive, or restore versions belonging to the current user or team.' },
  { code: 'can_query_clickhouse', description: 'Run analytics queries; backend table and row scoping still applies.' },
  { code: 'can_read_owned_game_change_requests', description: 'List or read game-change requests for a game belonging to the current user or team.' },
  { code: 'can_read_owned_game_events', description: 'List event definitions and funnels for a game belonging to the current user or team.' },
  { code: 'can_read_owned_games', description: 'List or read games belonging to the current user or team.' },
  { code: 'can_read_owned_netlib_lobbies', description: 'List live Netlib lobbies for a game belonging to the current user or team.' },
  { code: 'can_read_owned_player_feedback', description: 'List or read generated player-feedback questions for a game belonging to the current user or team.' },
  { code: 'can_read_owned_player_fit_tests', description: 'List or read Player Fit tests for a game belonging to the current user or team.' },
  { code: 'can_read_owned_playtest_recordings', description: 'List, read, archive, restore, or mark watched Playtest recordings for a game belonging to the current user or team.' },
  { code: 'can_read_owned_reviews', description: 'List or read reviews for a game belonging to the current user or team.' },
  { code: 'can_read_self', description: 'Read the authenticated user, team relationship, and effective permission metadata.' }
] as const

export type DeveloperPermissionCode = typeof developerPermissionCatalog[number]['code']

export interface DeveloperPermissionRequirement {
  readonly code: DeveloperPermissionCode
  readonly description: string
}

export const developerPermissionCodes: readonly DeveloperPermissionCode[] = developerPermissionCatalog.map(permission => permission.code)

const developerPermissionByCode = new Map<DeveloperPermissionCode, DeveloperPermissionRequirement>(
  developerPermissionCatalog.map(permission => [permission.code, permission])
)

export function isDeveloperPermission (value: string): value is DeveloperPermissionCode {
  return developerPermissionByCode.has(value as DeveloperPermissionCode)
}

export function developerPermissionRequirements (codes: readonly DeveloperPermissionCode[]): DeveloperPermissionRequirement[] {
  return codes.map(code => {
    const permission = developerPermissionByCode.get(code)
    if (permission === undefined) throw new Error(`Unknown developer permission: ${code}`)
    return permission
  })
}

export function sanitizeDeveloperPermissions (value: unknown): DeveloperPermissionCode[] {
  if (!Array.isArray(value)) return []
  return value.map(String).filter(isDeveloperPermission)
}
