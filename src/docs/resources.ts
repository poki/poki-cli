import { RESOURCE_API_TIME_ZONE } from '../timezones'

export type RelationshipResourceApiType =
  'games' |
  'game_versions' |
  'playtest_requests' |
  'player_fit_tests' |
  'reviews' |
  'teams' |
  'users'

export interface ResourceFieldDocumentation {
  name: string
  type: string
  access: string
  description: string
  relationshipApiTypes?: readonly RelationshipResourceApiType[]
}

export type ResourceFieldMutability = 'read_only' | 'editable' | 'create_only' | 'computed'

export interface ResourceFieldIndexEntry {
  name: string
  type: string
  nullable: boolean
  mutability: ResourceFieldMutability
  relationship: boolean
  source: 'api' | 'cli'
  encoding?: 'unix_seconds'
  summary: string
}

export interface ResourceDocumentation {
  command: string
  resource: string
  fields: ResourceFieldDocumentation[]
  references: Array<{ title: string, url: string }>
}

const supplementalDetails: Record<string, {
  enum_values?: string[]
  unit?: string
  input_behavior?: string
  interpretation?: string
}> = {
  'games.public_version': { input_behavior: 'Not editable through games update; versions activate changes the public version. tracks remain the authoritative traffic allocation.' },
  'games.annotations': { input_behavior: 'Developer mutations accept only engine. The server preserves existing annotation keys and never removes them.' },
  'games.tracks': { input_behavior: 'Not editable through games update. versions activate replaces the allocation with one public track, and the backend rejects activation while multiple tracks already exist. Weights within each track must total 100.' },
  'games.cached_median_download_size': { unit: 'bytes' },
  'games.content_moderation_status': { enum_values: ['pending', 'pass', 'fail', 'defer'] },
  'games.suggested_categories': { interpretation: 'Use category names from poki audiences list. Numeric IDs are only for Playtest and Player Fit audience targeting.' },
  'versions.state': { enum_values: ['created', 'accepting', 'validating', 'uploading', 'processing', 'optimizing', 'done', 'error'] },
  'versions.cached_latest_review_status': { enum_values: ['pending', 'approved', 'rejected', 'closed'] },
  'version-activations.activated_at': { interpretation: 'Activation events are chronological point events, not interval boundaries. Split allocations and other track transitions may be absent, so adjacent events do not prove continuous version state.' },
  'version-activations.deactivated_at': { interpretation: 'Derived from the next stored activation event; null means no later stored event exists. It is not a stored or observed deactivation, so neither a value nor null proves a continuous version state.' },
  'version-activations.activated_by': { interpretation: 'Null means the stored activation event has no actor.' },
  'versions.flags': {
    enum_values: ['image-compression-disabled', 'transforms-disabled'],
    interpretation: 'Comma-separated combination of the listed members, derived at upload time from upload --disable-image-compression and --disable-transforms; the flags cannot be patched afterward.'
  },
  'playtest-recordings.device_category': { enum_values: ['mobile', 'tablet', 'desktop'] },
  'playtest-recordings.duration': { unit: 'seconds' },
  'playtest-recordings.requested_orientation': { enum_values: ['both', 'portrait', 'landscape'] },
  'playtest-recordings.video_url': { interpretation: 'Derived locally from the recording ID for list and get. In --raw output it is added to each recording resource attributes object rather than supplied by the API.' },
  'playtest-recordings.metadata_json_url': { interpretation: 'Derived locally from the recording ID for list and get. In --raw output it is added to each recording resource attributes object rather than supplied by the API.' },
  'playtest-requests.device_category': { enum_values: ['any', 'desktop', 'mobile'] },
  'playtest-requests.categories': { interpretation: 'Numeric Poki content-category IDs; run poki audiences list --testing-only for the bundled categories enabled for test targeting.' },
  'playtest-requests.orientation': { enum_values: ['both', 'portrait', 'landscape'] },
  'playtest-requests.recordings': { unit: 'recordings' },
  'playtest-requests.pending': { unit: 'recordings', interpretation: 'Playtest requests have no status field: recordings plus pending is the outstanding remainder, so a request is finished only once both reach 0, and the backend then deletes it just as it does on cancellation.' },
  'player-fit-tests.device_category': { enum_values: ['any', 'desktop', 'mobile'] },
  'player-fit-tests.categories': { interpretation: 'Numeric Poki content-category IDs; run poki audiences list --testing-only for the bundled categories enabled for test targeting.' },
  'player-fit-tests.orientation': { enum_values: ['both', 'portrait', 'landscape'] },
  'player-fit-tests.status': {
    enum_values: ['running', 'completed', 'timed_out', 'stopped'],
    interpretation: 'Computed on read rather than stored: running while the test has not stopped, completed when gameplays reached target_gameplays, timed_out when the test stopped with zero gameplays after at least 4 hours, and stopped otherwise.'
  },
  'player-fit-tests.target_gameplays': { unit: 'gameplays', input_behavior: 'Fixed by the CLI at 500 and cannot be overridden; the server default is 500 and the server maximum is 10000.' },
  'player-fit-tests.gameplays': { unit: 'gameplays' },
  'player-fit-tests.engagement': { unit: 'seconds per gameplay' },
  'player-fit-tests.median_engagement': { unit: 'seconds' },
  'player-fit-tests.durations': { unit: 'seconds' },
  'player-fit-tests.fps_average': { unit: 'frames per second' },
  'player-fit-tests.fps_median': { unit: 'frames per second' },
  'player-fit-tests.fps_p95': { unit: 'frames per second' },
  'reviews.status': { enum_values: ['pending', 'approved', 'rejected', 'closed'] },
  'reviews.queue_time': { interpretation: 'Timestamp at which the review entered the queue; serialized as Unix seconds.' },
  'game-change-requests.status': { enum_values: ['pending', 'approved', 'rejected', 'cancelled'] },
  'game-events.action': { interpretation: 'Carries the SDK measure(category, what, action) what value; the legacy API field name is intentional.' },
  'game-events.label': { interpretation: 'Carries the SDK measure(category, what, action) action value; the legacy API field name is intentional.' },
  'game-events.enabled': { input_behavior: 'Not accepted on create; the backend always creates event definitions with enabled true.' },
  'game-events.include_in_funnel': { input_behavior: 'Not accepted on create; the backend always creates event definitions with include_in_funnel true.' },
  'game-event-funnels.events': {
    input_behavior: 'Repeated --event strings preserve argument order; updates replace the complete ordered list. Use dbt_p4d_game_events_funnel_v2.event values verbatim.',
    interpretation: "Each key uses category^what^action with '^' as the reserved separator. The analytics model emits both separators, including a trailing '^' when action is empty, and lowercases special action values."
  },
  'player-feedback-questions.status': { enum_values: ['pending', 'processing', 'completed', 'failed'] },
  'player-feedback-questions.start_date': { unit: 'Unix seconds', input_behavior: 'The CLI converts UTC YYYY-MM-DD dates to Unix seconds; integer Unix timestamps pass through unchanged.' },
  'player-feedback-questions.end_date': { unit: 'Unix seconds', input_behavior: 'The CLI converts UTC YYYY-MM-DD dates to Unix seconds; the end date must not precede start_date.' },
  'player-feedback-questions.feedback_message_types': { enum_values: ['thumbs_up', 'thumbs_down', 'bugreport'] }
}

const field = (
  name: string,
  type: string,
  access: string,
  description: string,
  relationshipApiTypes?: readonly RelationshipResourceApiType[]
): ResourceFieldDocumentation => ({
  name,
  type,
  access,
  description,
  ...(relationshipApiTypes === undefined ? {} : { relationshipApiTypes })
})

export const gamesDocumentation: ResourceDocumentation = {
  command: 'games',
  resource: 'game',
  fields: [
    field('type', 'string', 'read-only', 'JSON:API resource type; normally games.'),
    field('id', 'string', 'read-only', 'Stable Poki for Developers game ID.'),
    field('title', 'string', 'create-only; change-request-only afterward', 'Game title, between 3 and 128 characters. Developer updates are rejected; use game-change-requests create after creation.'),
    field('team_id', 'string', 'create-only', 'ID of the team that owns the game. Developers select it on create but cannot reassign an existing game.'),
    field('uploader_id', 'string', 'read-only', 'ID of the user who originally uploaded or created the game.'),
    field('public_version', 'string', 'read-only', 'Version ID currently selected as public; use versions activate for the supported developer activation workflow.'),
    field('approved', 'boolean', 'read-only', 'Whether the game is approved; developers can read but not change this value.'),
    field('privacy_policy_url', 'string', 'editable', 'Public URL of the game privacy policy.'),
    field('custom_content_security_policy', 'string', 'read-only', 'Server-managed Content Security Policy for the game build.'),
    field('thumbnail_url', 'string', 'read-only', 'Public URL of the current processed thumbnail.'),
    field('annotations', 'object', 'editable', 'Game metadata map. Developer mutations accept only engine, containing 2 through 32 lowercase letters, digits, or hyphens; the server preserves all existing keys and never removes annotations.'),
    field('suggested_description', 'string', 'editable', 'Developer-proposed public description.'),
    field('suggested_categories', 'string', 'editable', 'Comma-separated Poki content-category names proposed by the developer; use the name values from poki audiences list. Playtest and Player Fit targeting use numeric IDs instead.'),
    field('tracks', 'array<object>', 'read-only', 'Traffic allocation entries containing track, version_id, and weight. versions activate supports games with at most one existing track and replaces the allocation with one public track.'),
    field('content_metadata', 'object|null', 'read-only', 'Current content and distribution metadata when supplied by the endpoint.'),
    field('has_upload_token', 'boolean', 'read-only', 'Whether an upload token exists; the token value is never returned.'),
    field('has_auds_token', 'boolean', 'read-only', 'Internal Poki platform integration indicator; read-only and not actionable through the CLI. The token value is never returned.'),
    field('cached_has_revshare', 'boolean', 'computed read-only', 'Cached indication that the game currently has revenue sharing.'),
    field('cached_revshare_special_conditions', 'string', 'computed read-only', 'Cached special revenue-share conditions.'),
    field('cached_has_external_gameplays', 'boolean', 'computed read-only', 'Cached indication that external gameplays have been observed.'),
    field('cached_median_download_size', 'integer', 'computed read-only', 'Cached median game download size in bytes.'),
    field('playtest_recordings_unwatched', 'integer|null', 'computed read-only', 'Number of role-visible playtest recordings not yet watched by the current user.'),
    field('playtest_recordings_watched', 'integer|null', 'computed read-only', 'Number of role-visible playtest recordings watched by the current user.'),
    field('content_moderation_status', 'string enum|null', 'computed read-only', 'Latest content-moderation status: pending, pass, fail, or defer. Derived from the latest moderation record for the game and absent when the game has none; a new version upload reopens defer to pending.'),
    field('needs_ads_txt_update', 'boolean', 'read-only', 'Whether the game currently requires an ads.txt-related update.'),
    field('uses_auds', 'boolean', 'computed read-only', 'Internal Poki platform integration indicator; read-only and not actionable through the CLI.'),
    field('uses_netlib', 'boolean', 'computed read-only', 'Internal Poki platform integration indicator; read-only and not actionable through the CLI.'),
    field('created_at', 'timestamp', 'read-only', 'UTC server timestamp at which the game was created.'),
    field('updated_at', 'timestamp', 'read-only', 'UTC server timestamp of the latest game update.'),
    field('uploader', 'user relationship', 'read-only relationship', 'Uploader expanded when included, otherwise retained as a {type, id} identifier.', ['users']),
    field('team', 'team relationship', 'create-only relationship', 'Owning team expanded when included, otherwise retained as a {type, id} identifier.', ['teams']),
    field('versions', 'array<game version relationship>', 'read-only relationship', 'Versions supplied with the game, expanded when included.', ['game_versions']),
    field('playtest_requests', 'array<playtest request relationship>', 'read-only relationship', 'Active role-visible playtest requests supplied with the game.', ['playtest_requests']),
    field('player_fit_tests', 'array<Player Fit test relationship>', 'read-only relationship', 'Player Fit tests supplied with the game.', ['player_fit_tests'])
  ],
  references: [
    { title: 'Poki for Developers', url: 'https://sdk.poki.com/p4d' },
    { title: 'Game Thumbnails', url: 'https://sdk.poki.com/game-thumbnail' }
  ]
}

export const versionsDocumentation: ResourceDocumentation = {
  command: 'versions',
  resource: 'game version',
  fields: [
    field('type', 'string', 'read-only', 'JSON:API resource type; normally game_versions.'),
    field('id', 'string', 'read-only', 'Stable version ID.'),
    field('game_id', 'string', 'read-only', 'ID of the parent game.'),
    field('filename', 'string', 'editable', 'Uploaded archive filename shown by Poki for Developers.'),
    field('label', 'string', 'editable', 'Optional human-readable version label, with a maximum length of 256 characters.'),
    field('notes', 'string', 'editable', 'Free-text version description or release notes; there is no separate description field.'),
    field('cached_latest_review_status', 'string enum|null', 'computed read-only', 'Cached status of the latest review: pending, approved, rejected, or closed; null when the version has no review. The server forces it to closed on a version whose pending review was superseded by a newer review.'),
    field('inspector_checklist', 'object|null', 'computed read-only', 'Inspector results keyed by check name when the endpoint supplies them.'),
    field('state', 'string enum', 'read-only', 'Processing state: created, accepting, validating, uploading, processing, optimizing, done, or error.'),
    field('progress', 'integer', 'read-only', 'Server-reported processing progress.'),
    field('flags', 'string', 'read-only', 'Comma-separated version flags whose only possible members are image-compression-disabled and transforms-disabled. Derived at upload time from upload --disable-image-compression and --disable-transforms; the flags cannot be patched afterward.'),
    field('created_at', 'timestamp', 'read-only', 'UTC server timestamp at which the version was created.'),
    field('updated_at', 'timestamp', 'read-only', 'UTC server timestamp of the latest version update.'),
    field('archived_at', 'timestamp|null', 'read-only', 'UTC archive timestamp; null means the version is active.'),
    field('activated_at', 'timestamp|null', 'computed read-only', 'Most recent UTC activation time when this version is currently live. Use poki version-activations list --all for the stored point-event history.'),
    field('url', 'string', 'computed read-only', 'Preview URL for the processed version.'),
    field('reviews', 'array<review relationship>', 'read-only relationship', 'Reviews expanded when included, otherwise retained as resource identifiers.', ['reviews']),
    field('game', 'game relationship', 'read-only relationship', 'Parent game when supplied by the endpoint.', ['games']),
    field('activated_by', 'user relationship', 'computed read-only relationship', 'User responsible for the current activation when supplied.', ['users'])
  ],
  references: [
    { title: 'Poki for Developers', url: 'https://sdk.poki.com/p4d' },
    { title: 'SDK versioning with the CLI', url: 'https://sdk.poki.com/sdk-documentation#versioning-with-cli' }
  ]
}

export const versionActivationsDocumentation: ResourceDocumentation = {
  command: 'version-activations',
  resource: 'game version activation',
  fields: [
    field('type', 'string', 'read-only', 'JSON:API resource type; normally game_version_activations.'),
    field('id', 'string', 'read-only', 'Stable activation-event ID.'),
    field('game_id', 'string', 'read-only', 'ID of the game whose public version changed.'),
    field('version_id', 'string', 'read-only', 'ID of the version activated by this event.'),
    field('activated_at', 'timestamp', 'read-only', 'UTC server timestamp at which the version was activated.'),
    field('deactivated_at', 'timestamp|null', 'computed read-only', 'UTC timestamp of the next stored activation event; null when no later stored activation exists.'),
    field('activated_by', 'user relationship|null', 'read-only relationship', 'User responsible for the activation when stored; null when no actor was recorded.', ['users'])
  ],
  references: [
    { title: 'SDK versioning with the CLI', url: 'https://sdk.poki.com/sdk-documentation#versioning-with-cli' }
  ]
}

export const playtestsDocumentation: ResourceDocumentation = {
  command: 'playtest-recordings',
  resource: 'playtest recording',
  fields: [
    field('type', 'string', 'read-only', 'JSON:API resource type; normally playtest_recordings.'),
    field('id', 'string', 'read-only', 'Stable recording ID used to derive the video and metadata URLs.'),
    field('game_id', 'string', 'read-only', 'ID of the recorded game.'),
    field('version_id', 'string', 'read-only', 'ID of the recorded game version.'),
    field('country_id', 'string', 'read-only', 'Two-letter country code associated with the tester.'),
    field('useragent', 'string', 'read-only', 'Raw browser User-Agent captured for the recording.'),
    field('browser', 'string', 'read-only', 'Parsed browser name and version summary.'),
    field('os', 'string', 'read-only', 'Parsed operating-system summary.'),
    field('device_category', 'string enum', 'read-only', 'Device category derived from the tester user agent: mobile, tablet, or desktop. Recordings can report tablet even though playtest requests only target any, desktop, or mobile.'),
    field('duration', 'integer', 'read-only', 'Recording duration in seconds.'),
    field('gameplay_starts', 'integer', 'read-only', 'Number of gameplayStart events observed during the recording.'),
    field('rewarded_breaks', 'integer', 'read-only', 'Number of rewarded-break events observed during the recording.'),
    field('webgl_renderer', 'string', 'read-only', 'Reported WebGL renderer or GPU description.'),
    field('sdk_version', 'string', 'read-only', 'Poki SDK version reported by the recorded build.'),
    field('cpus', 'integer', 'read-only', 'Browser-reported logical processor count.'),
    field('device_pixel_ratio', 'number', 'read-only', 'Browser device-pixel ratio.'),
    field('resolution', 'string', 'read-only', 'Recorded viewport or display resolution.'),
    field('watched', 'boolean', 'computed read-only', 'Whether the current user has watched this recording.'),
    field('tags', 'array<string>', 'editable', 'Assessment tags attached to the recording; update replaces the complete list.'),
    field('skipped_assessment', 'boolean', 'editable one-way', 'Whether assessment was explicitly skipped. skip-assessment sets it true and the CLI exposes no reversal.'),
    field('playtest_request_id', 'string|null', 'read-only', 'Request that produced this recording, when available.'),
    field('requested_categories', 'string', 'read-only', 'Comma-separated category IDs requested for the tester audience.'),
    field('requested_orientation', 'string enum', 'read-only', 'Requested orientation: both, portrait, or landscape.'),
    field('requested_new_users_only', 'boolean', 'read-only', 'Whether the originating request targeted only new users.'),
    field('created_at', 'timestamp', 'read-only', 'UTC server timestamp at which the recording was created.'),
    field('updated_at', 'timestamp', 'read-only', 'UTC server timestamp of the latest recording update.'),
    field('archived_at', 'timestamp|null', 'read-only', 'UTC archive timestamp; null means the recording is active.'),
    field('version', 'game version relationship', 'read-only relationship', 'Recorded version expanded when included.', ['game_versions']),
    field('video_url', 'string', 'CLI-computed read-only', 'Stable Google Cloud Storage URL of the WebM recording, included by both list and get.'),
    field('metadata_json_url', 'string', 'CLI-computed read-only', 'Stable Google Cloud Storage URL of the recording metadata JSON, included by both list and get.')
  ],
  references: [
    { title: 'Poki Playtesting', url: 'https://sdk.poki.com/playtesting' }
  ]
}

export const playtestRequestsDocumentation: ResourceDocumentation = {
  command: 'playtest-requests',
  resource: 'playtest request',
  fields: [
    field('type', 'string', 'read-only', 'JSON:API resource type; normally playtest_requests.'),
    field('id', 'string', 'read-only', 'Stable playtest-request ID.'),
    field('game_id', 'string', 'create-only', 'ID of the game being tested.'),
    field('version_id', 'string', 'create-only', 'ID of the game version being recorded.'),
    field('recordings', 'integer', 'create-only', 'Recordings not started yet. Set to the requested 1 through 10 at creation, then counted down as recruited players begin recording.'),
    field('pending', 'integer', 'computed read-only', 'Recordings currently in progress, counted down again as each one is delivered. Playtest requests have no status field: recordings plus pending is the outstanding remainder, delivered recordings appear in neither field, and a fully delivered or cancelled request disappears from the collection.'),
    field('device_category', 'string enum', 'create-only', 'Audience device category: any, desktop, or mobile.'),
    field('categories', 'string', 'create-only', 'Comma-separated numeric category IDs for audience targeting.'),
    field('orientation', 'string enum', 'create-only', 'Audience orientation: both, portrait, or landscape.'),
    field('new_users_only', 'boolean', 'create-only', 'Whether only users new to the game are eligible.'),
    field('normal_tile', 'boolean', 'create-only', 'Whether recruitment uses the normal game tile; requires a thumbnail.'),
    field('created_at', 'timestamp', 'read-only', 'UTC server timestamp at which the request was created.'),
    field('updated_at', 'timestamp', 'read-only', 'UTC server timestamp of the latest request update.'),
    field('version', 'game version relationship', 'read-only relationship', 'Requested version expanded when included.', ['game_versions'])
  ],
  references: [
    { title: 'Poki Playtesting', url: 'https://sdk.poki.com/playtesting' }
  ]
}

export const playerFitTestsDocumentation: ResourceDocumentation = {
  command: 'player-fit-tests',
  resource: 'Player Fit test',
  fields: [
    field('type', 'string', 'read-only', 'JSON:API resource type; normally player_fit_tests.'),
    field('id', 'string', 'read-only', 'Stable Player Fit test ID.'),
    field('game_id', 'string', 'create-only', 'ID of the game being tested.'),
    field('version_id', 'string', 'create-only', 'ID of the tested game version.'),
    field('device_category', 'string enum', 'create-only', 'Audience device category: any, desktop, or mobile.'),
    field('categories', 'string', 'create-only', 'Comma-separated numeric category IDs, with at most five categories.'),
    field('category_only', 'boolean', 'create-only', 'Whether recruitment is restricted to the selected categories.'),
    field('orientation', 'string enum', 'create-only', 'Audience orientation: both, portrait, or landscape.'),
    field('countries', 'string', 'create-only', 'Comma-separated uppercase two-letter country codes.'),
    field('target_gameplays', 'integer', 'create-only', 'Target sample size; the server defaults to 500 gameplays with a maximum of 10000, and the CLI always creates tests with 500.'),
    field('gameplays', 'integer', 'computed read-only', 'Number of completed test gameplays.'),
    field('started', 'integer', 'computed read-only', 'Number of testers who emitted a gameplay start.'),
    field('engagement', 'number', 'computed read-only', 'Average recorded playtime in seconds per gameplay.'),
    field('median_engagement', 'number', 'computed read-only', 'Median recorded playtime in seconds.'),
    field('durations', 'array<integer>', 'computed read-only', 'Individual recorded gameplay durations in seconds, sorted ascending.'),
    field('fps_average', 'number', 'computed read-only', 'Average measured frames per second.'),
    field('fps_median', 'number', 'computed read-only', 'Median measured frames per second.'),
    field('fps_p95', 'number', 'computed read-only', 'Server-reported p95 frames-per-second statistic.'),
    field('upvotes', 'integer', 'computed read-only', 'Positive tester-feedback count.'),
    field('downvotes', 'integer', 'computed read-only', 'Negative tester-feedback count.'),
    field('normal_tile', 'boolean', 'read-only', 'Whether the test recruited through the normal game tile.'),
    field('stopped_at', 'timestamp|null', 'read-only', 'UTC time at which collection stopped; null while the test is still running.'),
    field('created_at', 'timestamp', 'read-only', 'UTC server timestamp at which the test was created.'),
    field('updated_at', 'timestamp', 'read-only', 'UTC server timestamp of the latest test update.'),
    field('status', 'string enum', 'computed read-only', 'Computed test status, never stored: running while the test has not stopped, completed when gameplays reached target_gameplays, timed_out when the test stopped with zero gameplays after at least 4 hours, and stopped otherwise.'),
    field('version', 'game version relationship', 'read-only relationship', 'Tested version expanded when included.', ['game_versions'])
  ],
  references: [
    { title: 'Poki Player Fit', url: 'https://sdk.poki.com/player-fit' }
  ]
}

export const reviewsDocumentation: ResourceDocumentation = {
  command: 'reviews',
  resource: 'review',
  fields: [
    field('type', 'string', 'read-only', 'JSON:API resource type; normally reviews.'),
    field('id', 'string', 'read-only', 'Stable review ID.'),
    field('developer_notes', 'string', 'editable', 'Developer notes for the reviewer; required when requesting a review and replaceable with reviews update.'),
    field('status', 'string enum', 'read-only', 'Review status: pending, approved, rejected, or closed. Reviews start pending, and status only changes from pending; any other transition returns 409. Approved, rejected, and closed are all terminal. Developers can close a pending review with reviews close; approval and rejection are handled by the Poki review workflow. The server also auto-closes a pending review when a newer review is created for the same game.'),
    field('queue_time', 'timestamp', 'computed read-only', 'UTC timestamp at which the review entered the queue, serialized as Unix seconds.'),
    field('seen_by_developer', 'boolean', 'editable', 'Whether the developer has acknowledged the review response; set it with reviews update --seen.'),
    field('report_submitted_at', 'timestamp|null', 'read-only', 'UTC time at which the review report was submitted, when the server provides one.'),
    field('personal_message', 'string', 'read-only', 'Reviewer message returned to the developer with a review decision.'),
    field('report_url', 'string', 'read-only', 'Review report URL returned to the developer when available.'),
    field('changelog_notes', 'object|null', 'read-only', 'Structured review changelog document when supplied by the endpoint. Exposed keys are status, model, engine, engine_tier, baseline_version_id, generated_at, changes, skip_reason, and failure_reason; each changes entry contains summary and confidence.'),
    field('created_by', 'user relationship', 'read-only relationship', 'Creating user expanded by the review endpoints.', ['users']),
    field('created_at', 'timestamp', 'read-only', 'UTC server timestamp at which the review was created.'),
    field('updated_at', 'timestamp', 'read-only', 'UTC server timestamp of the latest review update.'),
    field('version', 'game version relationship', 'read-only relationship', 'Reviewed version expanded when included, otherwise retained as a {type, id} identifier.', ['game_versions']),
    field('report_submitted_by', 'user relationship', 'read-only relationship', 'Report submitter expanded when included.', ['users'])
  ],
  references: [
    { title: 'Poki for Developers', url: 'https://sdk.poki.com/p4d' }
  ]
}

export const gameChangeRequestsDocumentation: ResourceDocumentation = {
  command: 'game-change-requests',
  resource: 'game change request',
  fields: [
    field('type', 'string', 'read-only', 'JSON:API resource type; normally game_change_requests.'),
    field('id', 'string', 'read-only', 'Stable game change request ID.'),
    field('game_id', 'string', 'read-only', 'ID of the game the request changes.'),
    field('status', 'string enum', 'read-only', 'Request status: pending, approved, rejected, or cancelled. Requests start pending; only the creating user can cancel, and only while the request is pending, with game-change-requests cancel. Approval and rejection are handled by the Poki review workflow, and a rejection always carries a personal_message explaining why. Approved, rejected, and cancelled are all terminal.'),
    field('title', 'string', 'create-only', 'Requested public game title, between 3 and 128 characters.'),
    field('thumbnail', 'string', 'create-only', 'Base64-encoded requested thumbnail image accepted on create; responses expose thumbnail_url instead.'),
    field('thumbnail_url', 'string|null', 'read-only', 'URL of the requested thumbnail, when the server supplies one.'),
    field('custom_content_security_policy', 'string', 'create-only', 'Requested custom Content Security Policy; an empty string requests removal of the custom CSP.'),
    field('custom_content_security_policy_reasons', 'object', 'create-only', 'Map of CSP source to justification; each reason contains at most 200 characters.'),
    field('previous_title', 'string', 'read-only', 'Game title before the requested change.'),
    field('previous_thumbnail_url', 'string|null', 'read-only', 'Thumbnail URL before the requested change.'),
    field('previous_custom_content_security_policy', 'string|null', 'read-only', 'Custom Content Security Policy before the requested change.'),
    field('custom_content_security_policy_recommendation', 'string', 'read-only', 'Server-generated recommendation for the requested Content Security Policy.'),
    field('personal_message', 'string', 'read-only', 'Reviewer message returned to the developer with a decision.'),
    field('created_by', 'user relationship', 'read-only relationship', 'Creating user expanded by the list endpoint; only this user can cancel a pending request.', ['users']),
    field('reviewed_by', 'user relationship|null', 'read-only relationship', 'Reviewing user expanded when the server supplies one.', ['users']),
    field('created_at', 'timestamp', 'read-only', 'UTC server timestamp at which the request was created.'),
    field('updated_at', 'timestamp', 'read-only', 'UTC server timestamp of the latest request update.'),
    field('game', 'game relationship', 'read-only relationship', 'Parent game expanded when included, otherwise retained as a {type, id} identifier.', ['games'])
  ],
  references: [
    { title: 'Poki for Developers', url: 'https://sdk.poki.com/p4d' },
    { title: 'Game Thumbnails', url: 'https://sdk.poki.com/game-thumbnail' }
  ]
}

export const gameEventsDocumentation: ResourceDocumentation = {
  command: 'game-events',
  resource: 'game event definition',
  fields: [
    field('type', 'string', 'read-only', 'JSON:API resource type; normally game_events.'),
    field('id', 'string', 'read-only', 'Stable game event definition ID.'),
    field('game_id', 'string', 'read-only', 'ID of the game that owns the event definition.'),
    field('category', 'string', 'editable', "SDK measure category value; 1 through 64 characters and no '/' or '^'."),
    field('action', 'string', 'editable', "SDK measure what value under its legacy API field name; 1 through 64 characters and no '/' or '^'."),
    field('label', 'string', 'editable', "SDK measure action value under its legacy API field name; at most 64 characters and no '/' or '^'."),
    field('description', 'string', 'editable', 'Human-readable purpose, at most 10000 characters; required when creating an event definition.'),
    field('enabled', 'boolean', 'editable', 'Whether analytics exposes the event; the backend creates event definitions with enabled true.'),
    field('include_in_funnel', 'boolean', 'editable', 'Whether funnels may select the event; the backend creates event definitions with include_in_funnel true.'),
    field('created_at', 'timestamp', 'read-only', 'UTC server timestamp at which the event definition was created.'),
    field('updated_at', 'timestamp', 'read-only', 'UTC server timestamp of the latest event definition update.')
  ],
  references: [
    { title: 'Poki Game Events', url: 'https://sdk.poki.com/game-events' }
  ]
}

export const gameEventFunnelsDocumentation: ResourceDocumentation = {
  command: 'game-event-funnels',
  resource: 'game-event funnel',
  fields: [
    field('type', 'string', 'read-only', 'JSON:API resource type; normally game_event_funnels.'),
    field('id', 'string', 'read-only', 'Stable funnel ID.'),
    field('game_id', 'string', 'read-only', 'ID of the game that owns the funnel.'),
    field('team_id', 'string', 'read-only', 'ID of the team that owns the funnel.'),
    field('title', 'string', 'editable', 'Funnel title, between 1 and 128 characters.'),
    field('events', 'array<string>', 'editable', "Ordered list of 1 through 50 event keys from dbt_p4d_game_events_funnel_v2.event. Each key is encoded as category^what^action with '^' reserved as the separator; use the analytics value verbatim. Updates replace the complete list."),
    field('created_by_id', 'string', 'read-only', 'ID of the user who created the funnel.'),
    field('created_at', 'timestamp', 'read-only', 'UTC server timestamp at which the funnel was created.'),
    field('updated_at', 'timestamp', 'read-only', 'UTC server timestamp of the latest funnel update.'),
    field('game', 'game relationship', 'read-only relationship', 'Owning game expanded when included.', ['games']),
    field('team', 'team relationship', 'read-only relationship', 'Owning team expanded when included.', ['teams']),
    field('created_by', 'user relationship', 'read-only relationship', 'Creating user expanded when included.', ['users'])
  ],
  references: [
    { title: 'Poki Game Events', url: 'https://sdk.poki.com/game-events' }
  ]
}

export const playerFeedbackQuestionsDocumentation: ResourceDocumentation = {
  command: 'player-feedback-questions',
  resource: 'player feedback question',
  fields: [
    field('type', 'string', 'read-only', 'JSON:API resource type; normally player_feedback_questions.'),
    field('id', 'string', 'read-only', 'Stable player feedback question ID.'),
    field('game_id', 'string', 'read-only', 'ID of the game whose feedback is analyzed.'),
    field('team_id', 'string', 'read-only', 'Owning team ID supplied by the endpoint.'),
    field('created_by_id', 'string', 'read-only', 'ID of the user who created the question.'),
    field('question', 'string', 'create-only', 'Natural-language question to answer, between 1 and 10000 characters.'),
    field('status', 'string enum', 'computed read-only', 'Asynchronous generation status: pending, processing, completed, or failed.'),
    field('start_date', 'integer', 'create-only', 'Inclusive UTC start date stored as Unix seconds; the CLI converts YYYY-MM-DD input.'),
    field('end_date', 'integer', 'create-only', 'Inclusive UTC end date stored as Unix seconds; must not precede start_date.'),
    field('feedback_message_types', 'array<string>', 'create-only', 'Analyzed feedback types: one or more of thumbs_up, thumbs_down, and bugreport, the exhaustive set enforced at ingestion; no other values exist.'),
    field('feedback_count', 'integer', 'computed read-only', 'Server-reported number of feedback messages covered by the question.'),
    field('response', 'string|null', 'computed read-only', 'Generated answer when status is completed.'),
    field('error', 'string|null', 'read-only', 'Server-reported generation error, when generation failed.'),
    field('model', 'string|null', 'computed read-only', 'Model identifier used to generate the response, when supplied.'),
    field('created_at', 'timestamp', 'read-only', 'UTC server timestamp at which the question was created.'),
    field('updated_at', 'timestamp', 'read-only', 'UTC server timestamp of the latest question update.'),
    field('game', 'game relationship', 'read-only relationship', 'Analyzed game expanded when included.', ['games']),
    field('team', 'team relationship', 'read-only relationship', 'Owning team expanded when included.', ['teams']),
    field('created_by', 'user relationship', 'read-only relationship', 'Creating user expanded when included.', ['users'])
  ],
  references: [
    { title: 'Poki for Developers', url: 'https://sdk.poki.com/p4d' }
  ]
}

export const netlibLobbiesDocumentation: ResourceDocumentation = {
  command: 'netlib-lobbies',
  resource: 'Netlib lobby',
  fields: [
    field('type', 'string', 'read-only', 'JSON:API resource type; normally lobbies.'),
    field('id', 'string', 'read-only', 'Stable response ID formed from the game ID and lobby code.'),
    field('code', 'string', 'read-only', 'Lobby code. Private lobby codes are sensitive connection credentials and should not be published.'),
    field('peer_count', 'integer', 'computed read-only', 'Number of peer records associated with the lobby, including disconnected ghosts.'),
    field('ghosts', 'integer', 'computed read-only', 'Disconnected peers not yet cleaned up; subtract from peer_count for the currently connected peer count.'),
    field('max_players', 'integer', 'read-only', 'Configured maximum number of players.'),
    field('public', 'boolean', 'read-only', 'Whether the lobby is public.'),
    field('has_password', 'boolean', 'computed read-only', 'Whether the lobby requires a password; the password itself is never returned.'),
    field('custom_data', 'JSON value|null', 'read-only', 'Game-defined lobby metadata. Its type and shape are controlled by the game and may differ between lobbies.'),
    field('updated_at', 'timestamp', 'read-only', 'UTC server timestamp of the latest lobby update.'),
    field('created_at', 'timestamp', 'read-only', 'UTC server timestamp at which the lobby was created.')
  ],
  references: [
    { title: 'Poki game development tools', url: 'https://sdk.poki.com/guide/game-dev-tools' }
  ]
}

export const resourceDocumentationRegistry = [
  { kind: 'games', apiType: 'games', documentation: gamesDocumentation },
  { kind: 'versions', apiType: 'game_versions', documentation: versionsDocumentation },
  { kind: 'version-activations', apiType: 'game_version_activations', documentation: versionActivationsDocumentation },
  { kind: 'playtests', apiType: 'playtest_recordings', documentation: playtestsDocumentation },
  { kind: 'playtest-requests', apiType: 'playtest_requests', documentation: playtestRequestsDocumentation },
  { kind: 'player-fit-tests', apiType: 'player_fit_tests', documentation: playerFitTestsDocumentation },
  { kind: 'reviews', apiType: 'reviews', documentation: reviewsDocumentation },
  { kind: 'game-change-requests', apiType: 'game_change_requests', documentation: gameChangeRequestsDocumentation },
  { kind: 'game-events', apiType: 'game_events', documentation: gameEventsDocumentation },
  { kind: 'game-event-funnels', apiType: 'game_event_funnels', documentation: gameEventFunnelsDocumentation },
  { kind: 'player-feedback-questions', apiType: 'player_feedback_questions', documentation: playerFeedbackQuestionsDocumentation },
  { kind: 'netlib-lobbies', apiType: 'lobbies', documentation: netlibLobbiesDocumentation }
] as const satisfies ReadonlyArray<{
  kind: string
  apiType: string
  documentation: ResourceDocumentation
}>

export type DocumentedResourceKind = typeof resourceDocumentationRegistry[number]['kind']

export const resourceDocumentations: readonly ResourceDocumentation[] = resourceDocumentationRegistry
  .map(({ documentation }) => documentation)

function fieldType (type: string): { type: string, nullable: boolean } {
  return type.endsWith('|null')
    ? { type: type.slice(0, -'|null'.length), nullable: true }
    : { type, nullable: false }
}

function mutability (access: string): ResourceFieldMutability {
  if (access.includes('computed')) return 'computed'
  if (access.includes('create-only')) return 'create_only'
  if (access.includes('editable')) return 'editable'
  return 'read_only'
}

export function resourceFieldIndex (documentation: ResourceDocumentation): ResourceFieldIndexEntry[] {
  return documentation.fields.map(field => {
    const normalizedType = fieldType(field.type)
    return {
      name: field.name,
      type: normalizedType.type,
      nullable: normalizedType.nullable,
      mutability: mutability(field.access),
      relationship: (field.relationshipApiTypes?.length ?? 0) > 0,
      source: field.access.includes('CLI-') ? 'cli' : 'api',
      ...(normalizedType.type === 'timestamp' ? { encoding: 'unix_seconds' as const } : {}),
      summary: field.description
    }
  })
}

export function resourceFieldDetails (
  documentation: ResourceDocumentation,
  fieldName: string
): (ResourceFieldIndexEntry & {
    details: string
    enum_values?: string[]
    unit?: string
    time_zone?: string
    input_behavior?: string
    interpretation?: string
    references: Array<{ title: string, url: string }>
  }) | undefined {
  const index = resourceFieldIndex(documentation).find(field => field.name === fieldName)
  if (index === undefined) return undefined
  const original = documentation.fields.find(field => field.name === fieldName)
  if (original === undefined) return undefined
  return {
    ...index,
    details: original.description,
    ...(index.type === 'timestamp' ? { time_zone: RESOURCE_API_TIME_ZONE } : {}),
    ...supplementalDetails[`${documentation.command}.${fieldName}`],
    references: documentation.references
  }
}
