import assert from 'node:assert/strict'
import test from 'node:test'

import { gameReadiness } from '../src/readiness'
import { apiHarness, jsonApi, runCli } from './helpers'

void test('game readiness follows the developer-owned track-editor permission branch without review eligibility', () => {
  const game = {
    id: 'game-1',
    team_id: 'team-1',
    tracks: [{ track: 'public', version_id: 'old', weight: 100 }],
    versions: [{ id: 'version-1', state: 'done', cached_latest_review_status: 'rejected' }]
  }
  const user = { id: 'user-1', team_id: 'team-1' }
  const readiness = gameReadiness(game, user, ['can_edit_owned_game_tracks']) as { operations: { versions_activate: { status: string, ready: boolean | null, candidate_version_ids: string[], blockers: unknown[] } } }
  assert.equal(readiness.operations.versions_activate.status, 'ready')
  assert.equal(readiness.operations.versions_activate.ready, true)
  assert.deepEqual(readiness.operations.versions_activate.candidate_version_ids, ['version-1'])
  assert.deepEqual(readiness.operations.versions_activate.blockers, [])

  const otherTeam = { id: 'user-2', team_id: 'team-2' }
  const outsideDeveloperBoundary = gameReadiness(game, otherTeam, ['can_edit_all_games', 'can_edit_all_game_tracks']) as typeof readiness
  assert.equal(outsideDeveloperBoundary.operations.versions_activate.status, 'blocked')
  assert.equal(outsideDeveloperBoundary.operations.versions_activate.ready, false)

  const approvedOnly = gameReadiness(game, user, ['can_activate_approved_versions']) as { operations: { versions_activate: { status: string, ready: boolean | null, candidate_version_ids: string[], possible_candidate_version_ids: string[], backend_checks: string[] } } }
  assert.equal(approvedOnly.operations.versions_activate.status, 'backend_check_required')
  assert.equal(approvedOnly.operations.versions_activate.ready, null)
  assert.deepEqual(approvedOnly.operations.versions_activate.candidate_version_ids, [])
  assert.deepEqual(approvedOnly.operations.versions_activate.possible_candidate_version_ids, ['version-1'])
  assert.ok(approvedOnly.operations.versions_activate.backend_checks.length > 0)
})

const readinessUser = {
  data: { type: 'users', id: 'user-1', attributes: { team_id: 'team-1' } },
  meta: {
    permissions: [
      'can_read_self',
      'can_edit_owned_game_tracks',
      'can_edit_owned_playtests',
      'can_edit_owned_player_fit_tests'
    ]
  }
}

void test('games readiness still reports observed state when an unrelated game attribute is unreadable', async t => {
  const { env } = await apiHarness(t, (req, res) => {
    if (req.method === 'GET' && req.url === '/games/game-1') {
      jsonApi(res, {
        data: {
          type: 'games',
          id: 'game-1',
          attributes: {
            title: 'Example',
            team_id: 'team-1',
            // The CLI requires annotations.engine to be a string, so this one
            // value is unreadable. Dropping the rest of the game with it would
            // report ownership, versions, and requests that do exist as absent.
            annotations: { engine: 5 },
            tracks: [{ track: 'public', version_id: 'version-1', weight: 100 }]
          },
          relationships: {
            versions: {
              data: [
                { type: 'game_versions', id: 'version-1' },
                { type: 'game_versions', id: 'version-2' }
              ]
            },
            playtest_requests: { data: [{ type: 'playtest_requests', id: 'request-1' }] }
          }
        },
        included: [
          { type: 'game_versions', id: 'version-1', attributes: { state: 'done', cached_latest_review_status: 'approved' } },
          { type: 'game_versions', id: 'version-2', attributes: { state: 'processing' } },
          { type: 'playtest_requests', id: 'request-1', attributes: { version_id: 'version-1' } }
        ]
      })
      return
    }
    if (req.method === 'GET' && req.url === '/users/@me') {
      jsonApi(res, readinessUser)
      return
    }
    res.writeHead(404)
    res.end()
  }, 'readiness-degraded')

  const result = await runCli(['games', 'readiness', 'game-1', '--format', 'json'], { env })
  assert.equal(result.code, 0, result.stderr)
  const document = JSON.parse(result.stdout)
  assert.equal(document.data.game.owned_by_current_account, true)
  assert.equal(document.data.game.version_count, 2)
  assert.equal(document.data.game.track_count, 1)

  const activation = document.data.operations.versions_activate
  assert.equal(activation.status, 'ready')
  assert.equal(activation.ready, true)
  assert.deepEqual(activation.candidate_version_ids, ['version-1'])

  const playtest = document.data.operations.playtest_requests_create
  assert.equal(playtest.status, 'backend_check_required')
  assert.equal(playtest.ready, null)
  assert.deepEqual(playtest.candidate_version_ids, ['version-2'])
  assert.deepEqual(playtest.visible_active_request_version_ids, ['version-1'])
})

void test('games readiness fails closed instead of reporting unreadable fields as blocking conditions', async t => {
  const scenarios = [
    {
      name: 'unreadable versions relationship',
      game: {
        data: {
          type: 'games',
          id: 'game-1',
          attributes: { team_id: 'team-1' },
          relationships: { versions: { data: [{ type: 'teams', id: 'unreadable-version-secret' }] } }
        }
      },
      user: readinessUser,
      field: 'games.versions'
    },
    {
      name: 'unreadable tracks attribute',
      game: {
        data: {
          type: 'games',
          id: 'game-1',
          attributes: {
            team_id: 'team-1',
            tracks: [{ track: 'public', version_id: 'version-1', weight: 'unreadable-weight-secret' }]
          }
        }
      },
      user: readinessUser,
      field: 'games.tracks'
    },
    {
      name: 'unreadable expanded version state',
      game: {
        data: {
          type: 'games',
          id: 'game-1',
          attributes: { team_id: 'team-1' },
          relationships: { versions: { data: [{ type: 'game_versions', id: 'version-1' }] } }
        },
        included: [{ type: 'game_versions', id: 'version-1', attributes: { state: { value: 'unreadable-state-secret' }, progress: 100 } }]
      },
      user: readinessUser,
      field: 'game_versions.state'
    },
    {
      name: 'malformed attributes container',
      game: { data: { type: 'games', id: 'game-1', attributes: 'unreadable-attributes-secret' } },
      user: readinessUser,
      field: 'games.team_id'
    },
    {
      name: 'unreadable current-user team',
      game: { data: { type: 'games', id: 'game-1', attributes: { team_id: 'team-1' } } },
      user: {
        data: { type: 'users', id: 'user-1', attributes: { team_id: ['unreadable-team-secret'] } },
        meta: readinessUser.meta
      },
      field: 'users.team_id'
    }
  ]

  for (const scenario of scenarios) {
    await t.test(scenario.name, async t => {
      const { env } = await apiHarness(t, (req, res) => {
        jsonApi(res, req.url === '/users/@me' ? scenario.user : scenario.game)
      }, 'readiness-unreadable')

      const result = await runCli(['games', 'readiness', 'game-1', '--format', 'json'], { env })
      assert.equal(result.code, 5, result.stdout)
      assert.equal(result.stdout, '')
      const error = JSON.parse(result.stderr).error
      assert.equal(error.code, 'INVALID_API_RESPONSE')
      assert.ok((error.details.unreadable_fields as string[]).includes(scenario.field), JSON.stringify(error.details))
      assert.doesNotMatch(result.stderr, /-secret/)
    })
  }
})

void test('games readiness reports only visible backend mutation conditions and candidates', async t => {
  const requests: string[] = []
  const { env } = await apiHarness(t, (req, res) => {
    requests.push(`${req.method ?? ''} ${req.url ?? ''}`)
    if (req.method === 'GET' && req.url === '/games/game-1') {
      jsonApi(res, {
        data: {
          type: 'games',
          id: 'game-1',
          attributes: {
            title: 'Example',
            team_id: 'team-1',
            uploader_id: 'user-1',
            tracks: [
              { track: 'weighted', version_id: 'version-3', weight: 100 },
              { track: 'public', version_id: 'version-1', weight: 100 }
            ]
          },
          relationships: {
            versions: {
              data: [
                { type: 'game_versions', id: 'version-1' },
                { type: 'game_versions', id: 'version-2' },
                { type: 'game_versions', id: 'version-3' }
              ]
            },
            playtest_requests: { data: [{ type: 'playtest_requests', id: 'request-1' }] }
          }
        },
        included: [
          { type: 'game_versions', id: 'version-1', attributes: { state: 'done', cached_latest_review_status: 'approved' } },
          { type: 'game_versions', id: 'version-2', attributes: { state: 'processing', cached_latest_review_status: null } },
          { type: 'game_versions', id: 'version-3', attributes: { state: 'done', cached_latest_review_status: 'rejected' } },
          { type: 'playtest_requests', id: 'request-1', attributes: { version_id: 'version-1', pending: 2 } }
        ]
      })
      return
    }
    if (req.method === 'GET' && req.url === '/users/@me') {
      jsonApi(res, {
        data: { type: 'users', id: 'user-1', attributes: { team_id: 'team-1' } },
        meta: {
          permissions: [
            'can_read_self',
            'can_read_owned_games',
            'can_activate_approved_versions',
            'can_edit_owned_playtests',
            'can_edit_owned_player_fit_tests'
          ]
        }
      })
      return
    }
    res.writeHead(404)
    res.end()
  }, 'readiness')

  const result = await runCli(['games', 'readiness', 'game-1', '--format', 'json'], { env })
  assert.equal(result.code, 0, result.stderr)
  assert.deepEqual(requests, ['GET /games/game-1', 'GET /users/@me'])
  const document = JSON.parse(result.stdout)
  assert.equal(document.data.type, 'game_readiness')
  assert.equal(document.data.game.owned_by_current_account, true)

  const activation = document.data.operations.versions_activate
  assert.equal(activation.status, 'blocked')
  assert.equal(activation.ready, false)
  assert.deepEqual(activation.candidate_version_ids, ['version-1'])
  assert.ok(activation.blockers.some((blocker: { code: string }) => blocker.code === 'ACTIVE_VERSION_MULTIPLE_TRACKS'))

  const playtest = document.data.operations.playtest_requests_create
  assert.equal(playtest.status, 'backend_check_required')
  assert.equal(playtest.ready, null)
  assert.deepEqual(playtest.candidate_version_ids, ['version-2', 'version-3'])
  assert.deepEqual(playtest.visible_active_request_version_ids, ['version-1'])

  const playerFit = document.data.operations.player_fit_tests_create
  assert.equal(playerFit.status, 'ready')
  assert.equal(playerFit.ready, true)
  assert.deepEqual(playerFit.candidate_version_ids, ['version-1', 'version-2', 'version-3'])

  assert.match(document.meta.excluded, /Dashboard-only eligibility/)
  assert.doesNotMatch(result.stdout, /inspector|thumbnail|credits/i)
  assert.equal(document.meta.backend_authoritative, true)
})
