export interface ServiceEnvironment {
  apiUrl: string
  authUrl: string
  signInUrl: string
  legacyUploadHostname: string
  legacyUploadHost: string
  configScope?: string
}

const production: ServiceEnvironment = {
  apiUrl: 'https://devs-api.poki.io',
  authUrl: 'https://auth.poki.io',
  signInUrl: 'https://app.poki.dev/signin/',
  legacyUploadHostname: '34.111.107.149',
  legacyUploadHost: 'devs-api.poki.io'
}

const acceptance: ServiceEnvironment = {
  apiUrl: 'https://devs-api-acceptance.poki.io',
  authUrl: 'https://auth-acceptance.poki.io',
  signInUrl: 'https://acceptance.devs-app.pages.dev/signin/',
  legacyUploadHostname: '34.102.180.200',
  legacyUploadHost: 'devs-api-acceptance.poki.io',
  configScope: 'acceptance'
}

export function serviceEnvironment (environment: NodeJS.ProcessEnv = process.env): ServiceEnvironment {
  return environment.SERVICE_ENV === 'acceptance' ? acceptance : production
}
