import { homedir } from 'os'
import { join } from 'path'

export function getConfigDir () {
  const defaultConfigDir = join(homedir(), '.config', 'poki')

  if (process.platform === 'win32') {
    return process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Poki') : defaultConfigDir
  } else if (process.env.XDG_CONFIG_HOME) {
    return join(process.env.XDG_CONFIG_HOME, 'poki')
  } else {
    return defaultConfigDir
  }
}

export type Config = {
	game_id?: string;
	build_dir?: string;
	access_token?: string;
	refresh_token?: string;
}
