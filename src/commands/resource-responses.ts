import { ApiClient } from '../api'
import { CliError } from '../errors'
import {
  jsonApiPrimaryResource,
  jsonApiPrimaryResourceIdentity,
  jsonValueKind,
  normalizeJsonApi,
  normalizeJsonApiResource,
  normalizeJsonApiResourceForRecovery,
  ResourceResult
} from '../jsonapi'
import { isRecord } from '../json'
import { MutationBehavior, mutationPreview, requestTimeout } from './command-options'
import { render } from './rendering'

export interface ExpectedJsonApiResource {
  type: string
  id?: string
}

export interface ExpectedJsonApiResourceResult {
  raw: Record<string, unknown>
  normalized: Record<string, unknown>
  document: ResourceResult
}

export interface NullableExpectedJsonApiResourceResult {
  raw: Record<string, unknown> | null
  normalized: Record<string, unknown> | null
  document: ResourceResult
}

interface ExpectedResourceIdentityCheck {
  type: unknown
  id: unknown
  typeMatches: boolean
  idIsUsable: boolean
  idMatches: boolean
  valid: boolean
}

function checkExpectedResourceIdentity (
  resource: { type?: unknown, id?: unknown } | null,
  expected: ExpectedJsonApiResource
): ExpectedResourceIdentityCheck {
  const type = resource?.type
  const id = resource?.id
  const typeMatches = type === expected.type
  const idIsUsable = typeof id === 'string' && id.trim() !== ''
  const idMatches = idIsUsable && (expected.id === undefined || id === expected.id)
  return {
    type,
    id,
    typeMatches,
    idIsUsable,
    idMatches,
    valid: resource !== null && typeMatches && idMatches
  }
}

function expectedResourceIdentityDetails (
  expected: ExpectedJsonApiResource,
  identity: ExpectedResourceIdentityCheck,
  receivedPrimaryDataKind: string
): Record<string, unknown> {
  return {
    expected_resource_type: expected.type,
    ...(expected.id === undefined ? { expected_resource_id_kind: 'non_empty_string' } : { expected_resource_id: expected.id }),
    received_primary_data_kind: receivedPrimaryDataKind,
    received_resource_type_kind: jsonValueKind(identity.type),
    received_resource_type_matches: identity.typeMatches,
    received_resource_id_kind: jsonValueKind(identity.id),
    received_resource_id_usable: identity.idIsUsable,
    ...(expected.id === undefined ? {} : { received_resource_id_matches: identity.idMatches })
  }
}

export function responseLocation (body: unknown, description: string): string {
  if (body === null || typeof body !== 'object' || Array.isArray(body) || typeof (body as { location?: unknown }).location !== 'string') {
    throw new CliError('INVALID_API_RESPONSE', `The Poki API did not return ${description}.`, 5, {
      details: { expected: 'object_with_string_location', received_kind: jsonValueKind(body) }
    })
  }
  const location = (body as { location: string }).location
  if (location.trim() === '') {
    throw new CliError('INVALID_API_RESPONSE', `The Poki API did not return ${description}.`, 5, {
      details: { expected: 'non_empty_location_string', received_kind: 'empty_string' }
    })
  }
  return location
}

export function isMalformedSuccessfulMutation (error: unknown): error is CliError {
  return error instanceof CliError && error.code === 'INVALID_API_RESPONSE' &&
    error.status !== undefined && error.status >= 200 && error.status < 300
}

export function normalizeMutationResponse (
  body: unknown,
  status: number,
  method: 'POST' | 'PATCH' | 'DELETE',
  path: string,
  expected: ExpectedJsonApiResource,
  onRecoverySnapshot?: (result: ResourceResult) => void
): ResourceResult {
  let normalized: ResourceResult
  try {
    normalized = normalizeJsonApi(body, undefined, undefined, 'singular')
  } catch (error) {
    throw new CliError('INVALID_API_RESPONSE', 'The Poki API returned a malformed JSON:API document after a successful mutation response.', 5, {
      status,
      details: {
        method,
        path,
        expected_primary_data: 'singular',
        received_document_kind: jsonValueKind(body),
        received_primary_data_member: isRecord(body) && Object.prototype.hasOwnProperty.call(body, 'data')
          ? 'present'
          : 'missing',
        ...(isRecord(body) && Object.prototype.hasOwnProperty.call(body, 'data')
          ? { received_primary_data_kind: jsonValueKind((body as { data?: unknown }).data) }
          : {})
      },
      retryable: false,
      hint: `The ${method} mutation may already have committed. Inspect current resource state and do not replay it blindly.`
    })
  }

  // Async create wrappers use this sanitized snapshot for inspect-before-
  // replay recovery when the document is valid but its resource identity is
  // unusable. It is deliberately captured before identity validation and is
  // never substituted for a successful command result.
  onRecoverySnapshot?.(normalizeJsonApiResourceForRecovery(body))

  if (normalized.data !== null) {
    const resource = jsonApiPrimaryResourceIdentity(body) ?? { type: undefined, id: undefined }
    const identity = checkExpectedResourceIdentity(resource, expected)
    if (!identity.valid) {
      throw new CliError('INVALID_API_RESPONSE', 'The Poki API returned an unexpected resource identity after a successful mutation response.', 5, {
        status,
        details: {
          method,
          path,
          ...expectedResourceIdentityDetails(expected, identity, jsonValueKind(normalized.data))
        },
        retryable: false,
        hint: `The ${method} mutation may already have committed. Inspect current resource state and do not replay it blindly.`
      })
    }
  }
  return normalized
}

export function requireExpectedJsonApiResource (
  body: unknown,
  expected: ExpectedJsonApiResource,
  description: string,
  options?: { allowNull?: false }
): ExpectedJsonApiResourceResult
export function requireExpectedJsonApiResource (
  body: unknown,
  expected: ExpectedJsonApiResource,
  description: string,
  options: { allowNull: true }
): NullableExpectedJsonApiResourceResult
export function requireExpectedJsonApiResource (
  body: unknown,
  expected: ExpectedJsonApiResource,
  description: string,
  options: { allowNull?: boolean } = {}
): ExpectedJsonApiResourceResult | NullableExpectedJsonApiResourceResult {
  // Read and check the resource before normalization. A malformed known field
  // can deliberately collapse normalized output to identity-only; that must
  // never make state appear absent to a caller preparing a mutation.
  const raw = jsonApiPrimaryResource(body)
  const document = normalizeJsonApiResource(body)
  if (raw === null && options.allowNull === true) {
    return { raw: null, normalized: null, document }
  }
  const identity = checkExpectedResourceIdentity(raw, expected)
  if (!identity.valid) {
    throw new CliError('INVALID_API_RESPONSE', `The ${description} response did not contain the requested resource.`, 5, {
      details: expectedResourceIdentityDetails(expected, identity, raw === null ? 'null' : 'object'),
      retryable: false
    })
  }

  const normalized = document.data
  if (normalized === null || typeof normalized !== 'object' || Array.isArray(normalized)) {
    throw new CliError('INVALID_API_RESPONSE', `The ${description} response did not contain one resource.`, 5, {
      details: { received_primary_data_kind: jsonValueKind(normalized) },
      retryable: false
    })
  }
  return { raw, normalized: normalized as Record<string, unknown>, document }
}
export async function getResource (
  api: ApiClient,
  path: string,
  args: Record<string, unknown>,
  expected?: ExpectedJsonApiResource,
  description = 'resource read'
): Promise<unknown> {
  const response = await api.request({ path, timeoutMs: requestTimeout(args) })
  if (args.raw === true) return response.body
  return expected === undefined
    ? normalizeJsonApiResource(response.body)
    : requireExpectedJsonApiResource(response.body, expected, description, { allowNull: true }).document
}

// Commands that need the raw resource, the normalized resource, and the
// document - a mutation preflight, a readiness read, a degraded-field report -
// cannot use getResource, which returns only one of the three. They still must
// read through the applicable request timeout and validate resource identity
// before deriving state from the response.
export async function readExpectedResource (
  api: ApiClient,
  path: string,
  args: Record<string, unknown>,
  expected: ExpectedJsonApiResource,
  description: string
): Promise<ExpectedJsonApiResourceResult> {
  const response = await api.request({ path, timeoutMs: requestTimeout(args) })
  return requireExpectedJsonApiResource(response.body, expected, description)
}

export async function mutateResource (
  api: ApiClient,
  method: 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body: unknown,
  args: Record<string, unknown>,
  expected: ExpectedJsonApiResource
): Promise<unknown> {
  const response = await api.request({ method, path, body, timeoutMs: requestTimeout(args) })
  const normalized = normalizeMutationResponse(response.body, response.status, method, path, expected)
  return args.raw === true ? response.body : normalized
}

export async function mutateAction (
  api: ApiClient,
  method: 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body: unknown,
  args: Record<string, unknown>,
  expected: ExpectedJsonApiResource,
  fallbackData: Record<string, unknown>,
  options: { preferResponse?: boolean } = {}
): Promise<unknown> {
  const response = await api.request({ method, path, body, timeoutMs: requestTimeout(args) })
  const normalized = normalizeMutationResponse(response.body, response.status, method, path, expected)
  if (args.raw === true) return response.body
  if (options.preferResponse === true && response.body !== null) return normalized
  return { data: fallbackData, meta: {} }
}

export interface RenderedMutation {
  method: 'POST' | 'PATCH' | 'DELETE'
  path: string
  body?: unknown
  // The resource identity a successful mutation response must carry.
  expected: ExpectedJsonApiResource
  behavior?: MutationBehavior
  // Stands in for the resolved body in a dry-run preview when echoing the real
  // one would print an encoded file.
  previewBody?: unknown
  // Actions whose successful response is normally empty report this result
  // instead; preferResponse returns the response when the backend sent one.
  action?: { result: Record<string, unknown>, preferResponse?: boolean }
}

// A dry-run preview must describe the request the command would actually send.
// Naming the method, path, body, and resource identity once for the preview and
// again for the execution let the two drift apart, which would make --dry-run
// report a request the command never sends.
export async function renderMutation (
  api: ApiClient,
  args: Record<string, unknown>,
  mutation: RenderedMutation
): Promise<void> {
  const { method, path, body, expected, action } = mutation
  if (mutationPreview(method, path, mutation.previewBody ?? body, args, mutation.behavior)) return
  render(action === undefined
    ? await mutateResource(api, method, path, body, args, expected)
    : await mutateAction(api, method, path, body, args, expected, action.result, { preferResponse: action.preferResponse }), args)
}
