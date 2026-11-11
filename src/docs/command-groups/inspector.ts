import type { CommandSpecBuilder } from './types'

export function addInspectorCommandSpecs ({ add, example, group, option, uploadMutationOptions }: CommandSpecBuilder): void {
  group('inspector', 'Upload builds for testing in Inspector.')
  add({
    path: ['inspector', 'upload'],
    summary: 'Zip a build directory and return a shareable Inspector URL.',
    network: { method: 'POST', path: 'https://inspector-api.poki.io/v0/builds', contacts_api: true },
    scope: 'local build directory; no game ID or authentication required',
    risk: 'mutation',
    retry_safe: false,
    options: [
      option('--build-dir', 'path', 'Non-empty existing directory; defaults to project build_dir or dist.'),
      option('--disable-transforms', 'boolean', 'Disable upload transforms.', { default: false }),
      ...uploadMutationOptions
    ],
    output: {
      default_format: 'toon',
      formats: ['toon', 'json'],
      shape: { data: '{id, urn, inspector_url, url, root_folder?, size?}', meta: '{}' },
      fields: {
        id: 'Inspector upload ID.',
        urn: 'upload-<id>, used by the Inspector frontend.',
        inspector_url: 'Share this browser URL with the developer to test the build in Inspector.',
        url: 'Direct hosted game entrypoint returned by the backend.',
        root_folder: 'Optional root folder detected inside the ZIP.',
        size: 'Optional uploaded ZIP size in bytes.'
      }
    },
    behavior: [
      'Requires no login, game ID, or project initialization. Uses the production Inspector independently of the developer API environment. No credentials are read or sent.',
      'Uploads a temporary build for Inspector testing. This creates no Poki for Developers version and does not activate public traffic.',
      'Open data.inspector_url in a browser. The CLI never opens a browser automatically.',
      'The request returns after the build is hosted. Image analysis continues in the background; there is no --wait option.',
      'Dry-run validates that build-dir is an accessible non-empty directory, without creating a ZIP or contacting Inspector. Archive validity and backend acceptance remain unvalidated.',
      'The ZIP must be no larger than 1 GiB and contain index.html; the backend detects the archive root and validates its contents. Image compression is always disabled by Inspector.',
      'The upload defaults to a 300000 ms timeout, overridden by POKI_API_TIMEOUT_MS or --timeout-ms.',
      'Each upload creates a new ID. Requests are never automatically retried, including after an HTTP 401. Timeout, network failure, or invalid JSON can leave a completed upload with an unknown ID; no upload-list or idempotency API exists.',
      'If a successful response has a valid ID but malformed build fields, INVALID_API_RESPONSE includes details.created.inspector_url. Open that URL instead of uploading again. --raw also validates the response before returning the backend body unchanged.',
      'Uploads are accessible to anyone with the link. The backend documents a 30-day storage lifetime; no exact expiry timestamp is returned.',
      '--yes is accepted for uniform automation but is not required.'
    ],
    side_effects: ['Uploads a shareable build to Inspector and starts background image analysis.'],
    examples: [
      example('poki inspector upload --dry-run', 'Validate the configured build directory and inspect the upload request.'),
      example('poki inspector upload --format json', 'Upload the configured build and share data.inspector_url with the developer.'),
      example('poki inspector upload --build-dir ./dist --disable-transforms', 'Upload a build with transforms disabled.')
    ]
  })
}
