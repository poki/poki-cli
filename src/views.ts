import { developerFieldsForKind, fieldDiscoveryCommandForKind, ResourceListKind } from './developer-surface'
import { inputError } from './errors'
import { isRecord } from './json'

export type { ResourceListKind } from './developer-surface'

export const resourceSummaryFields: Record<ResourceListKind, readonly string[]> = {
  games: ['type', 'id', 'title', 'team_id', 'approved', 'public_version', 'updated_at'],
  versions: ['type', 'id', 'game_id', 'filename', 'label', 'state', 'progress', 'archived_at', 'activated_at', 'url', 'created_at'],
  'version-activations': ['type', 'id', 'game_id', 'version_id', 'activated_at', 'deactivated_at', 'activated_by'],
  // Version files carry few enough fields that the summary is the full
  // developer-visible list; deriving it keeps the two from drifting, because a
  // stray summary field would silently vanish from output instead of failing.
  'version-files': developerFieldsForKind('version-files'),
  playtests: ['type', 'id', 'game_id', 'version_id', 'duration', 'device_category', 'watched', 'archived_at', 'created_at', 'video_url', 'metadata_json_url'],
  'playtest-requests': ['type', 'id', 'game_id', 'version_id', 'recordings', 'pending', 'device_category', 'orientation', 'created_at'],
  'player-fit-tests': ['type', 'id', 'game_id', 'version_id', 'status', 'gameplays', 'target_gameplays', 'engagement', 'stopped_at', 'created_at'],
  reviews: ['type', 'id', 'version', 'status', 'queue_time', 'seen_by_developer', 'report_submitted_at', 'created_by', 'created_at'],
  'game-change-requests': ['type', 'id', 'game_id', 'game', 'status', 'title', 'thumbnail_url', 'created_by', 'reviewed_by', 'created_at'],
  'game-events': ['type', 'id', 'game_id', 'category', 'action', 'label', 'enabled', 'include_in_funnel', 'created_at', 'updated_at'],
  'game-event-funnels': ['type', 'id', 'game_id', 'team_id', 'title', 'created_by_id', 'created_at', 'updated_at'],
  'player-feedback-questions': ['type', 'id', 'game_id', 'team_id', 'created_by_id', 'status', 'start_date', 'end_date', 'feedback_message_types', 'feedback_count', 'error', 'model', 'created_at', 'updated_at'],
  'netlib-lobbies': ['type', 'id', 'code', 'peer_count', 'ghosts', 'max_players', 'public', 'has_password', 'updated_at', 'created_at']
}

interface ListViewArguments {
  full?: boolean
  fields?: string
  raw?: boolean
}

function selectedFields (fields: string | undefined): string[] | undefined {
  if (fields === undefined) return undefined
  const selected = fields.split(',').map(field => field.trim()).filter(field => field !== '')
  return [...new Set(['type', 'id', ...selected])]
}

// The columns a list view projects with. CSV exports declare them even when the
// collection is empty and has no row to derive a header from, so the header and
// the projection must come from this one rule.
export function listViewColumns (kind: ResourceListKind, args: ListViewArguments): readonly string[] {
  if (args.full === true) return developerFieldsForKind(kind)
  return selectedFields(args.fields) ?? resourceSummaryFields[kind]
}

export function validateListViewFields (kind: ResourceListKind, fields: string | undefined): void {
  const selected = selectedFields(fields)
  if (selected === undefined) return
  const available = developerFieldsForKind(kind)
  const unknown = selected.filter(field => !available.includes(field))
  if (unknown.length > 0) {
    const discoveryCommand = fieldDiscoveryCommandForKind(kind)
    throw inputError('--fields contains fields outside the developer-visible resource contract.', {
      unknown_fields: unknown,
      available_fields: available
    }, discoveryCommand === undefined
      ? 'Use details.available_fields to inspect every developer-visible version-file field; run `poki help versions files` for the command contract.'
      : `Run \`${discoveryCommand}\` to inspect the developer-visible fields.`)
  }
}

function projectResource (resource: unknown, fields: readonly string[]): unknown {
  if (!isRecord(resource)) return resource
  return Object.fromEntries(fields
    .filter(field => Object.prototype.hasOwnProperty.call(resource, field))
    .map(field => [field, resource[field]]))
}

export function applyListView (
  value: unknown,
  args: ListViewArguments,
  kind: ResourceListKind
): unknown {
  if (args.raw === true || !isRecord(value) || !Array.isArray(value.data)) return value

  // Every list command validates --fields through the shared option check
  // before its handler runs, and this projection is unreachable for --raw, so a
  // second validation here would repeat one and never perform the other.
  const view = args.full === true ? 'full' : args.fields === undefined ? 'summary' : 'selected'
  const fields = listViewColumns(kind, args)
  const meta = isRecord(value.meta) ? value.meta : {}

  return {
    ...value,
    data: value.data.map(resource => projectResource(resource, fields)),
    meta: { ...meta, view }
  }
}
