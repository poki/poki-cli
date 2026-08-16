import { isRecord } from './json'

// Point-in-time advisory diagnostic derived from one game response and
// /users/@me. It never contacts the API itself and never becomes an automatic
// preflight: the backend stays authoritative for ownership, resource state,
// and effective grants.

function asRecordArray (value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter(isRecord) : []
}

function idOf (value: unknown): string | undefined {
  if (typeof value === 'string' && value !== '') return value
  if (!isRecord(value) || value.id === undefined) return undefined
  return String(value.id)
}

function stringField (record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field]
  return value === undefined || value === null || String(value) === '' ? undefined : String(value)
}

interface ReadinessBlocker {
  code: string
  message: string
}

function operationReadiness (
  candidates: string[],
  blockers: ReadinessBlocker[],
  requirements: string[],
  backendChecks: string[] = [],
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  const status = blockers.length > 0
    ? 'blocked'
    : backendChecks.length > 0
      ? 'backend_check_required'
      : 'ready'
  return {
    status,
    ready: status === 'ready' ? true : status === 'blocked' ? false : null,
    candidate_version_ids: candidates,
    blockers,
    ...(backendChecks.length === 0 ? {} : { backend_checks: backendChecks }),
    requirements,
    requirements_scope: 'cli_and_backend',
    ...extra
  }
}

export function gameReadiness (
  game: Record<string, unknown>,
  user: Record<string, unknown>,
  permissionValues: unknown
): Record<string, unknown> {
  const permissions = new Set(Array.isArray(permissionValues) ? permissionValues.map(String) : [])
  const versions = asRecordArray(game.versions)
  const versionIDs = versions.map(version => idOf(version)).filter((id): id is string => id !== undefined)
  const tracks = asRecordArray(game.tracks)
  const activeRequests = asRecordArray(game.playtest_requests)
  const visibleActiveRequestVersions = new Set(activeRequests
    .map(request => stringField(request, 'version_id') ?? idOf(request.version))
    .filter((id): id is string => id !== undefined))

  const gameTeamID = stringField(game, 'team_id') ?? idOf(game.team)
  const userTeamID = stringField(user, 'team_id') ?? idOf(user.team)
  const gameUploaderID = stringField(game, 'uploader_id') ?? idOf(game.uploader)
  const userID = idOf(user)
  const ownsGame = (gameTeamID !== undefined && gameTeamID === userTeamID) || (gameUploaderID !== undefined && gameUploaderID === userID)
  const hasOwnedPermission = (owned: string): boolean => ownsGame && permissions.has(owned)

  const canEditTracks = hasOwnedPermission('can_edit_owned_game_tracks')
  const canActivateApproved = ownsGame && permissions.has('can_activate_approved_versions')
  const doneVersions = versions.filter(version => version.state === 'done')
  const doneVersionIDs = doneVersions.map(version => idOf(version)).filter((id): id is string => id !== undefined)
  const activationCandidates = doneVersions.filter(version => {
    return canEditTracks || (canActivateApproved && version.cached_latest_review_status === 'approved')
  }).map(version => idOf(version)).filter((id): id is string => id !== undefined)
  const activationPossibleCandidates = !canEditTracks && canActivateApproved
    ? doneVersionIDs.filter(id => !activationCandidates.includes(id))
    : []
  const activationBlockers: ReadinessBlocker[] = []
  if (tracks.length > 1) {
    activationBlockers.push({ code: 'ACTIVE_VERSION_MULTIPLE_TRACKS', message: 'The backend rejects active-version changes while the game has multiple tracks.' })
  }
  if (!canEditTracks && !canActivateApproved) {
    activationBlockers.push({ code: 'ACTIVATION_PERMISSION_NOT_GRANTED', message: 'The current account has neither scoped track-edit permission nor approved-version activation permission for this game.' })
  }
  if (doneVersionIDs.length === 0) {
    activationBlockers.push({ code: 'NO_DONE_VERSION', message: 'The backend requires an activated version to have state done.' })
  }
  const activationBackendChecks = activationBlockers.length === 0 && activationCandidates.length === 0 && activationPossibleCandidates.length > 0
    ? ['The game response exposes only cached latest review status. The backend checks complete review history during activation, so these done versions cannot be classified locally.']
    : []

  const canCreatePlaytest = hasOwnedPermission('can_edit_owned_playtests')
  // Developer-visible game relationships intentionally omit hidden requests,
  // so their absence can never prove that the backend has no active request.
  const activeRequestVisibilityComplete = false
  const playtestCandidates = versionIDs.filter(id => !visibleActiveRequestVersions.has(id))
  const playtestBlockers: ReadinessBlocker[] = []
  if (!canCreatePlaytest) playtestBlockers.push({ code: 'PLAYTEST_PERMISSION_NOT_GRANTED', message: 'The current account lacks scoped playtest edit permission for this game.' })
  if (versionIDs.length === 0) playtestBlockers.push({ code: 'NO_VERSION', message: 'A Playtest request must reference a version belonging to the game.' })
  if (versionIDs.length > 0 && playtestCandidates.length === 0) {
    playtestBlockers.push({ code: 'ACTIVE_PLAYTEST_REQUESTS', message: 'Every visible game version already has an active Playtest request.' })
  }
  const playtestBackendChecks = playtestBlockers.length === 0 && !activeRequestVisibilityComplete
    ? ['Hidden active Playtest requests are not visible to this account. The backend rechecks the selected version for an active request.']
    : []

  const canCreatePlayerFit = hasOwnedPermission('can_edit_owned_player_fit_tests')
  const playerFitBlockers: ReadinessBlocker[] = []
  if (!canCreatePlayerFit) playerFitBlockers.push({ code: 'PLAYER_FIT_PERMISSION_NOT_GRANTED', message: 'The current account lacks scoped Player Fit edit permission for this game.' })
  if (versionIDs.length === 0) playerFitBlockers.push({ code: 'NO_VERSION', message: 'A Player Fit test must reference a version belonging to the game.' })

  return {
    type: 'game_readiness',
    id: idOf(game) ?? '',
    game: {
      title: game.title ?? null,
      team_id: gameTeamID ?? null,
      owned_by_current_account: ownsGame,
      track_count: tracks.length,
      version_count: versionIDs.length
    },
    operations: {
      versions_activate: operationReadiness(activationCandidates, activationBlockers, [
        'At most one existing traffic track.',
        'The selected version belongs to this game and has state done.',
        'Scoped track-edit permission, or approved-version activation permission plus an approved review.'
      ], activationBackendChecks, {
        command: 'poki versions activate VERSION_ID --yes',
        cached_review_status_is_advisory: !canEditTracks,
        ...(activationPossibleCandidates.length === 0 ? {} : { possible_candidate_version_ids: activationPossibleCandidates })
      }),
      playtest_requests_create: operationReadiness(playtestCandidates, playtestBlockers, [
        'The selected version belongs to this game.',
        'No active Playtest request exists for the selected version.',
        'Scoped playtest edit permission.'
      ], playtestBackendChecks, { command: 'poki playtest-requests create --version VERSION_ID', active_request_visibility_complete: activeRequestVisibilityComplete, visible_active_request_version_ids: [...visibleActiveRequestVersions] }),
      player_fit_tests_create: operationReadiness(versionIDs, playerFitBlockers, [
        'The selected version belongs to this game.',
        'Scoped Player Fit edit permission.'
      ], [], { command: 'poki player-fit-tests create --version VERSION_ID' })
    }
  }
}
