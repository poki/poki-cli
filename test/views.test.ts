import assert from 'node:assert/strict'
import test from 'node:test'

import { developerFieldsForKind } from '../src/developer-surface'
import { CliError } from '../src/errors'
import { applyListView, listViewColumns, resourceSummaryFields, ResourceListKind, validateListViewFields } from '../src/views'

const kinds = Object.keys(resourceSummaryFields) as ResourceListKind[]

// Builds a resource carrying every documented summary field plus extra fields
// that a summary view must never leak.
function fullResource (kind: ResourceListKind): Record<string, unknown> {
  const resource: Record<string, unknown> = {}
  for (const field of resourceSummaryFields[kind]) resource[field] = `${kind}:${field}`
  resource.secret_extra = 'private detail'
  resource.another_unknown_field = 42
  return resource
}

void test('every resource kind projects exactly its documented summary fields', () => {
  assert.equal(kinds.length, 13)
  for (const kind of kinds) {
    const fields = resourceSummaryFields[kind]
    // type and id are part of every documented summary, so projection keeps
    // them without special-casing.
    assert.equal(fields[0], 'type', kind)
    assert.equal(fields[1], 'id', kind)

    const resource = fullResource(kind)
    const value = { data: [resource], meta: { total: 1 } }

    const summary = applyListView(value, {}, kind) as { data: [Record<string, unknown>], meta: Record<string, unknown> }
    assert.deepEqual(Object.keys(summary.data[0]), [...fields], kind)
    assert.deepEqual(summary.data[0], Object.fromEntries(fields.map(field => [field, `${kind}:${field}`])), kind)
    assert.deepEqual(summary.meta, { total: 1, view: 'summary' }, kind)

    const full = applyListView(value, { full: true }, kind) as { data: [Record<string, unknown>], meta: Record<string, unknown> }
    assert.deepEqual(full.data[0], Object.fromEntries(fields.map(field => [field, `${kind}:${field}`])), kind)
    assert.equal(full.data[0].secret_extra, undefined, kind)
    assert.equal(full.data[0].another_unknown_field, undefined, kind)
    assert.deepEqual(full.meta, { total: 1, view: 'full' }, kind)

    // Raw output bypasses view projection entirely.
    assert.equal(applyListView(value, { raw: true }, kind), value, kind)
  }
})

void test('summary projection omits documented fields the resource does not carry', () => {
  const value = { data: [{ type: 'games', id: 'game-1', title: 'Example' }], meta: {} }
  const projected = applyListView(value, {}, 'games') as { data: [Record<string, unknown>], meta: Record<string, unknown> }
  assert.deepEqual(projected.data[0], { type: 'games', id: 'game-1', title: 'Example' })
  assert.equal(projected.meta.view, 'summary')
})

// Every list command validates --fields through this one check before its
// handler runs, so the rejection contract is pinned on the validator itself.
void test('invalid selected fields point to real public discovery commands', () => {
  assert.throws(() => validateListViewFields('playtests', 'unknown'), (error: unknown) => {
    assert.ok(error instanceof CliError)
    assert.equal(error.hint, 'Run `poki playtest-recordings fields` to inspect the developer-visible fields.')
    return true
  })

  assert.throws(() => validateListViewFields('version-files', 'unknown'), (error: unknown) => {
    assert.ok(error instanceof CliError)
    assert.doesNotMatch(error.hint ?? '', /poki version-files fields/)
    assert.match(error.hint ?? '', /details\.available_fields/)
    assert.match(error.hint ?? '', /poki help versions files/)
    return true
  })
})

// The CSV header of an empty collection is derived from the same rule that
// projects the rows, so an export can never describe columns the projection
// would not have produced.
void test('list view columns match the projection for every view', () => {
  for (const kind of kinds) {
    assert.deepEqual(listViewColumns(kind, {}), resourceSummaryFields[kind], kind)
    assert.deepEqual(listViewColumns(kind, { full: true }), developerFieldsForKind(kind), kind)

    const [, , third] = resourceSummaryFields[kind]
    assert.deepEqual(listViewColumns(kind, { fields: ` ${third} , type ,, ${third} ` }), ['type', 'id', third], kind)

    const value = { data: [fullResource(kind)], meta: {} }
    const projected = applyListView(value, { fields: `${third},id` }, kind) as { data: [Record<string, unknown>], meta: Record<string, unknown> }
    assert.deepEqual(Object.keys(projected.data[0]), [...listViewColumns(kind, { fields: `${third},id` })], kind)
    assert.equal(projected.meta.view, 'selected', kind)
  }
})

void test('every summary field list stays within the developer-visible contract', () => {
  // A summary field outside developerFieldsForKind would be dropped silently
  // by projection rather than reported, so the two lists are pinned together.
  for (const kind of kinds) {
    const available = developerFieldsForKind(kind)
    const outside = resourceSummaryFields[kind].filter(field => !available.includes(field))
    assert.deepEqual(outside, [], kind)
  }
})
