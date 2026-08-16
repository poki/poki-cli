import assert from 'node:assert/strict'
import test from 'node:test'

import {
  developerFieldsForKind,
  developerResourceField,
  isKnownDeveloperResourceType
} from '../src/developer-surface'
import { resourceDocumentationRegistry } from '../src/docs/resources'
import { CliError } from '../src/errors'
import {
  jsonApiDocument,
  jsonApiPrimaryResourceIdentity,
  normalizeJsonApi,
  normalizeJsonApiCollection,
  normalizeJsonApiResource
} from '../src/jsonapi'

void test('JSON:API responses become plain objects with unresolved relationships retained', () => {
  const normalized = normalizeJsonApi({
    data: {
      type: 'games',
      id: 'game-1',
      attributes: { title: 'Example', google_drive_folder_id: 'admin-folder', unknown_field: null },
      relationships: {
        team: {
          data: {
            type: 'teams',
            id: 'team-1',
            attributes: { name: 'Embedded linkage must not expand', secret: 'linkage-secret' }
          }
        },
        versions: { data: [{ type: 'game_versions', id: 'version-1' }] }
      }
    },
    included: [{
      type: 'game_versions',
      id: 'version-1',
      attributes: { label: 'v1' }
    }],
    meta: { total: 1 }
  })

  assert.deepEqual(normalized, {
    data: {
      type: 'games',
      id: 'game-1',
      title: 'Example',
      team: { type: 'teams', id: 'team-1' },
      versions: [{ type: 'game_versions', id: 'version-1', label: 'v1' }]
    },
    meta: { total: 1 }
  })
})

void test('resource identity comes only from JSON:API linkage and cannot be overwritten by attributes', () => {
  const body = {
    data: {
      type: 'teams',
      id: 'actual-team',
      attributes: {
        type: 'games',
        id: 'spoofed-game',
        name: 'Internal team'
      }
    }
  }

  assert.deepEqual(jsonApiPrimaryResourceIdentity(body), {
    type: 'teams',
    id: 'actual-team'
  })
  assert.deepEqual(normalizeJsonApiResource(body).data, {
    type: 'teams',
    id: 'actual-team'
  })
})

void test('known resources with malformed field provenance or containers collapse to their identity', () => {
  const malformedResources = [
    {
      type: 'games',
      id: 'game-1',
      attributes: { title: 'Example' },
      relationships: {
        title: {
          data: { type: 'internal_admin_records', id: 'secret-record' }
        }
      }
    },
    {
      type: 'games',
      id: 'game-1',
      attributes: {
        title: 'Example',
        versions: [{ type: 'game_versions', id: 'version-1', label: 'wrong-provenance-secret' }]
      }
    },
    {
      type: 'games',
      id: 'game-1',
      attributes: 'malformed-attributes-secret',
      relationships: { versions: { data: [{ type: 'game_versions', id: 'version-1' }] } }
    },
    {
      type: 'games',
      id: 'game-1',
      attributes: { title: 'Example' },
      relationships: ['malformed-relationships-secret']
    }
  ]

  for (const data of malformedResources) {
    const normalized = normalizeJsonApiResource({ data })
    assert.deepEqual(normalized.data, { type: 'games', id: 'game-1' })
    assert.doesNotMatch(JSON.stringify(normalized), /secret|internal_admin_records|version-1|Example/)
  }

  const collidingIncluded = normalizeJsonApiResource({
    data: {
      type: 'games',
      id: 'game-1',
      relationships: {
        title: { data: { type: 'internal_admin_records', id: 'admin-1' } }
      }
    },
    included: [{
      type: 'internal_admin_records',
      id: 'admin-1',
      attributes: { secret: 'included-admin-secret' }
    }]
  })
  assert.deepEqual(collidingIncluded.data, { type: 'games', id: 'game-1' })
  assert.doesNotMatch(JSON.stringify(collidingIncluded), /included-admin-secret|internal_admin_records/)
})

void test('one unreadable field value is dropped without erasing the rest of the resource', () => {
  const scenarios: Array<{ field: string, attributes?: Record<string, unknown>, relationships?: Record<string, unknown> }> = [
    { field: 'title', attributes: { title: { secret: 'attribute-secret' } } },
    { field: 'annotations', attributes: { annotations: { engine: { secret: 'nested-secret' } } } },
    { field: 'versions', relationships: { versions: { data: [{ type: 'game_versions', id: 'version-1' }, 42] } } },
    { field: 'team', relationships: { team: { data: { type: 'internal_team_record', id: 'internal-1' } } } }
  ]

  for (const scenario of scenarios) {
    const normalized = normalizeJsonApiResource({
      data: {
        type: 'games',
        id: 'game-1',
        attributes: { team_id: 'team-1', ...scenario.attributes },
        ...(scenario.relationships === undefined ? {} : { relationships: scenario.relationships })
      },
      included: [{ type: 'internal_team_record', id: 'internal-1', attributes: { secret: 'included-secret' } }]
    })

    assert.deepEqual(normalized.data, { type: 'games', id: 'game-1', team_id: 'team-1' }, scenario.field)
    assert.deepEqual(normalized.meta.unreadable_fields, [{
      type: 'games',
      id: 'game-1',
      fields: [scenario.field]
    }], scenario.field)
    assert.doesNotMatch(JSON.stringify(normalized), /secret|internal_team_record|version-1/, scenario.field)
  }
})

void test('unreadable fields of expanded resources are reported next to the readable data', () => {
  const normalized = normalizeJsonApi({
    data: {
      type: 'games',
      id: 'game-1',
      attributes: {
        title: 'Example',
        team_id: 'team-1',
        annotations: { engine: 5 },
        tracks: [{ track: 'public', version_id: 'version-1', weight: 100 }]
      },
      relationships: {
        versions: { data: [{ type: 'game_versions', id: 'version-1' }] },
        playtest_requests: { data: [{ type: 'playtest_requests', id: 'request-1' }] }
      }
    },
    included: [
      { type: 'game_versions', id: 'version-1', attributes: { state: 'done' } },
      {
        type: 'playtest_requests',
        id: 'request-1',
        attributes: { version_id: 'version-1', recordings: 'malformed-recordings-secret' }
      }
    ],
    meta: { total: 1 }
  })

  assert.deepEqual(normalized.data, {
    type: 'games',
    id: 'game-1',
    title: 'Example',
    team_id: 'team-1',
    tracks: [{ track: 'public', version_id: 'version-1', weight: 100 }],
    versions: [{ type: 'game_versions', id: 'version-1', state: 'done' }],
    playtest_requests: [{ type: 'playtest_requests', id: 'request-1', version_id: 'version-1' }]
  })
  assert.deepEqual(normalized.meta, {
    total: 1,
    unreadable_fields: [
      { type: 'games', id: 'game-1', fields: ['annotations'] },
      { type: 'playtest_requests', id: 'request-1', fields: ['recordings'] }
    ]
  })
  assert.doesNotMatch(JSON.stringify(normalized), /malformed-recordings-secret/)
})

void test('known resources need a non-empty string ID before attributes or relationships are exposed', () => {
  for (const resource of [
    { type: 'games', attributes: { title: 'missing-id-secret' } },
    { type: 'games', id: '', attributes: { title: 'empty-id-secret' } },
    { type: 'games', id: '   ', attributes: { title: 'whitespace-id-secret' } }
  ]) {
    const normalized = normalizeJsonApiResource({ data: resource })
    assert.deepEqual(normalized.data, {
      type: 'games',
      ...(Object.prototype.hasOwnProperty.call(resource, 'id') ? { id: resource.id } : {})
    })
    assert.doesNotMatch(JSON.stringify(normalized), /id-secret/)
  }
})

void test('normalized JSON:API output exposes only reviewed backend document metadata', () => {
  const failed = [{ filename: 'invalid.png', error: 'unable to read image dimensions' }]
  const normalized = normalizeJsonApi({
    data: { type: 'users', id: 'user-1', attributes: { name: 'Developer' } },
    meta: {
      total: 1,
      failed,
      permissions: ['can_read_self', 'can_read_all_games', 'can_request_web_fit_test'],
      impersonator: { id: 'admin-1' },
      new: true,
      has_custom_csp: true,
      future_internal_key: { secret: true }
    }
  })

  assert.deepEqual(normalized.meta, {
    total: 1,
    failed,
    permissions: ['can_read_self']
  })
})

void test('an explicit JSON:API null primary data member remains null', () => {
  assert.deepEqual(normalizeJsonApi({
    data: null,
    meta: { total: 0 }
  }), {
    data: null,
    meta: { total: 0 }
  })
})

void test('JSON:API normalization validates document shape and expected primary-data cardinality without echoing payloads', () => {
  const malformedDocuments = [
    {},
    { data: 42 },
    { errors: [{ detail: 'private-token-must-not-escape' }] }
  ]
  for (const body of malformedDocuments) {
    assert.throws(() => normalizeJsonApiResource(body), (error: unknown) => {
      assert.ok(error instanceof CliError)
      assert.equal(error.code, 'INVALID_API_RESPONSE')
      assert.doesNotMatch(JSON.stringify(error), /private-token-must-not-escape/)
      return true
    })
  }

  assert.throws(() => normalizeJsonApiCollection({
    data: { type: 'games', id: 'game-1', attributes: { secret: 'collection-secret' } }
  }), (error: unknown) => {
    assert.ok(error instanceof CliError)
    assert.equal((error.details as { received: { primary_data_kind: string } }).received.primary_data_kind, 'object')
    assert.doesNotMatch(JSON.stringify(error), /collection-secret/)
    return true
  })

  assert.throws(() => normalizeJsonApiResource({
    data: [{ type: 'games', id: 'game-1', attributes: { secret: 'singular-secret' } }]
  }), (error: unknown) => {
    assert.ok(error instanceof CliError)
    assert.equal((error.details as { received: { primary_data_kind: string } }).received.primary_data_kind, 'array')
    assert.doesNotMatch(JSON.stringify(error), /singular-secret/)
    return true
  })

  assert.deepEqual(normalizeJsonApiResource(null), { data: null, meta: {} })
  assert.deepEqual(normalizeJsonApiResource({ data: null }), { data: null, meta: {} })
  assert.deepEqual(normalizeJsonApiCollection({ data: [] }), { data: [], meta: {} })
})

void test('mutation documents keep attributes and relationships explicit', () => {
  assert.deepEqual(jsonApiDocument('games', { title: 'Example' }, undefined, {
    team: { type: 'teams', id: 'team-1' }
  }), {
    data: {
      type: 'games',
      attributes: { title: 'Example' },
      relationships: { team: { data: { type: 'teams', id: 'team-1' } } }
    }
  })
})

void test('included back-references become resource identifiers instead of circular objects', () => {
  const normalized = normalizeJsonApi({
    data: {
      type: 'games',
      id: 'game-1',
      relationships: {
        versions: { data: [{ type: 'game_versions', id: 'version-1' }] }
      }
    },
    included: [{
      type: 'game_versions',
      id: 'version-1',
      relationships: {
        game: { data: { type: 'games', id: 'game-1' } }
      }
    }]
  })

  assert.deepEqual(normalized.data, {
    type: 'games',
    id: 'game-1',
    versions: [{
      type: 'game_versions',
      id: 'version-1',
      game: { type: 'games', id: 'game-1' }
    }]
  })
  assert.doesNotThrow(() => JSON.stringify(normalized))
})

void test('typed relationship targets reject crafted mismatched types before included lookup', () => {
  const normalized = normalizeJsonApi({
    data: {
      type: 'games',
      id: 'game-1',
      relationships: {
        versions: {
          data: [{ type: 'game_versions\u0000crafted', id: 'version-1' }]
        }
      }
    },
    included: [{
      type: 'game_versions',
      id: 'crafted\u0000version-1',
      attributes: { label: 'must-not-be-linked' }
    }]
  })

  assert.deepEqual(normalized.data, {
    type: 'games',
    id: 'game-1'
  })
  assert.doesNotMatch(JSON.stringify(normalized), /must-not-be-linked/)
})

// Each of these resources carries no readable field besides its identity, so
// dropping the unreadable relationship leaves the identity alone.
void test('wrong-type relationship linkage is dropped instead of expanding an unreviewed resource', () => {
  const normalized = normalizeJsonApi({
    data: {
      type: 'games',
      id: 'game-1',
      relationships: {
        team: { data: { type: 'internal_team_record', id: 'internal-1' } }
      }
    },
    included: [{
      type: 'internal_team_record',
      id: 'internal-1',
      attributes: { secret: 'must not escape', admin_only: true }
    }]
  })

  assert.deepEqual(normalized.data, {
    type: 'games',
    id: 'game-1'
  })
  assert.doesNotMatch(JSON.stringify(normalized), /internal_team_record|must not escape/)

  const malformed = normalizeJsonApi({
    data: {
      type: 'games',
      id: 'game-1',
      relationships: {
        team: { data: { type: 'internal_team_record', attributes: { secret: 'must not escape' } } }
      }
    }
  })
  assert.deepEqual(malformed.data, {
    type: 'games',
    id: 'game-1'
  })

  const wrongCollectionMember = normalizeJsonApi({
    data: {
      type: 'games',
      id: 'game-1',
      relationships: {
        versions: { data: [{ type: 'game_versions', id: 'version-1' }, { type: 'teams', id: 'team-1' }] }
      }
    },
    included: [{
      type: 'teams',
      id: 'team-1',
      attributes: { name: 'must not expand' }
    }]
  })
  assert.deepEqual(wrongCollectionMember.data, { type: 'games', id: 'game-1' })
  assert.doesNotMatch(JSON.stringify(wrongCollectionMember), /must not expand|version-1|team-1/)
})

// Linkage without a usable ID is an unreadable relationship value, so the
// relationship is dropped and reported. It is not evidence about the sibling
// attributes, which stay readable.
void test('relationship linkage needs a non-empty string ID before the relationship is exposed', () => {
  for (const id of [undefined, null, '', '   ']) {
    const normalized = normalizeJsonApi({
      data: {
        type: 'games',
        id: 'game-1',
        attributes: { title: 'Example' },
        relationships: {
          team: { data: { type: 'teams', ...(id === undefined ? {} : { id }) } }
        }
      },
      included: [{ type: 'teams', id: '   ', attributes: { name: 'must not escape' } }]
    })

    assert.deepEqual(normalized.data, { type: 'games', id: 'game-1', title: 'Example' })
    assert.deepEqual(normalized.meta.unreadable_fields, [{ type: 'games', id: 'game-1', fields: ['team'] }])
    assert.doesNotMatch(JSON.stringify(normalized), /must not escape/)
  }
})

void test('structured resource fields use nested allowlists while arbitrary JSON stays opaque', () => {
  const game = normalizeJsonApi({
    data: {
      type: 'games',
      id: 'game-1',
      attributes: {
        annotations: { engine: 'phaser', internal_annotation: 'private' },
        tracks: [{
          track: 'public',
          version_id: 'version-1',
          weight: 100,
          internal_allocation_id: 'private'
        }],
        content_metadata: {
          content_game_id: 123,
          rating: { up_count: 4, down_count: 1, rating: 0.8, internal_sample: 5 },
          internal_distribution_rule: 'private'
        }
      }
    }
  })
  assert.deepEqual(game.data, {
    type: 'games',
    id: 'game-1',
    annotations: { engine: 'phaser' },
    tracks: [{ track: 'public', version_id: 'version-1', weight: 100 }],
    content_metadata: {
      content_game_id: 123,
      rating: { up_count: 4, down_count: 1, rating: 0.8 }
    }
  })

  const customData = {
    type: 'games',
    id: 'game-defined-id',
    relationshipNames: ['game-defined-key'],
    mode: 'ranked',
    nested: {
      type: 'games',
      id: 'game-defined-id',
      score: 42,
      relationshipNames: ['another-game-defined-key']
    }
  }
  const lobby = normalizeJsonApi({
    data: {
      type: 'lobbies',
      id: 'game-1:ROOM',
      attributes: { code: 'ROOM', custom_data: customData }
    }
  })
  assert.deepEqual(lobby.data, {
    type: 'lobbies',
    id: 'game-1:ROOM',
    code: 'ROOM',
    custom_data: customData
  })

  const reasons = {
    type: 'connect-src',
    id: 'https://example.com',
    'https://example.com': 'Required for multiplayer matchmaking.'
  }
  const changeRequest = normalizeJsonApi({
    data: {
      type: 'game_change_requests',
      id: 'request-1',
      attributes: { custom_content_security_policy_reasons: reasons }
    }
  })
  assert.deepEqual(changeRequest.data, {
    type: 'game_change_requests',
    id: 'request-1',
    custom_content_security_policy_reasons: reasons
  })

  const inspectorChecklist = {
    type: 'backend-check-name',
    id: 'game-controlled-value',
    loading: { passed: true, notes: ['Fast enough'] }
  }
  const version = normalizeJsonApi({
    data: {
      type: 'game_versions',
      id: 'version-1',
      attributes: { inspector_checklist: inspectorChecklist }
    }
  })
  assert.deepEqual(version.data, {
    type: 'game_versions',
    id: 'version-1',
    inspector_checklist: inspectorChecklist
  })
})

void test('review changelog notes use reviewed nested allowlists', () => {
  const review = normalizeJsonApi({
    data: {
      type: 'reviews',
      id: 'review-1',
      attributes: {
        changelog_notes: {
          status: 'generated',
          model: 'gemini-2.5-pro',
          generated_at: '2026-08-13T10:00:00Z',
          changes: [{
            summary: 'Improved loading performance.',
            confidence: 'high',
            internal_prompt_fragment: 'private'
          }],
          internal_storage_key: 'private'
        }
      }
    }
  })

  assert.deepEqual(review.data, {
    type: 'reviews',
    id: 'review-1',
    changelog_notes: {
      status: 'generated',
      model: 'gemini-2.5-pro',
      generated_at: '2026-08-13T10:00:00Z',
      changes: [{
        summary: 'Improved loading performance.',
        confidence: 'high'
      }]
    }
  })
})

// The developer surface answers "is this type known", "does this field exist",
// and "what may it contain" for the same resource. While those answers came
// from parallel tables one of them could disagree with the others, and a field
// that no lookup admits to owning is exactly how unreviewed backend data
// reaches normalized output. This walks every known type and field instead.
void test('every known resource type resolves its complete documented field list and nothing else', () => {
  const undocumentedTypes = ['users', 'teams', 'game_version_files']
  const foreignFields = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf', 'google_drive_folder_id', 'not_a_field', '']

  for (const { apiType, documentation } of resourceDocumentationRegistry) {
    assert.equal(isKnownDeveloperResourceType(apiType), true, apiType)
    for (const field of documentation.fields) {
      const definition = developerResourceField(apiType, field.name)
      assert.notEqual(definition, undefined, `${apiType}.${field.name}`)
      assert.equal(definition?.type, field.type, `${apiType}.${field.name}`)
      assert.deepEqual(definition?.relationshipApiTypes, field.relationshipApiTypes ?? [], `${apiType}.${field.name}`)
      assert.equal(
        definition?.source,
        field.name === 'type' || field.name === 'id' ? 'identity' : (field.relationshipApiTypes ?? []).length > 0 ? 'relationship' : 'attribute',
        `${apiType}.${field.name}`
      )
    }
    const documented = documentation.fields.map(field => field.name)
    for (const field of foreignFields) {
      if (documented.includes(field)) continue
      assert.equal(developerResourceField(apiType, field), undefined, `${apiType}.${field}`)
    }
  }

  for (const type of undocumentedTypes) {
    assert.equal(isKnownDeveloperResourceType(type), true, type)
    for (const field of ['type', 'id']) {
      assert.equal(developerResourceField(type, field)?.source, 'identity', `${type}.${field}`)
    }
    for (const field of foreignFields) {
      assert.equal(developerResourceField(type, field), undefined, `${type}.${field}`)
    }
  }

  // The one identity relationship, and the version-file kind whose field list
  // has no documentation entry to derive itself from.
  assert.deepEqual(developerResourceField('users', 'team'), {
    source: 'relationship',
    type: 'team relationship|null',
    collection: false,
    nullable: true,
    relationshipApiTypes: ['teams']
  })
  for (const field of developerFieldsForKind('version-files')) {
    assert.notEqual(developerResourceField('game_version_files', field), undefined, field)
  }

  for (const type of ['unknown_type', 'admin_audits', 'game_version_file', '__proto__', 'toString', '']) {
    assert.equal(isKnownDeveloperResourceType(type), false, type)
    assert.equal(developerResourceField(type, 'id'), undefined, type)
  }
})
