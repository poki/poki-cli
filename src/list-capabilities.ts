export interface ListCapabilities {
  filter: boolean
  sort: boolean
  pagination: boolean
  filterFields?: readonly string[]
  sortFields?: readonly string[]
}

// Queryable columns are endpoint-specific; response-only fields are not SQL columns.
const gamesFields = 'id title team_id uploader_id approved archived self_service_stage privacy_policy_url custom_content_security_policy play_store_url apple_store_url steam_url annotations internal_notes suggested_description suggested_categories thumbnail_url google_drive_folder_id external_prefix cached_has_revshare cached_revshare_special_conditions cached_has_external_gameplays cached_median_download_size rejection_reasons needs_ads_txt_update needs_privacy_policy_update_reason disable_automated_emails using_golden_ticket cross_promo_revshare_enabled uses_auds uses_netlib uses_dialog created_at updated_at'.split(' ')
const versionsFields = 'id game_id filename label notes cached_latest_review_status state progress flags created_at updated_at archived_at'.split(' ')
const playtestsFields = 'id game_id version_id country_id useragent browser os device_category duration gameplay_starts rewarded_breaks webgl_renderer sdk_version cpus device_pixel_ratio resolution skipped_assessment playtest_request_id state requested_categories requested_orientation requested_new_users_only hidden created_at updated_at archived_at'.split(' ')
const playerFitTestsFields = 'id game_id version_id device_category categories category_only orientation countries target_gameplays gameplays pageviews started engagement fps_average fps_median fps_p95 upvotes downvotes normal_tile hidden stopped_at created_at updated_at status'.split(' ')
const reviewsFields = 'id version_id status queue_time developer_notes internal_notes personal_message report_url report_submitted_at seen_by_developer snoozed_until changelog_notes created_at updated_at'.split(' ')
const gameChangeRequestsFields = 'id game_id title previous_title thumbnail_url previous_thumbnail_url custom_content_security_policy previous_custom_content_security_policy play_store_url previous_play_store_url apple_store_url previous_apple_store_url steam_url previous_steam_url custom_content_security_policy_reasons custom_content_security_policy_recommendation personal_message internal_notes status snoozed_until created_at updated_at'.split(' ')
const gameEventsFields = 'id game_id category action label description enabled include_in_funnel created_at updated_at'.split(' ')
const gameEventFunnelsFields = 'id game_id team_id created_by_id title events created_at updated_at'.split(' ')
const playerFeedbackQuestionsFields = 'id game_id team_id created_by_id question start_date end_date feedback_message_types status response error model feedback_count created_at updated_at'.split(' ')
const netlibLobbiesFields = 'code peer_count ghosts max_players public has_password custom_data updated_at created_at'.split(' ')

// Current Poki for Developers collection capabilities. This is shared by the
// yargs declarations, request builder, and structured help so unsupported
// options cannot be advertised or silently sent to handlers that ignore them.
export const listCapabilities = {
  gameABTests: { filter: true, sort: false, pagination: false, filterFields: ['id', 'name', 'status', 'version_a_id', 'version_b_id', 'created_at'] },
  thumbnailABTests: { filter: true, sort: false, pagination: false, filterFields: ['id', 'name', 'status', 'target_sample_type', 'created_at'] },
  mediaKit: { filter: false, sort: false, pagination: false },
  games: { filter: false, sort: true, pagination: true, sortFields: gamesFields },
  versions: { filter: true, sort: true, pagination: true, filterFields: [...versionsFields, 'track'], sortFields: versionsFields },
  versionActivations: { filter: false, sort: false, pagination: true },
  versionFiles: { filter: false, sort: false, pagination: false },
  playtests: { filter: true, sort: false, pagination: false, filterFields: playtestsFields },
  playerFitTests: { filter: true, sort: false, pagination: false, filterFields: [...playerFitTestsFields, 'gameplay.device_category'] },
  reviews: { filter: true, sort: true, pagination: true, filterFields: [...reviewsFields, 'snoozed'], sortFields: reviewsFields },
  gameChangeRequests: { filter: true, sort: true, pagination: true, filterFields: gameChangeRequestsFields, sortFields: gameChangeRequestsFields },
  gameEvents: { filter: false, sort: true, pagination: true, sortFields: gameEventsFields },
  gameEventFunnels: { filter: false, sort: true, pagination: true, sortFields: gameEventFunnelsFields },
  playerFeedbackQuestions: { filter: false, sort: true, pagination: true, sortFields: playerFeedbackQuestionsFields },
  netlibLobbies: { filter: true, sort: true, pagination: true, filterFields: netlibLobbiesFields, sortFields: netlibLobbiesFields }
} as const satisfies Record<string, ListCapabilities>
