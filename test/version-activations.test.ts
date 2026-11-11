import assert from 'node:assert/strict'
import test from 'node:test'

import { apiHarness, jsonApi, runCli } from './helpers'

void test('version-activations exposes a filtered, paginated timeline plus raw and CSV views', async t => {
  const requests: string[] = []
  const { env } = await apiHarness(t, (req, res) => {
    assert.equal(req.method, 'GET')
    const url = new URL(req.url ?? '/', 'http://localhost')
    assert.equal(url.pathname, '/games/game-1/version-activations')
    assert.equal(url.searchParams.get('page[size]'), '1')
    assert.equal(url.searchParams.has('filter[version_id]'), false)
    assert.equal(url.searchParams.has('sort'), false)
    requests.push(`${url.pathname}?${url.searchParams.toString()}`)

    const page = Number(url.searchParams.get('page[number]') ?? 1)
    if (page === 1) {
      jsonApi(res, {
        data: [{
          type: 'game_version_activations',
          id: 'activation-1',
          attributes: {
            game_id: 'game-1',
            version_id: 'version-1',
            activated_at: 1_725_148_800,
            deactivated_at: 1_725_235_200,
            backend_only: 'hidden in normalized output'
          },
          relationships: {
            activated_by: { data: { type: 'users', id: 'user-1' } }
          }
        }],
        included: [{
          type: 'users',
          id: 'user-1',
          attributes: {
            name: 'Operator',
            email: 'operator@example.org',
            role: 'developer-support',
            backend_only: 'hidden included value'
          }
        }],
        links: { next: { href: '?page%5Bnumber%5D=2&page%5Bsize%5D=1' } },
        meta: { total: 2, impersonator: 'hidden backend meta' }
      })
      return
    }

    assert.equal(page, 2)
    jsonApi(res, {
      data: [{
        type: 'game_version_activations',
        id: 'activation-2',
        attributes: {
          game_id: 'game-1',
          version_id: 'version-1',
          activated_at: 1_725_235_200,
          deactivated_at: null
        },
        relationships: {
          activated_by: { data: null }
        }
      }],
      links: { next: null },
      meta: { total: 2 }
    })
  }, 'version-activations')

  const page = await runCli(['version-activations', 'list', '--game', 'game-1', '--page-size', '1', '--format', 'json'], { env })
  assert.equal(page.code, 0, page.stderr)
  assert.deepEqual(JSON.parse(page.stdout), {
    data: [{
      type: 'game_version_activations',
      id: 'activation-1',
      game_id: 'game-1',
      version_id: 'version-1',
      activated_at: 1_725_148_800,
      deactivated_at: 1_725_235_200,
      activated_by: {
        type: 'users',
        id: 'user-1',
        name: 'Operator',
        email: 'operator@example.org'
      }
    }],
    meta: { total: 2, page: 1, page_size: 1, has_next: true, view: 'summary' }
  })

  const raw = await runCli(['version-activations', 'list', '--game', 'game-1', '--page-size', '1', '--raw', '--format', 'json'], { env })
  assert.equal(raw.code, 0, raw.stderr)
  const rawDocument = JSON.parse(raw.stdout)
  assert.equal(rawDocument.data[0].attributes.deactivated_at, 1_725_235_200)
  assert.equal(rawDocument.data[0].attributes.backend_only, 'hidden in normalized output')
  assert.equal(rawDocument.included[0].attributes.role, 'developer-support')
  assert.equal(rawDocument.included[0].attributes.backend_only, 'hidden included value')
  assert.equal(rawDocument.meta.impersonator, 'hidden backend meta')

  const all = await runCli(['version-activations', 'list', '--game', 'game-1', '--page-size', '1', '--all', '--format', 'json'], { env })
  assert.equal(all.code, 0, all.stderr)
  const allDocument = JSON.parse(all.stdout)
  assert.deepEqual(allDocument.data.map((activation: { id: string }) => activation.id), ['activation-1', 'activation-2'])
  assert.equal(allDocument.data[0].backend_only, undefined)
  assert.equal(allDocument.data[0].deactivated_at, 1_725_235_200)
  assert.equal(allDocument.data[0].activated_by.role, undefined)
  assert.equal(allDocument.data[1].version_id, 'version-1', 'a repeated activation of the same version remains a separate row')
  assert.equal(allDocument.data[1].deactivated_at, null)
  assert.equal(allDocument.data[1].activated_by, null)
  assert.deepEqual(allDocument.meta, {
    fetched: 2,
    page: 1,
    page_size: 2,
    pages_fetched: 2,
    truncated: false,
    has_next: false,
    view: 'summary'
  })

  const csv = await runCli(['version-activations', 'list', '--game', 'game-1', '--page-size', '1', '--all', '--format', 'csv'], { env })
  assert.equal(csv.code, 0, csv.stderr)
  assert.equal(csv.stdout.trim().split('\n').length, 3)
  assert.equal(csv.stdout.split('\n', 1)[0], 'type,id,game_id,version_id,activated_at,deactivated_at,activated_by')
  assert.match(csv.stdout, /activation-1,game-1,version-1,1725148800,1725235200/)
  assert.match(csv.stdout, /activation-2,game-1,version-1,1725235200,,$/m)

  assert.equal(requests.length, 6)
  assert.equal(requests.filter(request => request.includes('page%5Bnumber%5D=2')).length, 2)
})
