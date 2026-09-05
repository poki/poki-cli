import { homedir, userInfo } from 'os'
import { isAbsolute, join } from 'path'

import { serviceEnvironment } from './service-environment'

function absoluteDirectory (directory: string | undefined): string | undefined {
  if (directory === undefined || directory.trim() === '' || !isAbsolute(directory)) return undefined
  return directory
}

function absoluteHomeDirectory (): string {
  const home = absoluteDirectory(homedir())
  if (home !== undefined) return home

  const accountHome = absoluteDirectory(userInfo().homedir)
  if (accountHome !== undefined) return accountHome

  throw new Error('Could not determine an absolute home directory for Poki credentials.')
}

export function getConfigDir (environment: NodeJS.ProcessEnv = process.env): string {
  let directory: string
  if (process.platform === 'win32') {
    const localAppData = absoluteDirectory(environment.LOCALAPPDATA)
    directory = localAppData === undefined
      ? join(absoluteHomeDirectory(), '.config', 'poki')
      : join(localAppData, 'Poki')
  } else {
    const xdgConfigHome = absoluteDirectory(environment.XDG_CONFIG_HOME)
    directory = join(xdgConfigHome ?? join(absoluteHomeDirectory(), '.config'), 'poki')
  }

  const scope = serviceEnvironment(environment).configScope
  return scope === undefined ? directory : join(directory, scope)
}

export interface Config {
  game_id?: string
  build_dir?: string
  access_token?: string
  refresh_token?: string
  access_type?: string
}
