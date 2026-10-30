import type { CommandSpecBuilder } from './types'

export function addCategoryCommandSpecs ({ apiAction, example, group, requestOptions }: CommandSpecBuilder): void {
  group('categories', 'Live content categories.')
  apiAction(['categories', 'list'], 'List current Poki content categories.', { method: 'GET', path: '/categories', contacts_api: true }, ['can_read_self'], {
    options: requestOptions,
    behavior: [
      'Returns the complete category list without pagination. Requires authentication.',
      'Use title values for games update --suggested-category. category_type is returned as supplied by the backend.',
      'This endpoint does not report test-targeting eligibility. Use poki audiences list --testing-only for the bundled Playtest and Player Fit targeting snapshot.'
    ],
    examples: [example('poki categories list --format json', 'Discover current category titles for games update.')],
    output: { shape: '{data: [{id, title, category_type}], meta: {total}}' }
  })
}
