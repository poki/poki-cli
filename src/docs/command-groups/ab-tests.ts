import { listCapabilities } from '../../list-capabilities'
import type { CommandSpecBuilder } from './types'

export function addABTestCommandSpecs ({ apiAction, argument, dataOption, example, gameOption, group, listOptionsFor, mutationOptions, option, outputOptions, requestMutationOptions }: CommandSpecBuilder): void {
  for (const thumbnail of [false, true]) {
    const command = thumbnail ? 'thumbnail-ab-tests' : 'game-ab-tests'
    const resource = thumbnail ? 'game_thumbnail_ab_tests' : 'ab_tests'
    const path = `/games/:gameID/${resource}`
    const read = thumbnail ? 'can_read_owned_game_thumbnail_ab_tests' : 'can_read_owned_ab_tests'
    const edit = thumbnail ? 'can_edit_owned_game_thumbnail_ab_tests' : 'can_edit_owned_ab_tests'
    const permissionLogic = (code: string): string => `${code} AND the game belongs to the authenticated user or their team; alternatively the backend accepts the corresponding grant covering all games. Team feature flags affect effective grants. Resource eligibility and lifecycle checks still apply.`
    const capabilities = thumbnail ? listCapabilities.thumbnailABTests : listCapabilities.gameABTests
    group(command, `Manage ${thumbnail ? 'thumbnail' : 'game version'} A/B tests.`, ['Commands are always visible; the backend enforces permissions, ownership, release eligibility, and lifecycle constraints.'])
    apiAction([command, 'list'], 'List tests and results.', { method: 'GET', path, contacts_api: true }, [read], { permission_logic: permissionLogic(read), options: [gameOption, ...listOptionsFor(capabilities)], behavior: ['Supports filters; the backend returns the entire collection without pagination or sorting. Use --full to include all result metrics.'] })
    apiAction([command, 'get'], 'Inspect a test and all its result metrics.', { method: 'GET', path: `${path}/:testID`, contacts_api: true }, [read], { permission_logic: permissionLogic(read), arguments: [argument('test-id', 'A/B test ID.')], options: [gameOption, ...outputOptions] })
    for (const create of [true, false]) {
      const fields = [
        option('--name', 'string', 'Test name; 3-128 UTF-8 bytes.', { required: create ? 'unless --data' : undefined }),
        option('--description', 'string', 'Test description; at most 65535 UTF-8 bytes.', { required: thumbnail && create ? 'unless --data' : undefined }),
        option('--target-sample-size', 'integer', 'Samples per variant; the backend validates the range. On creation zero or omission uses the server default.')
      ]
      if (thumbnail) {
        fields.push(option('--target-sample-type', 'string', 'Sample unit; defaults to clicks on creation.', { values: ['views', 'clicks'] }))
        if (create) fields.push(option('--thumbnail-file', 'path', 'Variant B image, at most 10 MiB. --data instead accepts thumbnail_b as standard padded base64.', { required: 'unless --data' }))
      } else {
        fields.push(option('--version-a-description', 'string', 'Variant A description; --data also accepts null.'), option('--version-b-description', 'string', 'Variant B description; --data also accepts null.'))
        if (create) fields.push(option('--version-a', 'string', 'Processed, non-archived version A ID; --data field version_a_id.', { required: 'unless --data' }), option('--version-b', 'string', 'Distinct processed, non-archived version B ID; --data field version_b_id.', { required: 'unless --data' }), option('--device', 'string', 'Optional device restriction; omitted/null means all devices.', { values: ['desktop', 'mobile', 'tablet'] }))
      }
      apiAction([command, create ? 'create' : 'update'], create ? 'Create a draft experiment.' : 'Update experiment details.', { method: create ? 'POST' : 'PATCH', path: create ? path : `${path}/:testID`, contacts_api: true }, [edit], {
        permission_logic: permissionLogic(edit),
        arguments: create ? undefined : [argument('test-id', 'A/B test ID.')],
        options: [gameOption, ...fields, dataOption, ...mutationOptions],
        behavior: [
          'Field flags and --data are mutually exclusive. Unknown and immutable fields are rejected locally.',
          'Creation makes a draft; starting is a separate operation. Names and descriptions may be edited later, but the backend restricts target changes to drafts.',
          thumbnail ? 'Variant A is the current game thumbnail. Default targets are 1000 clicks or 100000 views. Image contents and game eligibility are validated by the backend. Dry-run omits encoded image data.' : 'Default target is 2000 gameplays per variant. Variant IDs and device are immutable; variant descriptions may only be changed in draft status. Both versions need an approved review unless the caller is an admin or the game team has can_use_unreviewed_versions_in_ab_tests; the backend checks this on creation and start.',
          'A failed or malformed mutation response can have an uncertain outcome. Inspect existing tests before retrying creation.'
        ],
        examples: [example(thumbnail ? `poki ${command} create --name "New thumbnail" --description "Compare artwork" --thumbnail-file thumbnail.png --dry-run` : `poki ${command} create --name "New tutorial" --version-a VERSION_A --version-b VERSION_B --dry-run`, 'Preview creating a draft experiment.')]
      })
    }
    for (const action of ['start', 'stop', 'delete'] as const) {
      const effect = action === 'start' ? 'Starts the experiment and changes live variant exposure.' : action === 'delete' ? 'Deletes a draft; active experiments must be stopped instead.' : thumbnail ? 'Cancels the experiment without applying a winner. Use game-change-requests create --thumbnail-ab-test-id for an eligible completed winner.' : 'Cancels the experiment and restores its pre-test public version, falling back to variant A. You can then run versions activate.'
      apiAction([command, action], `${action} an experiment.`, { method: action === 'delete' ? 'DELETE' : 'POST', path: `${path}/:testID${action === 'delete' ? '' : `/@${action}`}`, contacts_api: true }, [edit], {
        permission_logic: permissionLogic(edit),
        arguments: [argument('test-id', 'A/B test ID.')],
        options: [gameOption, ...requestMutationOptions],
        risk: 'destructive',
        destructive: true,
        side_effects: [effect],
        behavior: ['Requires --yes for execution; --dry-run performs no network requests. Backend lifecycle and permission checks remain authoritative.', ...(!thumbnail && action === 'start' ? ['Both versions need an approved review unless the caller is an admin or the game team has can_use_unreviewed_versions_in_ab_tests. Eligibility is checked again when starting a draft.'] : [])],
        examples: [example(`poki ${command} ${action} TEST_ID --yes`, effect)]
      })
    }
  }
}

export function addWebFitTestCommandSpecs ({ apiAction, gameOption, group, option, requestMutationOptions }: CommandSpecBuilder): void {
  group('web-fit-tests', 'Request Web Fit testing.')
  apiAction(['web-fit-tests', 'request'], 'Request Web Fit for a game version.', { method: 'POST', path: '/games/:gameID/_webfit', contacts_api: true }, ['can_request_web_fit_test'], {
    permission_logic: 'can_request_web_fit_test AND the game belongs to the authenticated user or their team; alternatively the backend accepts a grant to edit all games. Resource eligibility, quotas, and cooldown checks still apply.',
    options: [gameOption, option('--version', 'string', 'Version ID to test.', { required: true }), option('--golden-ticket', 'boolean', 'Use the team golden ticket; backend eligibility and cooldown apply.', { default: false }), ...requestMutationOptions],
    risk: 'destructive',
    destructive: true,
    behavior: ['Sends plain JSON with version_id and golden_ticket. The backend returns an empty success response; normalized output reports requested: true, not test completion.', 'Requires --yes; --dry-run is offline. The backend checks ownership, content moderation (pass required for unapproved games), archived state, an existing Web Fit request, quotas, and golden-ticket cooldown.'],
    side_effects: ['Changes game testing state, replaces all tracks with the selected version at 100% public traffic, and notifies the Poki team. May consume a golden ticket.']
  })
}
