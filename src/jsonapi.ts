import { sanitizeDeveloperPermissions } from './developer-permissions'
import {
  developerRelationshipValueIsValid,
  developerResourceField,
  isKnownDeveloperResourceType,
  sanitizeDeveloperResourceAttribute
} from './developer-surface'
import { CliError } from './errors'
import { isRecord } from './json'

export interface ResourceResult {
  data: unknown
  meta: Record<string, unknown>
}

export type JsonApiCardinality = 'singular' | 'collection' | 'either'

export interface JsonApiResourceIdentity {
  type: unknown
  id: unknown
}

// Documented fields of one resource that normalization could not represent.
// This is CLI-synthesized metadata, not backend document metadata: dropping a
// field silently would let an agent read filtering as absent backend state.
export interface UnreadableResourceFields {
  type: string
  id: string
  fields: string[]
}

export function jsonValueKind (value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function expectedDataKinds (cardinality: JsonApiCardinality): string[] {
  if (cardinality === 'singular') return ['object', 'null']
  if (cardinality === 'collection') return ['array', 'null']
  return ['object', 'array', 'null']
}

function malformedDocument (
  body: unknown,
  cardinality: JsonApiCardinality,
  reason: string
): CliError {
  const documentIsObject = isRecord(body)
  const hasData = documentIsObject && Object.prototype.hasOwnProperty.call(body, 'data')
  const data = hasData ? (body as { data?: unknown }).data : undefined
  return new CliError('INVALID_API_RESPONSE', 'The Poki API returned a malformed JSON:API document.', 5, {
    details: {
      reason,
      expected: {
        document_kind: 'object',
        primary_data_kinds: expectedDataKinds(cardinality)
      },
      received: {
        document_kind: jsonValueKind(body),
        primary_data_member: hasData ? 'present' : 'missing',
        ...(hasData ? { primary_data_kind: jsonValueKind(data) } : {})
      }
    },
    retryable: false
  })
}

function validateJsonApiDocument (body: unknown, cardinality: JsonApiCardinality): void {
  // Empty and JSON-null successful responses are represented as `null` by
  // ApiClient and remain valid empty results. Non-empty documents must carry
  // an explicit primary-data member so an error document or `{}` cannot be
  // mistaken for a successful empty collection/resource.
  if (body === null || body === undefined) return
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw malformedDocument(body, cardinality, 'document_must_be_an_object')
  }
  if (!Object.prototype.hasOwnProperty.call(body, 'data')) {
    throw malformedDocument(body, cardinality, 'primary_data_member_missing')
  }
  if (Object.prototype.hasOwnProperty.call(body, 'errors')) {
    throw malformedDocument(body, cardinality, 'data_and_errors_cannot_coexist')
  }

  const document = body as { data?: unknown, meta?: unknown, included?: unknown }
  const dataKind = jsonValueKind(document.data)
  if (!expectedDataKinds(cardinality).includes(dataKind)) {
    throw malformedDocument(body, cardinality, 'primary_data_cardinality_mismatch')
  }
  if (Array.isArray(document.data) && document.data.some(resource => resource === null || typeof resource !== 'object' || Array.isArray(resource))) {
    throw malformedDocument(body, cardinality, 'collection_contains_non_resource_value')
  }
  if (document.meta !== undefined && document.meta !== null && (typeof document.meta !== 'object' || Array.isArray(document.meta))) {
    throw malformedDocument(body, cardinality, 'meta_must_be_an_object')
  }
  if (document.included !== undefined && (!Array.isArray(document.included) || document.included.some(resource => !isRecord(resource)))) {
    throw malformedDocument(body, cardinality, 'included_must_be_an_array_of_resources')
  }
}

// Stateful callers sometimes need to validate a resource's raw JSON:API
// identity before trusting attributes or relationships that normalization may
// omit. Keep that validation on the original primary-data object: flattened
// attributes named `type` or `id` are never allowed to establish identity.
export function jsonApiPrimaryResource (body: unknown): Record<string, unknown> | null {
  validateJsonApiDocument(body, 'singular')
  if (body === null || body === undefined || (body as { data: unknown }).data === null) return null
  return (body as { data: Record<string, unknown> }).data
}

function resourceIdentity (resource: Record<string, unknown>): Record<string, unknown> {
  if (typeof resource.type !== 'string' || resource.type === '') return {}
  return {
    type: resource.type,
    ...(typeof resource.id === 'string' ? { id: resource.id } : {})
  }
}

function resourceKey (resource: Record<string, unknown>): string | undefined {
  return typeof resource.type === 'string' && resource.type !== '' && typeof resource.id === 'string'
    ? JSON.stringify([resource.type, resource.id])
    : undefined
}

interface ResourceWalkerContext {
  included: Map<string, Record<string, unknown> | null>
  objectAncestors: WeakSet<object>
  resourceAncestors: Set<string>
  unreadable: Map<string, UnreadableResourceFields>
}

function recordUnreadableField (
  context: ResourceWalkerContext,
  type: string,
  id: string,
  field: string
): void {
  const key = JSON.stringify([type, id])
  const entry = context.unreadable.get(key) ?? { type, id, fields: [] }
  if (!entry.fields.includes(field)) entry.fields.push(field)
  context.unreadable.set(key, entry)
}

function includedResources (body: Record<string, unknown>): Map<string, Record<string, unknown> | null> {
  const included = new Map<string, Record<string, unknown> | null>()
  if (!Array.isArray(body.included)) return included
  for (const candidate of body.included) {
    if (!isRecord(candidate)) continue
    const key = resourceKey(candidate)
    if (key === undefined) continue
    // Ambiguous duplicate included resources are deliberately left
    // unresolved. Relationship linkage still retains its safe identity.
    included.set(key, included.has(key) ? null : candidate)
  }
  return included
}

function normalizeRelationshipResource (
  linkage: Record<string, unknown>,
  context: ResourceWalkerContext
): Record<string, unknown> {
  const key = resourceKey(linkage)
  const expanded = key === undefined ? undefined : context.included.get(key)
  // JSON:API linkage carries identity only. Attributes and relationships are
  // trusted exclusively from one unambiguous matching included resource.
  return expanded === undefined || expanded === null
    ? resourceIdentity(linkage)
    : normalizeResource(expanded, context)
}

function normalizeRelationship (
  relationship: unknown,
  type: string,
  field: string,
  context: ResourceWalkerContext
): { valid: boolean, value?: unknown } {
  const definition = developerResourceField(type, field)
  if (definition?.source !== 'relationship' || !isRecord(relationship) || !Object.prototype.hasOwnProperty.call(relationship, 'data')) {
    return { valid: false }
  }
  const data = relationship.data
  if (!developerRelationshipValueIsValid(definition, data)) return { valid: false }
  if (data === null) return { valid: true, value: null }
  if (Array.isArray(data)) {
    if (data.some(resource => !isRecord(resource))) return { valid: false }
    return {
      valid: true,
      value: data.map(resource => normalizeRelationshipResource(resource, context))
    }
  }
  return isRecord(data)
    ? { valid: true, value: normalizeRelationshipResource(data, context) }
    : { valid: false }
}

function normalizeResource (
  resource: Record<string, unknown>,
  context: ResourceWalkerContext
): Record<string, unknown> {
  const identity = resourceIdentity(resource)
  const type = typeof resource.type === 'string' && resource.type !== '' ? resource.type : undefined
  if (type === undefined || !isKnownDeveloperResourceType(type)) return identity

  // A known resource with a malformed identity or JSON:API field container is
  // represented only by the trustworthy part of its identity. This prevents a
  // backend shape change from widening normalized output while keeping links
  // useful to an agent.
  const id = resource.id
  if (typeof id !== 'string' || id.trim() === '' ||
    (resource.attributes !== undefined && !isRecord(resource.attributes)) ||
    (resource.relationships !== undefined && !isRecord(resource.relationships))) {
    return identity
  }

  const key = resourceKey(resource)
  if (context.objectAncestors.has(resource) || (key !== undefined && context.resourceAncestors.has(key))) return identity
  context.objectAncestors.add(resource)
  if (key !== undefined) context.resourceAncestors.add(key)
  try {
    const output = { ...identity }
    if (isRecord(resource.attributes)) {
      for (const [field, value] of Object.entries(resource.attributes)) {
        const definition = developerResourceField(type, field)
        if (definition === undefined) continue
        // Identity and relationships must come from their JSON:API containers;
        // an attribute with the same name can never overwrite either one.
        if (definition.source !== 'attribute') return identity
        const sanitized = sanitizeDeveloperResourceAttribute(type, field, value)
        // One value the developer surface cannot represent says nothing about
        // the other fields, so drop that field alone and report it. Erasing the
        // whole resource turned a filtered field into apparent backend state.
        if (!sanitized.valid) {
          recordUnreadableField(context, type, id, field)
          continue
        }
        output[field] = sanitized.value
      }
    }
    if (isRecord(resource.relationships)) {
      for (const [field, relationship] of Object.entries(resource.relationships)) {
        const definition = developerResourceField(type, field)
        if (definition === undefined) continue
        // Likewise, a relationship cannot occupy a documented attribute name.
        if (definition.source !== 'relationship') return identity
        const normalized = normalizeRelationship(relationship, type, field, context)
        if (!normalized.valid) {
          recordUnreadableField(context, type, id, field)
          continue
        }
        output[field] = normalized.value
      }
    }
    return output
  } finally {
    context.objectAncestors.delete(resource)
    if (key !== undefined) context.resourceAncestors.delete(key)
  }
}

function normalizePrimaryData (body: Record<string, unknown>): { data: unknown, unreadable: UnreadableResourceFields[] } {
  const context: ResourceWalkerContext = {
    included: includedResources(body),
    objectAncestors: new WeakSet<object>(),
    resourceAncestors: new Set<string>(),
    unreadable: new Map<string, UnreadableResourceFields>()
  }
  const data = body.data === null
    ? null
    : Array.isArray(body.data)
      ? body.data.map(resource => normalizeResource(resource as Record<string, unknown>, context))
      : normalizeResource(body.data as Record<string, unknown>, context)
  return { data, unreadable: [...context.unreadable.values()] }
}

// The degradation report a normalized document carries when normalization had
// to drop a documented field. A caller deriving state from normalized output
// must treat a reported field as unknown rather than absent.
export function unreadableFieldsReport (result: ResourceResult): UnreadableResourceFields[] {
  const report = result.meta.unreadable_fields
  return Array.isArray(report) ? report as UnreadableResourceFields[] : []
}

function declaresField (container: unknown, field: string): boolean {
  return isRecord(container) && Object.prototype.hasOwnProperty.call(container, field)
}

// Which of the requested documented fields the backend sent but normalization
// could not represent. Both a dropped value and a resource collapsed to its
// identity leave the field missing, so state-deriving callers compare the
// validated raw resource with what normalization kept instead of reading the
// gap as absence.
export function unreadableFields (
  raw: Record<string, unknown>,
  normalized: Record<string, unknown>,
  fields: readonly string[]
): string[] {
  const containersAreReadable = (raw.attributes === undefined || isRecord(raw.attributes)) &&
    (raw.relationships === undefined || isRecord(raw.relationships))
  return fields.filter(field => {
    if (Object.prototype.hasOwnProperty.call(normalized, field)) return false
    // An unusable container hides which fields the response declared, so every
    // requested field is unknown rather than proven absent.
    if (!containersAreReadable) return true
    return declaresField(raw.attributes, field) || declaresField(raw.relationships, field)
  })
}

// Mutation callers can validate the identity exactly where JSON:API defines
// it, before normalization or --raw rendering. Attribute and relationship
// names are intentionally irrelevant to this result.
export function jsonApiPrimaryResourceIdentity (body: unknown): JsonApiResourceIdentity | null {
  if (body === null || body === undefined || !isRecord(body) || body.data === null) return null
  if (!isRecord(body.data)) return { type: undefined, id: undefined }
  return { type: body.data.type, id: body.data.id }
}

export function normalizeJsonApi (
  body: unknown,
  page?: number,
  pageSize?: number,
  cardinality: JsonApiCardinality = 'either'
): ResourceResult {
  validateJsonApiDocument(body, cardinality)
  const payload = body as { meta?: Record<string, unknown> } | null | undefined
  const backendMeta = payload?.meta ?? {}
  // Backend document metadata is an evolving surface just like resource
  // attributes. Only explicitly reviewed keys belong to normalized output;
  // --raw bypasses normalizeJsonApi and remains the troubleshooting escape.
  const meta = {
    ...(Object.prototype.hasOwnProperty.call(backendMeta, 'total') ? { total: backendMeta.total } : {}),
    ...(Object.prototype.hasOwnProperty.call(backendMeta, 'failed') ? { failed: backendMeta.failed } : {}),
    ...(Object.prototype.hasOwnProperty.call(backendMeta, 'permissions')
      ? { permissions: sanitizeDeveloperPermissions(backendMeta.permissions) }
      : {})
  }
  // A 204 or empty 2xx body means the operation succeeded with nothing to
  // return.
  const hasExplicitNullData = isRecord(body) &&
    Object.prototype.hasOwnProperty.call(body, 'data') && (body as { data?: unknown }).data === null
  const primary = body === null || body === undefined || hasExplicitNullData
    ? { data: null, unreadable: [] }
    : normalizePrimaryData(body as Record<string, unknown>)
  return {
    data: primary.data,
    meta: {
      ...meta,
      ...(page === undefined ? {} : { page }),
      ...(pageSize === undefined ? {} : { page_size: pageSize }),
      // Locally synthesized, so it is unaffected by the reviewed backend
      // document-metadata allowlist above.
      ...(primary.unreadable.length === 0 ? {} : { unreadable_fields: primary.unreadable })
    }
  }
}

export function normalizeJsonApiResource (body: unknown): ResourceResult {
  return normalizeJsonApi(body, undefined, undefined, 'singular')
}

// A committed create can return a structurally valid resource whose ID is
// unusable. Normal output must collapse that malformed known resource to its
// trustworthy identity, but action-level recovery still benefits from a
// developer-filtered state snapshot. Run that snapshot through the same raw
// walker with a temporary identity, then remove the synthetic ID.
export function normalizeJsonApiResourceForRecovery (body: unknown): ResourceResult {
  const normalized = normalizeJsonApiResource(body)
  const raw = jsonApiPrimaryResource(body)
  if (raw === null || (typeof raw.id === 'string' && raw.id.trim() !== '')) return normalized

  const recoveryPlaceholderId = '__poki_cli_unidentified_resource__'
  const document = body as Record<string, unknown>
  const recovery = normalizeJsonApiResource({
    ...document,
    data: { ...raw, id: recoveryPlaceholderId }
  })
  if (isRecord(recovery.data)) {
    delete recovery.data.id
  }
  // The synthetic identity must not surface anywhere in the snapshot, so the
  // degradation report loses it exactly like the resource does.
  const report = unreadableFieldsReport(recovery)
  if (report.length > 0) {
    recovery.meta.unreadable_fields = report.map(({ type, id, fields }) => ({
      type,
      ...(id === recoveryPlaceholderId ? {} : { id }),
      fields
    }))
  }
  return recovery
}

export function normalizeJsonApiCollection (body: unknown, page?: number, pageSize?: number): ResourceResult {
  return normalizeJsonApi(body, page, pageSize, 'collection')
}

export function jsonApiDocument (
  type: string,
  attributes: Record<string, unknown>,
  id?: string,
  relationships: Record<string, { type: string, id: string }> = {}
): Record<string, unknown> {
  const relationshipEntries = Object.entries(relationships)
  return {
    data: {
      type,
      ...(id === undefined ? {} : { id }),
      attributes: { ...attributes },
      ...(relationshipEntries.length === 0
        ? {}
        : {
            relationships: Object.fromEntries(relationshipEntries
              .map(([name, resource]) => [name, { data: { ...resource } }]))
          })
    }
  }
}
