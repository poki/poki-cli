import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeMutationResponse } from '../src/commands/common'
import { CliError } from '../src/errors'
import { apiHarness, jsonApi, runCli } from './helpers'

void test('read commands reject wrong JSON:API primary-data cardinality without exposing resource payloads', async t => {
  const { env } = await apiHarness(t, (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname === '/games' && url.searchParams.has('page[number]')) {
      jsonApi(res, {
        data: { type: 'games', id: 'not-a-collection', attributes: { private_token: 'collection-cardinality-secret' } }
      })
      return
    }
    jsonApi(res, {
      data: [{ type: 'games', id: 'not-a-singular-resource', attributes: { private_token: 'singular-cardinality-secret' } }]
    })
  }, 'read-cardinality')

  const collection = await runCli(['games', 'list', '--format', 'json'], { env })
  assert.equal(collection.code, 5, collection.stderr)
  assert.equal(JSON.parse(collection.stderr).error.code, 'INVALID_API_RESPONSE')
  assert.doesNotMatch(collection.stderr, /collection-cardinality-secret/)

  const singular = await runCli(['games', 'get', 'game-1', '--format', 'json'], { env })
  assert.equal(singular.code, 5, singular.stderr)
  assert.equal(JSON.parse(singular.stderr).error.code, 'INVALID_API_RESPONSE')
  assert.doesNotMatch(singular.stderr, /singular-cardinality-secret/)
})

void test('normalized singular reads bind resource identity while --raw and explicit null retain their contracts', async t => {
  const wrongIdentity = {
    data: {
      type: 'games',
      id: 'other-game',
      attributes: { title: 'Wrong game', internal_secret: 'raw-read-secret' }
    }
  }
  const { env } = await apiHarness(t, (req, res) => {
    if (req.url === '/games/empty') {
      jsonApi(res, { data: null })
      return
    }
    jsonApi(res, wrongIdentity)
  }, 'read-identity')

  const normalized = await runCli(['games', 'get', 'requested-game', '--format', 'json'], { env })
  assert.equal(normalized.code, 5, normalized.stderr)
  assert.equal(normalized.stdout, '')
  assert.equal(JSON.parse(normalized.stderr).error.code, 'INVALID_API_RESPONSE')
  assert.doesNotMatch(normalized.stderr, /other-game|raw-read-secret/)

  const raw = await runCli(['games', 'get', 'requested-game', '--raw', '--format', 'json'], { env })
  assert.equal(raw.code, 0, raw.stderr)
  assert.deepEqual(JSON.parse(raw.stdout), wrongIdentity)

  const empty = await runCli(['games', 'get', 'empty', '--format', 'json'], { env })
  assert.equal(empty.code, 0, empty.stderr)
  assert.deepEqual(JSON.parse(empty.stdout), { data: null, meta: {} })
})

void test('collection-backed singular reads require both the requested type and ID', async t => {
  const { env } = await apiHarness(t, (_req, res) => {
    jsonApi(res, {
      data: [{ type: 'teams', id: 'request-1', attributes: { name: 'Wrong resource type' } }]
    })
  }, 'collection-read-identity')

  const result = await runCli(['game-change-requests', 'get', 'request-1', '--game', 'g', '--format', 'json'], { env })
  assert.equal(result.code, 4, result.stderr)
  assert.equal(result.stdout, '')
  assert.equal(JSON.parse(result.stderr).error.code, 'NOT_FOUND')
  assert.doesNotMatch(result.stderr, /Wrong resource type/)
})

void test('mutation normalization accepts empty success but classifies malformed POST, PATCH, and DELETE responses as no-replay outcomes', () => {
  for (const method of ['POST', 'PATCH', 'DELETE'] as const) {
    assert.deepEqual(normalizeMutationResponse(null, method === 'POST' ? 201 : 204, method, '/resource', { type: 'games', id: 'g' }), {
      data: null,
      meta: {}
    })
    assert.deepEqual(normalizeMutationResponse({ data: null }, 200, method, '/resource', { type: 'games', id: 'g' }), {
      data: null,
      meta: {}
    })

    assert.throws(() => normalizeMutationResponse({
      errors: [{ detail: `${method}-mutation-secret` }],
      internal_payload: { token: 'must-not-escape' }
    }, 200, method, '/resource', { type: 'games', id: 'g' }), (error: unknown) => {
      assert.ok(error instanceof CliError)
      assert.equal(error.code, 'INVALID_API_RESPONSE')
      assert.equal(error.status, 200)
      assert.equal(error.retryable, false)
      assert.match(error.hint ?? '', /do not replay/i)
      assert.doesNotMatch(JSON.stringify(error), new RegExp(`${method}-mutation-secret|must-not-escape`))
      return true
    })
  }
})

void test('mutation normalization validates expected resource type and requires a usable ID without exposing returned values', () => {
  assert.deepEqual(normalizeMutationResponse({
    data: { type: 'games', id: 'g', attributes: { title: 'Example' } }
  }, 200, 'PATCH', '/games/g', { type: 'games', id: 'g' }).data, {
    type: 'games',
    id: 'g',
    title: 'Example'
  })
  assert.deepEqual(normalizeMutationResponse({
    data: { type: 'games', id: 'created-game', attributes: { title: 'Example' } }
  }, 201, 'POST', '/games', { type: 'games' }).data, {
    type: 'games',
    id: 'created-game',
    title: 'Example'
  })

  for (const id of [undefined, null, 42, '', '   ']) {
    assert.throws(() => normalizeMutationResponse({
      data: { type: 'games', ...(id === undefined ? {} : { id }), attributes: { title: 'create-id-secret' } }
    }, 201, 'POST', '/games', { type: 'games' }), (error: unknown) => {
      assert.ok(error instanceof CliError)
      assert.equal(error.code, 'INVALID_API_RESPONSE')
      assert.equal(error.status, 201)
      assert.equal(error.retryable, false)
      assert.match(error.hint ?? '', /do not replay/i)
      assert.doesNotMatch(JSON.stringify(error), /create-id-secret/)
      return true
    })
  }

  for (const data of [
    { type: 'teams', id: 'g', attributes: { secret: 'wrong-type-secret' } },
    { type: 'games', id: 'other', attributes: { secret: 'wrong-id-secret' } },
    { type: 'games', attributes: { secret: 'missing-id-secret' } }
  ]) {
    assert.throws(() => normalizeMutationResponse({ data }, 200, 'PATCH', '/games/g', { type: 'games', id: 'g' }), (error: unknown) => {
      assert.ok(error instanceof CliError)
      assert.equal(error.code, 'INVALID_API_RESPONSE')
      assert.equal(error.status, 200)
      assert.equal(error.retryable, false)
      assert.match(error.hint ?? '', /do not replay/i)
      assert.doesNotMatch(JSON.stringify(error), /wrong-type-secret|wrong-id-secret|missing-id-secret|teams|other/)
      return true
    })
  }
})

void test('playtest and destructive mutation paths validate successful JSON:API bodies before reporting success', async t => {
  const { env } = await apiHarness(t, (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    req.resume()
    if (req.method === 'POST' && url.pathname === '/games/g/playtest-requests') {
      jsonApi(res, { internal_payload: { secret: 'create-response-secret' } }, 201)
      return
    }
    if (req.method === 'PATCH' && url.pathname === '/games/g/playtest-recordings/R') {
      jsonApi(res, {
        data: [{ type: 'playtest_recordings', id: 'R', attributes: { secret: 'patch-response-secret' } }]
      })
      return
    }
    if (req.method === 'POST' && url.pathname === '/games/g/playtest-recordings/R/@archive') {
      jsonApi(res, { errors: [{ detail: 'archive-response-secret' }] })
      return
    }
    if (req.method === 'DELETE' && url.pathname === '/games/g/player_feedback_questions/Q') {
      jsonApi(res, { data: 42, secret: 'delete-response-secret' })
      return
    }
    res.writeHead(404)
    res.end()
  }, 'mutation-cardinality')

  const invocations = [
    {
      secret: 'create-response-secret',
      args: ['playtest-requests', 'create', '--game', 'g', '--version', 'V', '--format', 'json']
    },
    {
      secret: 'patch-response-secret',
      args: ['playtest-recordings', 'update', 'R', '--game', 'g', '--tag', 'reviewed', '--format', 'json']
    },
    {
      secret: 'archive-response-secret',
      args: ['playtest-recordings', 'archive', 'R', '--game', 'g', '--format', 'json']
    },
    {
      secret: 'delete-response-secret',
      args: ['player-feedback-questions', 'delete', 'Q', '--game', 'g', '--yes', '--format', 'json']
    }
  ]

  for (const invocation of invocations) {
    const result = await runCli(invocation.args, { env })
    assert.equal(result.code, 5, result.stderr)
    assert.equal(result.stdout, '')
    const error = JSON.parse(result.stderr).error
    assert.equal(error.code, 'INVALID_API_RESPONSE')
    assert.equal(error.retryable, false)
    assert.match(error.hint, /do not replay/i)
    assert.doesNotMatch(result.stderr, new RegExp(invocation.secret))
  }
})

void test('normalized and raw mutations reject valid-shaped responses with the wrong resource identity', async t => {
  const { env } = await apiHarness(t, (req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    req.resume()
    if (req.method === 'GET' && path === '/games/g') {
      jsonApi(res, { data: { type: 'games', id: 'g', attributes: { tracks: [] } } })
      return
    }
    if (req.method === 'POST' && path === '/games') {
      jsonApi(res, {
        data: {
          type: 'teams',
          id: 'wrong-team',
          attributes: {
            type: 'games',
            id: 'spoofed-game',
            secret: 'wrong-create-identity-secret'
          }
        }
      }, 201)
      return
    }
    if (req.method === 'PATCH' && path === '/games/g') {
      jsonApi(res, {
        data: {
          type: 'teams',
          id: 'wrong-team',
          attributes: {
            type: 'games',
            id: 'g',
            secret: 'wrong-update-identity-secret'
          }
        }
      })
      return
    }
    res.writeHead(404)
    res.end()
  }, 'mutation-identity')

  for (const raw of [false, true]) {
    const rawArgs = raw ? ['--raw'] : []
    for (const args of [
      ['games', 'create', '--title', 'Example', '--team', 'team-1', ...rawArgs, '--format', 'json'],
      ['games', 'update', 'g', '--engine', 'unity', ...rawArgs, '--format', 'json']
    ]) {
      const result = await runCli(args, { env })
      assert.equal(result.code, 5, result.stderr)
      assert.equal(result.stdout, '')
      const error = JSON.parse(result.stderr).error
      assert.equal(error.code, 'INVALID_API_RESPONSE')
      assert.equal(error.retryable, false)
      assert.match(error.hint, /do not replay/i)
      assert.doesNotMatch(result.stderr, /wrong-team|spoofed-game|wrong-create-identity-secret|wrong-update-identity-secret/)
    }

    const activation = await runCli([
      'versions', 'activate', 'V', '--game', 'g', '--yes', ...rawArgs, '--format', 'json'
    ], { env })
    assert.equal(activation.code, 5, activation.stderr)
    assert.equal(activation.stdout, '')
    const error = JSON.parse(activation.stderr).error
    assert.equal(error.code, 'VERSION_ACTIVATION_OUTCOME_UNKNOWN')
    assert.equal(error.details.activation_state, 'unknown')
    assert.equal(error.details.cause.code, 'INVALID_API_RESPONSE')
    assert.doesNotMatch(activation.stderr, /wrong-team|wrong-update-identity-secret/)
  }
})

void test('replacement cancellation failures always require current-state inspection before another mutation', async t => {
  const scenarios = ['rejected', 'wrong-identity'] as const
  for (const scenario of scenarios) {
    let posts = 0
    const { env } = await apiHarness(t, (req, res) => {
      const path = new URL(req.url ?? '/', 'http://localhost').pathname
      req.resume()
      if (req.method === 'GET' && path === '/games/g') {
        jsonApi(res, {
          data: {
            type: 'games',
            id: 'g',
            attributes: { tracks: [] },
            relationships: {
              versions: { data: [{ type: 'game_versions', id: 'V' }] },
              playtest_requests: { data: [{ type: 'playtest_requests', id: 'R' }] }
            }
          },
          included: [
            { type: 'game_versions', id: 'V', attributes: { game_id: 'g' } },
            {
              type: 'playtest_requests',
              id: 'R',
              attributes: {
                game_id: 'g',
                version_id: 'V',
                recordings: 3,
                pending: 0,
                device_category: 'any',
                categories: '',
                orientation: 'both',
                new_users_only: false,
                normal_tile: false
              }
            }
          ]
        })
        return
      }
      if (req.method === 'DELETE' && path === '/games/g/playtest-requests/R') {
        if (scenario === 'rejected') {
          jsonApi(res, { errors: [{ status: '404', title: 'Not found' }] }, 404)
        } else {
          jsonApi(res, { data: { type: 'playtest_requests', id: 'other', attributes: { secret: 'wrong-cancellation-secret' } } })
        }
        return
      }
      if (req.method === 'POST') posts++
      res.writeHead(404)
      res.end()
    }, `cancellation-state-${scenario}`)
    const result = await runCli([
      'playtest-requests', 'replace', 'R', '--game', 'g', '--recordings', '4', '--yes',
      ...(scenario === 'wrong-identity' ? ['--raw'] : []), '--format', 'json'
    ], { env })

    assert.equal(result.code, scenario === 'rejected' ? 4 : 5, result.stderr)
    assert.equal(result.stdout, '')
    assert.equal(posts, 0)
    const error = JSON.parse(result.stderr).error
    assert.equal(error.code, 'PLAYTEST_REQUEST_REPLACEMENT_CANCELLATION_FAILED')
    assert.equal(error.details.cancellation_state, 'unknown')
    assert.equal(error.details.replacement_creation_state, 'not_attempted')
    assert.equal(error.details.recovery.inspect_current_state.required_before_next_mutation, true)
    assert.equal(error.details.recovery.retry_replacement.condition, 'only_if_inspection_confirms_the_original_request_is_still_active')
    assert.equal(error.details.recovery.create_replacement.condition, 'only_if_inspection_confirms_the_original_request_is_cancelled_and_no_active_replacement_exists')
    assert.match(error.hint, /before any further mutation/i)
    assert.doesNotMatch(result.stderr, /other|wrong-cancellation-secret/)
  }
})

void test('--raw validates mutation success documents and preserves non-atomic unknown-outcome recovery', async t => {
  const secrets: string[] = []
  const malformed = (res: Parameters<typeof jsonApi>[0], secret: string): void => {
    secrets.push(secret)
    jsonApi(res, { private_secret: secret }, 200)
  }
  const game = {
    data: {
      type: 'games',
      id: 'g',
      attributes: { tracks: [{ track: 'public', version_id: 'OLD', weight: 100 }] },
      relationships: {
        versions: { data: [{ type: 'game_versions', id: 'V' }] },
        playtest_requests: { data: [{ type: 'playtest_requests', id: 'R' }] }
      }
    },
    included: [
      { type: 'game_versions', id: 'V', attributes: { game_id: 'g' } },
      {
        type: 'playtest_requests',
        id: 'R',
        attributes: {
          game_id: 'g',
          version_id: 'V',
          recordings: 3,
          pending: 0,
          device_category: 'any',
          categories: '',
          orientation: 'both',
          new_users_only: false,
          normal_tile: false
        }
      }
    ]
  }
  const { env } = await apiHarness(t, (req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    req.resume()
    if (req.method === 'GET' && path === '/games/g') return jsonApi(res, game)
    if (req.method === 'DELETE' && path === '/games/g/playtest-requests/R') {
      res.writeHead(202)
      res.end()
      return
    }
    if (req.method === 'POST' && path === '/games') return malformed(res, 'generic-raw-secret')
    if (req.method === 'POST' && path === '/games/g/versions/V/_archive') return malformed(res, 'action-raw-secret')
    if (req.method === 'POST' && path === '/games/g/playtest-requests') return malformed(res, 'replacement-raw-secret')
    if (req.method === 'PATCH' && path === '/games/g') return malformed(res, 'activation-raw-secret')
    res.writeHead(404)
    res.end()
  }, 'raw-mutation-validation')

  for (const invocation of [
    ['games', 'create', '--title', 'Example', '--team', 'team-1', '--raw', '--format', 'json'],
    ['versions', 'archive', 'V', '--game', 'g', '--raw', '--format', 'json']
  ]) {
    const result = await runCli(invocation, { env })
    assert.equal(result.code, 5, result.stderr)
    assert.equal(result.stdout, '')
    assert.equal(JSON.parse(result.stderr).error.code, 'INVALID_API_RESPONSE')
    assert.doesNotMatch(result.stderr, /raw-secret/)
  }

  const replacement = await runCli([
    'playtest-requests', 'replace', 'R', '--game', 'g', '--recordings', '4', '--yes', '--raw', '--format', 'json'
  ], { env })
  assert.equal(replacement.code, 5, replacement.stderr)
  assert.equal(replacement.stdout, '')
  const replacementError = JSON.parse(replacement.stderr).error
  assert.equal(replacementError.code, 'PLAYTEST_REQUEST_REPLACEMENT_FAILED')
  assert.equal(replacementError.details.replacement_creation_state, 'unknown')
  assert.equal(replacementError.details.cause.code, 'INVALID_API_RESPONSE')
  assert.doesNotMatch(replacement.stderr, /replacement-raw-secret/)

  const activation = await runCli([
    'versions', 'activate', 'V', '--game', 'g', '--yes', '--raw', '--format', 'json'
  ], { env })
  assert.equal(activation.code, 5, activation.stderr)
  assert.equal(activation.stdout, '')
  const activationError = JSON.parse(activation.stderr).error
  assert.equal(activationError.code, 'VERSION_ACTIVATION_OUTCOME_UNKNOWN')
  assert.equal(activationError.details.activation_state, 'unknown')
  assert.equal(activationError.details.cause.code, 'INVALID_API_RESPONSE')
  assert.doesNotMatch(activation.stderr, /activation-raw-secret/)

  for (const secret of secrets) {
    assert.doesNotMatch(replacement.stderr + activation.stderr, new RegExp(secret))
  }
})
