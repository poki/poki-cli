import { listCapabilities } from '../../list-capabilities'
import type { CommandSpecBuilder } from './types'

export function addPlaytestRecordingCommandSpecs ({ apiAction, argument, collectionGetBehavior, dataOption, example, gameOption, group, listOptionsFor, mutationOptions, option, outputOptions, requestMutationOptions }: CommandSpecBuilder): void {
  group('playtest-recordings', 'List, inspect, assess, archive, and mark recordings watched.')
  apiAction(['playtest-recordings', 'list'], 'List recordings for a game.', { method: 'GET', path: '/games/:gameID/playtest-recordings', contacts_api: true }, ['can_read_owned_playtest_recordings'], { options: [gameOption, option('--version', 'string', 'Filter by version ID.'), option('--archived', 'enum', 'active, archived, or all.', { default: 'active', values: ['active', 'archived', 'all'] }), ...listOptionsFor(listCapabilities.playtests)], behavior: ['This endpoint supports filters but returns its complete matching collection in one response; sorting and pagination options do not exist.', 'Every normalized recording includes CLI-derived video_url and metadata_json_url. With --raw, the same values are added to each valid recording resource attributes object while all other backend fields and the JSON:API document shape are preserved.'], examples: [example('poki playtest-recordings list --version VERSION_ID --archived all', 'Return every visible recording for one version, including its video and metadata JSON URLs.'), example('poki playtest-recordings list --filter device_category=mobile --fields id,duration,device_category,video_url,metadata_json_url', 'Filter and project the complete matching collection with its recording assets.')] })
  apiAction(['playtest-recordings', 'get'], 'Get one recording with stable video and metadata URLs.', { method: 'GET', path: '/games/:gameID/playtest-recordings?filter[playtest_recordings.id]', contacts_api: true }, ['can_read_owned_playtest_recordings'], { arguments: [argument('recording-id', 'Recording ID.')], options: [gameOption, ...outputOptions], behavior: [collectionGetBehavior, 'Normalized output includes CLI-derived video_url and metadata_json_url. With --raw, the filtered backend collection shape is preserved and both values are added to each valid recording resource attributes object.'], missing_input: 'a recording ID' })
  apiAction(['playtest-recordings', 'update'], 'Replace a recording tag list.', { method: 'PATCH', path: '/games/:gameID/playtest-recordings/:recordingID', contacts_api: true }, ['can_edit_owned_playtests'], { arguments: [argument('recording-id', 'Recording ID.')], options: [gameOption, option('--tag', 'string', 'Tag; repeatable.', { repeatable: true }), option('--clear-tags', 'boolean', 'Replace the tag list with an empty list.', { default: false, conflicts: ['--tag', '--data'] }), dataOption, ...mutationOptions], behavior: ['Tags are replaced as a complete list: --tag sets it and --clear-tags empties it. An update supplying neither --tag, --clear-tags, nor --data is rejected instead of silently clearing tags.'], missing_input: 'a recording ID and a tag operation', examples: [example('poki playtest-recordings update RECORDING_ID --tag onboarding --dry-run', 'Preview replacing the tag list with one tag.')] })
  apiAction(
    ['playtest-recordings', 'skip-assessment'],
    'Clear assessment tags and permanently mark an assessment skipped.',
    { method: 'PATCH', path: '/games/:gameID/playtest-recordings/:recordingID', contacts_api: true },
    ['can_edit_owned_playtests'],
    {
      arguments: [argument('recording-id', 'Recording ID.')],
      options: [gameOption, ...mutationOptions],
      risk: 'destructive',
      destructive: true,
      behavior: ['Sends tags: [] and skipped_assessment: true, matching the developer UI workflow. There is no CLI action that reverses skipped_assessment.'],
      side_effects: ['Clears assessment tags and permanently records that assessment was skipped.'],
      missing_input: 'a recording ID',
      examples: [example('poki playtest-recordings skip-assessment RECORDING_ID --dry-run', 'Preview the one-way assessment decision.')]
    }
  )
  for (const actionName of ['archive', 'unarchive', 'watch'] as const) {
    apiAction(['playtest-recordings', actionName], `${actionName[0].toUpperCase()}${actionName.slice(1)} a recording.`, { method: 'POST', path: `/games/:gameID/playtest-recordings/:recordingID/@${actionName}`, contacts_api: true }, ['can_read_owned_playtest_recordings'], { arguments: [argument('recording-id', 'Recording ID.')], options: [gameOption, ...requestMutationOptions], missing_input: 'a recording ID', ...(actionName === 'watch' ? { behavior: ['The backend exposes no inverse unwatch operation.'] } : {}) })
  }
}
