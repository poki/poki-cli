import {
  DocumentedResourceKind,
  RelationshipResourceApiType,
  ResourceDocumentation,
  resourceDocumentationRegistry
} from './docs/resources'
import { CliError } from './errors'
import { isRecord } from './json'

export type ResourceListKind = DocumentedResourceKind | 'version-files'

const documentationByKind = Object.fromEntries(resourceDocumentationRegistry
  .map(({ kind, documentation }) => [kind, documentation])) as Record<DocumentedResourceKind, ResourceDocumentation>

// Resources with no resource-documentation entry: the authenticated user, its
// team, and version files. These tables are the one declaration of those
// kinds; for version files the keys are also the developer-visible field list.
const undocumentedFieldTypesByType: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  users: {
    type: 'string',
    id: 'string',
    name: 'string|null',
    email: 'string|null',
    picture: 'string|null',
    team_id: 'string|null',
    team: 'team relationship|null',
    created_at: 'timestamp|null',
    updated_at: 'timestamp|null'
  },
  teams: {
    type: 'string',
    id: 'string',
    name: 'string|null',
    code: 'string|null'
  },
  game_version_files: {
    type: 'string',
    id: 'string',
    version_id: 'string',
    filename: 'string',
    size: 'integer',
    content_type: 'string',
    hash: 'string',
    has_redirect: 'boolean',
    created_at: 'timestamp'
  }
}

const undocumentedRelationshipApiTypesByPath = {
  'users.team': ['teams']
} as const satisfies Readonly<Record<string, readonly RelationshipResourceApiType[]>>

function ownValue<T> (record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined
}

interface DeveloperFieldDefinition {
  type: string
  relationshipApiTypes: readonly RelationshipResourceApiType[]
}

// The single table behind every developer-surface lookup. While known types
// were split across parallel tables one lookup could answer "known" where
// another answered "no such field", which is how an unreviewed field reaches
// normalized output.
const developerFieldsByType: Record<string, Readonly<Record<string, DeveloperFieldDefinition>>> = {}
for (const { apiType, documentation } of resourceDocumentationRegistry) {
  developerFieldsByType[apiType] = Object.fromEntries(documentation.fields.map(field => [field.name, {
    type: field.type,
    relationshipApiTypes: field.relationshipApiTypes ?? []
  }]))
}
for (const [type, fieldTypes] of Object.entries(undocumentedFieldTypesByType)) {
  developerFieldsByType[type] = Object.fromEntries(Object.entries(fieldTypes).map(([field, fieldType]) => [field, {
    type: fieldType,
    relationshipApiTypes: ownValue(undocumentedRelationshipApiTypesByPath, `${type}.${field}`) ?? []
  }]))
}

function setOwnValue (record: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(record, key, { value, enumerable: true, configurable: true, writable: true })
}

const fieldsForDocumentation = (documentation: ResourceDocumentation): readonly string[] => documentation.fields.map(field => field.name)

export function developerFieldsForKind (kind: ResourceListKind): readonly string[] {
  return kind === 'version-files'
    ? Object.keys(developerFieldsByType.game_version_files)
    : fieldsForDocumentation(documentationByKind[kind])
}

// List kinds are internal projection identifiers and do not always match the
// public command that owns field discovery (playtests -> playtest-recordings),
// so the command name comes from the documentation registry rather than a
// second hand-maintained table. Version files intentionally have no separate
// documentation group; their complete field list is already returned in
// INVALID_INPUT details.
export function fieldDiscoveryCommandForKind (kind: ResourceListKind): string | undefined {
  return kind === 'version-files' ? undefined : `poki ${documentationByKind[kind].command} fields`
}

export type DeveloperResourceFieldSource = 'identity' | 'attribute' | 'relationship'

export interface DeveloperResourceField {
  source: DeveloperResourceFieldSource
  type: string
  collection: boolean
  nullable: boolean
  relationshipApiTypes: readonly RelationshipResourceApiType[]
}

export interface DeveloperAttributeResult {
  valid: boolean
  value?: unknown
}

interface SanitizationContext {
  ancestors: WeakSet<object>
}

type ValueRuleKind = 'string' | 'boolean' | 'integer' | 'number' | 'timestamp' | 'object' | 'array' | 'json'

interface ValueRule {
  kind: ValueRuleKind
  nullable?: boolean
  item?: ValueRule
  fields?: Readonly<Record<string, ValueRule>>
  values?: ValueRule
}

const stringRule: ValueRule = { kind: 'string' }
const integerRule: ValueRule = { kind: 'integer' }
const numberRule: ValueRule = { kind: 'number' }
const booleanRule: ValueRule = { kind: 'boolean' }
const timestampRule: ValueRule = { kind: 'timestamp' }

// These are the object-valued fields whose shape is itself part of the
// reviewed developer surface. Object fields absent from this table are
// documented dynamic maps and remain opaque after their outer kind is checked.
const structuredRulesByPath: Readonly<Record<string, ValueRule>> = {
  'games.annotations': {
    kind: 'object',
    fields: { engine: stringRule }
  },
  'games.tracks': {
    kind: 'array',
    item: {
      kind: 'object',
      fields: {
        track: stringRule,
        version_id: stringRule,
        weight: integerRule
      }
    }
  },
  'games.content_metadata': {
    kind: 'object',
    nullable: true,
    fields: {
      content_game_id: integerRule,
      urls: { kind: 'object', values: stringRule },
      rating: {
        kind: 'object',
        nullable: true,
        fields: {
          up_count: integerRule,
          down_count: integerRule,
          rating: numberRule
        }
      },
      release_status: stringRule,
      release_status_changed_at: stringRule,
      release_date: stringRule,
      family_blocked: booleanRule,
      app_excluded: booleanRule,
      desktop_only: booleanRule,
      orientation: stringRule,
      category_id: integerRule,
      categories: { kind: 'array', item: integerRule }
    }
  },
  'reviews.changelog_notes': {
    kind: 'object',
    nullable: true,
    fields: {
      status: stringRule,
      model: stringRule,
      engine: stringRule,
      engine_tier: integerRule,
      baseline_version_id: stringRule,
      generated_at: timestampRule,
      changes: {
        kind: 'array',
        item: {
          kind: 'object',
          fields: {
            summary: stringRule,
            confidence: stringRule
          }
        }
      },
      skip_reason: stringRule,
      failure_reason: stringRule
    }
  }
}

export function isKnownDeveloperResourceType (type: string): boolean {
  return ownValue(developerFieldsByType, type) !== undefined
}

export function developerResourceField (type: string, field: string): DeveloperResourceField | undefined {
  const fields = ownValue(developerFieldsByType, type)
  const definition = fields === undefined ? undefined : ownValue(fields, field)
  if (definition === undefined) return undefined
  const { type: fieldType, relationshipApiTypes } = definition
  return {
    source: field === 'type' || field === 'id' ? 'identity' : relationshipApiTypes.length > 0 ? 'relationship' : 'attribute',
    type: fieldType,
    collection: fieldType.startsWith('array<'),
    nullable: fieldType.endsWith('|null'),
    relationshipApiTypes
  }
}

function valueRuleForDocumentedType (type: string): ValueRule | undefined {
  const nullable = type.endsWith('|null')
  const base = nullable ? type.slice(0, -'|null'.length) : type
  if (base === 'string' || base === 'string enum') return { kind: 'string', nullable }
  if (base === 'boolean') return { kind: 'boolean', nullable }
  if (base === 'integer') return { kind: 'integer', nullable }
  if (base === 'number') return { kind: 'number', nullable }
  if (base === 'timestamp') return { kind: 'timestamp', nullable }
  if (base === 'object') return { kind: 'object', nullable }
  if (base === 'JSON value') return { kind: 'json', nullable }
  const array = /^array<(string|integer|number|object)>$/.exec(base)
  if (array !== null) {
    return {
      kind: 'array',
      nullable,
      item: valueRuleForDocumentedType(array[1])
    }
  }
  return undefined
}

// Arbitrary JSON such as a Netlib lobby's custom_data is game-controlled and is
// preserved verbatim, so its nesting depth is an untrusted input: without a
// bound, a hostile document exhausts the stack and takes the whole command with
// it. The limit is far beyond any documented developer value, and a breach is
// reported structurally because the payload itself must never reach an error.
const MAX_JSON_VALUE_DEPTH = 64

function jsonValueTooDeep (kind: 'array' | 'object'): CliError {
  return new CliError('INVALID_API_RESPONSE', `An arbitrary JSON value nested deeper than ${String(MAX_JSON_VALUE_DEPTH)} levels.`, 5, {
    details: {
      expected: { max_depth: MAX_JSON_VALUE_DEPTH },
      received: { kind }
    }
  })
}

function isJsonValue (value: unknown, ancestors: WeakSet<object>, depth = 0): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) {
    if (ancestors.has(value)) return false
    if (depth >= MAX_JSON_VALUE_DEPTH) throw jsonValueTooDeep('array')
    ancestors.add(value)
    try {
      return value.every(child => isJsonValue(child, ancestors, depth + 1))
    } finally {
      ancestors.delete(value)
    }
  }
  if (!isRecord(value) || ancestors.has(value)) return false
  if (depth >= MAX_JSON_VALUE_DEPTH) throw jsonValueTooDeep('object')
  ancestors.add(value)
  try {
    return Object.values(value).every(child => isJsonValue(child, ancestors, depth + 1))
  } finally {
    ancestors.delete(value)
  }
}

function sanitizeByRule (
  value: unknown,
  rule: ValueRule,
  context: SanitizationContext
): DeveloperAttributeResult {
  if (value === null) return rule.nullable === true ? { valid: true, value: null } : { valid: false }
  if (rule.kind === 'string') return typeof value === 'string' ? { valid: true, value } : { valid: false }
  if (rule.kind === 'boolean') return typeof value === 'boolean' ? { valid: true, value } : { valid: false }
  if (rule.kind === 'integer') return typeof value === 'number' && Number.isInteger(value) ? { valid: true, value } : { valid: false }
  if (rule.kind === 'number') return typeof value === 'number' && Number.isFinite(value) ? { valid: true, value } : { valid: false }
  if (rule.kind === 'timestamp') {
    return (typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)))
      ? { valid: true, value }
      : { valid: false }
  }
  if (rule.kind === 'json') {
    return isJsonValue(value, new WeakSet<object>()) ? { valid: true, value } : { valid: false }
  }
  if (rule.kind === 'array') {
    if (!Array.isArray(value) || rule.item === undefined || context.ancestors.has(value)) return { valid: false }
    context.ancestors.add(value)
    try {
      const output: unknown[] = []
      for (const child of value) {
        const sanitized = sanitizeByRule(child, rule.item, context)
        if (!sanitized.valid) return { valid: false }
        output.push(sanitized.value)
      }
      return { valid: true, value: output }
    } finally {
      context.ancestors.delete(value)
    }
  }
  if (!isRecord(value) || context.ancestors.has(value)) return { valid: false }

  // A documented map without a nested schema is arbitrary JSON. Validate its
  // outer shape and JSON nature, then retain it verbatim.
  if (rule.fields === undefined && rule.values === undefined) {
    return isJsonValue(value, new WeakSet<object>()) ? { valid: true, value } : { valid: false }
  }

  context.ancestors.add(value)
  try {
    const output: Record<string, unknown> = {}
    if (rule.values !== undefined) {
      for (const [field, child] of Object.entries(value)) {
        const sanitized = sanitizeByRule(child, rule.values, context)
        if (!sanitized.valid) return { valid: false }
        setOwnValue(output, field, sanitized.value)
      }
      return { valid: true, value: output }
    }
    for (const [field, childRule] of Object.entries(rule.fields ?? {})) {
      if (!Object.prototype.hasOwnProperty.call(value, field)) continue
      const sanitized = sanitizeByRule(value[field], childRule, context)
      if (!sanitized.valid) return { valid: false }
      setOwnValue(output, field, sanitized.value)
    }
    return { valid: true, value: output }
  } finally {
    context.ancestors.delete(value)
  }
}

export function sanitizeDeveloperResourceAttribute (
  type: string,
  field: string,
  value: unknown,
  context: SanitizationContext = { ancestors: new WeakSet<object>() }
): DeveloperAttributeResult {
  const definition = developerResourceField(type, field)
  if (definition?.source !== 'attribute') return { valid: false }
  const rule = ownValue(structuredRulesByPath, `${type}.${field}`) ?? valueRuleForDocumentedType(definition.type)
  if (rule === undefined) return { valid: false }
  return sanitizeByRule(value, rule, context)
}

export function developerRelationshipValueIsValid (definition: DeveloperResourceField, value: unknown): boolean {
  if (value === null) return definition.nullable
  const resources = definition.collection ? value : [value]
  return Array.isArray(resources) && resources.every(resource =>
    isRecord(resource) &&
    typeof resource.type === 'string' &&
    typeof resource.id === 'string' &&
    resource.id.trim() !== '' &&
    definition.relationshipApiTypes.some(expected => expected === resource.type))
}
