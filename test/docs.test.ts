import assert from 'node:assert/strict'
import test from 'node:test'

import { commandSpec } from '../src/docs/commands'
import {
  gameChangeRequestsDocumentation,
  gameEventFunnelsDocumentation,
  gameEventsDocumentation,
  gamesDocumentation,
  netlibLobbiesDocumentation,
  playerFeedbackQuestionsDocumentation,
  playerFitTestsDocumentation,
  playtestsDocumentation,
  resourceDocumentationRegistry,
  resourceFieldDetails,
  resourceDocumentations,
  reviewsDocumentation,
  versionActivationsDocumentation,
  versionsDocumentation
} from '../src/docs/resources'
import { RESOURCE_API_TIME_ZONE } from '../src/timezones'

void test('resource documentation keeps structural invariants for every documented resource', () => {
  assert.equal(new Set(resourceDocumentationRegistry.map(resource => resource.kind)).size, resourceDocumentationRegistry.length)
  assert.equal(new Set(resourceDocumentationRegistry.map(resource => resource.apiType)).size, resourceDocumentationRegistry.length)
  for (const documentation of resourceDocumentations) {
    assert.ok(documentation.fields.length > 0, documentation.command)
    const names = documentation.fields.map(field => field.name)
    assert.equal(new Set(names).size, names.length, documentation.command)
    assert.ok(names.every(name => name.trim() !== ''), documentation.command)
    for (const field of documentation.fields) {
      assert.ok(field.type.trim() !== '', `${documentation.command}.${field.name}`)
      assert.ok(field.access.trim() !== '', `${documentation.command}.${field.name}`)
      assert.ok(field.description.trim() !== '', `${documentation.command}.${field.name}`)
      const relationship = field.access.includes('relationship') || field.type.includes('relationship')
      assert.equal((field.relationshipApiTypes?.length ?? 0) > 0, relationship, `${documentation.command}.${field.name}`)
    }
    for (const field of documentation.fields.filter(field => field.type.startsWith('timestamp'))) {
      assert.match(field.description, /UTC/, `${documentation.command}.${field.name}`)
      assert.equal(resourceFieldDetails(documentation, field.name)?.time_zone, RESOURCE_API_TIME_ZONE, `${documentation.command}.${field.name}`)
      assert.equal(resourceFieldDetails(documentation, field.name)?.encoding, 'unix_seconds', `${documentation.command}.${field.name}`)
    }
    assert.ok(documentation.references.length > 0, documentation.command)
    assert.ok(documentation.references.every(reference => reference.url.startsWith('https://sdk.poki.com/')), documentation.command)
  }
})

void test('every resource documentation command is a registered command group with field discovery', () => {
  for (const documentation of resourceDocumentations) {
    assert.notEqual(commandSpec([documentation.command]), undefined, documentation.command)
    assert.notEqual(commandSpec([documentation.command, 'fields']), undefined, documentation.command)
    assert.notEqual(commandSpec([documentation.command, 'field']), undefined, documentation.command)
  }
})

void test('auth login documents the accepted callback lifecycle limitations', () => {
  const login = commandSpec(['auth', 'login'])
  const behavior = login?.behavior?.join(' ') ?? ''
  assert.match(behavior, /OS-assigned callback port/i)
  assert.match(behavior, /no CLI-generated nonce/i)
  assert.match(behavior, /no .*callback timeout/i)
  assert.match(behavior, /until the callback arrives or the process is interrupted/i)
})

void test('multi-request command contracts include every route and conditional permission', () => {
  const contracts: Array<{
    path: string[]
    network: string[]
    permissions: string[]
    condition?: string
  }> = [
    {
      path: ['versions', 'upload'],
      network: ['POST /games/:gameID/versions', 'GET /versions/:createdVersionID (--wait only)'],
      permissions: ['can_create_owned_versions', 'can_read_owned_games'],
      condition: '--wait'
    },
    {
      path: ['versions', 'activate'],
      network: ['GET /games/:gameID', 'PATCH /games/:gameID'],
      permissions: ['can_read_owned_games', 'can_edit_owned_game_tracks', 'can_activate_approved_versions']
    },
    {
      path: ['playtest-requests', 'create'],
      network: ['GET /games/:gameID (--normal-tile execution only)', 'POST /games/:gameID/playtest-requests'],
      permissions: ['can_edit_owned_playtests', 'can_read_owned_games'],
      condition: '--normal-tile'
    },
    {
      path: ['playtest-requests', 'replace'],
      network: ['GET /games/:gameID', 'DELETE /games/:gameID/playtest-requests/:requestID', 'POST /games/:gameID/playtest-requests'],
      permissions: ['can_read_owned_games', 'can_edit_owned_playtests']
    },
    {
      path: ['player-feedback-questions', 'create'],
      network: ['POST /games/:gameID/player_feedback_questions', 'GET /games/:gameID/player_feedback_questions/:createdQuestionID (--wait only)'],
      permissions: ['can_create_owned_player_feedback_question', 'can_read_owned_player_feedback'],
      condition: '--wait'
    }
  ]

  for (const contract of contracts) {
    const spec = commandSpec(contract.path)
    const label = contract.path.join(' ')
    assert.equal(spec?.network?.method, 'MULTIPLE', label)
    assert.deepEqual(spec?.network?.path, contract.network, label)
    assert.deepEqual(spec?.permission_codes, contract.permissions, label)
    const permissionLogic = spec?.permission_logic ?? ''
    assert.notEqual(permissionLogic, '', label)
    for (const permission of contract.permissions) {
      assert.match(permissionLogic, new RegExp(`\\b${permission}\\b`), label)
    }
    if (contract.condition !== undefined) assert.match(permissionLogic, new RegExp(contract.condition), label)
  }
})

void test('server-backed field corrections stay explicit for agents', () => {
  assert.equal(resourceFieldDetails(gamesDocumentation, 'title')?.mutability, 'create_only')
  assert.equal(resourceFieldDetails(gamesDocumentation, 'thumbnail'), undefined)
  assert.match(resourceFieldDetails(gamesDocumentation, 'annotations')?.input_behavior ?? '', /only engine.*preserves/i)
  assert.match(resourceFieldDetails(gamesDocumentation, 'suggested_categories')?.details ?? '', /category names/i)
  assert.match(resourceFieldDetails(gamesDocumentation, 'suggested_categories')?.interpretation ?? '', /Numeric IDs are only for Playtest and Player Fit/i)
  const suggestedCategory = commandSpec(['games', 'update'])?.options?.find(option => option.name === '--suggested-category')
  assert.match(suggestedCategory?.description ?? '', /category name/i)
  assert.doesNotMatch(suggestedCategory?.description ?? '', /Suggested numeric/i)

  assert.match(resourceFieldDetails(gameEventsDocumentation, 'category')?.details ?? '', /Frontend Category.*backend.*category/i)
  assert.match(resourceFieldDetails(gameEventsDocumentation, 'action')?.interpretation ?? '', /Frontend term: What.*field action/i)
  assert.match(resourceFieldDetails(gameEventsDocumentation, 'label')?.interpretation ?? '', /Frontend term: Action.*field label/i)
  const gameEventCreate = commandSpec(['game-events', 'create'])
  assert.match(gameEventCreate?.behavior?.join(' ') ?? '', /frontend Category.*What.*Action.*backend fields category.*action.*label/i)
  assert.match(gameEventCreate?.options?.find(option => option.name === '--action')?.description ?? '', /Frontend What.*backend field action/i)
  assert.match(gameEventCreate?.options?.find(option => option.name === '--label')?.description ?? '', /Frontend Action.*backend field label/i)
  const funnelCreate = commandSpec(['game-event-funnels', 'create'])
  assert.match(funnelCreate?.options?.find(option => option.name === '--event')?.description ?? '', /Category\^What\^Action.*category\^action\^label/)

  assert.equal(resourceFieldDetails(playtestsDocumentation, 'tags')?.mutability, 'editable')
  assert.equal(resourceFieldDetails(playtestsDocumentation, 'skipped_assessment')?.mutability, 'editable')
  for (const field of ['video_url', 'metadata_json_url']) {
    const details = resourceFieldDetails(playtestsDocumentation, field)
    assert.match(details?.details ?? '', /included by both list and get/i)
    assert.match(details?.interpretation ?? '', /list and get.*--raw.*attributes/i)
  }
  for (const path of [['playtest-recordings', 'list'], ['playtest-recordings', 'get']]) {
    const behavior = commandSpec(path)?.behavior?.join(' ') ?? ''
    assert.match(behavior, /video_url.*metadata_json_url.*--raw.*attributes/i, path.join(' '))
  }

  assert.equal(resourceFieldDetails(reviewsDocumentation, 'version_id'), undefined)
  assert.equal(resourceFieldDetails(reviewsDocumentation, 'version')?.relationship, true)
  assert.equal(resourceFieldDetails(reviewsDocumentation, 'created_by')?.relationship, true)
  assert.equal(resourceFieldDetails(reviewsDocumentation, 'queue_time')?.encoding, 'unix_seconds')
  assert.match(resourceFieldDetails(reviewsDocumentation, 'changelog_notes')?.details ?? '', /status.*changes.*summary.*confidence/i)

  assert.deepEqual(versionActivationsDocumentation.fields.map(field => field.name), ['type', 'id', 'game_id', 'version_id', 'activated_at', 'deactivated_at', 'activated_by'])
  assert.equal(resourceFieldDetails(versionActivationsDocumentation, 'activated_at')?.encoding, 'unix_seconds')
  assert.match(resourceFieldDetails(versionActivationsDocumentation, 'activated_at')?.interpretation ?? '', /point events.*not interval boundaries.*split allocations.*do not prove continuous/i)
  assert.equal(resourceFieldDetails(versionActivationsDocumentation, 'deactivated_at')?.encoding, 'unix_seconds')
  assert.equal(resourceFieldDetails(versionActivationsDocumentation, 'deactivated_at')?.nullable, true)
  assert.match(resourceFieldDetails(versionActivationsDocumentation, 'deactivated_at')?.interpretation ?? '', /next stored activation.*null means no later stored event.*not a stored or observed deactivation.*continuous version state/i)
  assert.equal(resourceFieldDetails(versionActivationsDocumentation, 'activated_by')?.nullable, true)
  assert.match(resourceFieldDetails(versionActivationsDocumentation, 'activated_by')?.interpretation ?? '', /Null means.*no actor/i)

  const activationList = commandSpec(['version-activations', 'list'])
  assert.deepEqual(activationList?.permission_codes, ['can_read_owned_games'])
  assert.deepEqual(activationList?.network, { method: 'GET', path: '/games/:gameID/version-activations', contacts_api: true })
  assert.match(activationList?.behavior?.join(' ') ?? '', /every stored activation event.*repeated activations.*deactivated_at.*next stored activation event.*null when no later stored event exists.*not a stored or observed deactivation.*activated_by is null.*point event.*sole public track.*split allocations.*do not define continuous effective intervals.*does not prove current state.*versions\.activated_at/i)

  for (const field of ['team_id', 'created_by_id', 'created_at', 'game', 'team', 'created_by']) {
    assert.notEqual(resourceFieldDetails(gameEventFunnelsDocumentation, field), undefined, `game-event-funnels.${field}`)
  }
  for (const field of ['created_by_id', 'response', 'model', 'updated_at', 'game', 'team', 'created_by']) {
    assert.notEqual(resourceFieldDetails(playerFeedbackQuestionsDocumentation, field), undefined, `player-feedback-questions.${field}`)
  }
  for (const field of ['code', 'peer_count', 'ghosts', 'max_players', 'public', 'has_password', 'custom_data']) {
    assert.notEqual(resourceFieldDetails(netlibLobbiesDocumentation, field), undefined, `netlib-lobbies.${field}`)
  }

  for (const field of ['self_service_stage', 'internal_notes', 'external_prefix', 'rejection_reason', 'disable_automated_emails']) {
    assert.equal(resourceFieldDetails(gamesDocumentation, field), undefined, `games.${field}`)
  }
})

// These value sets are facts sourced from the server implementation (verified
// August 2026), not restated CLI constants: agents poll and branch on them, so
// an accidental doc edit must not change them silently.
void test('server-sourced lifecycle enums stay pinned', () => {
  const pins: Array<[typeof resourceDocumentations[number], string, string[]]> = [
    [reviewsDocumentation, 'status', ['pending', 'approved', 'rejected', 'closed']],
    [gameChangeRequestsDocumentation, 'status', ['pending', 'approved', 'rejected', 'cancelled']],
    [versionsDocumentation, 'state', ['created', 'accepting', 'validating', 'uploading', 'processing', 'optimizing', 'done', 'error']],
    [versionsDocumentation, 'cached_latest_review_status', ['pending', 'approved', 'rejected', 'closed']],
    [playerFitTestsDocumentation, 'status', ['running', 'completed', 'timed_out', 'stopped']]
  ]
  for (const [documentation, field, values] of pins) {
    assert.deepEqual(resourceFieldDetails(documentation, field)?.enum_values, values, `${documentation.command}.${field}`)
  }
})
