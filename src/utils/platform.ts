import memoize from 'lodash-es/memoize.js'
import { env } from './env.js'
import { getFsImplementation } from './fsOperations.js'
import { logError } from './log.js'

export type Platform = 'macos' | 'windows' | 'wsl' | 'linux' | 'unknown'

export const SUPPORTED_PLATFORMS: Platform[] = ['macos', 'wsl']

export const getPlatform = memoize((): Platform => {
  try {
    if (process.platform === 'darwin') {
      return 'macos'
    }

    if (process.platform === 'win32') {
      return 'windows'
    }

    if (process.platform === 'linux') {
      // Check if running in WSL (Windows Subsystem for Linux)
      try {
        const procVersion = getFsImplementation().readFileSync(
          '/proc/version',
          { encoding: 'utf8' },
        )
        if (
          procVersion.toLowerCase().includes('microsoft') ||
          procVersion.toLowerCase().includes('wsl')
        ) {
          return 'wsl'
        }
      } catch (error) {
        // Error reading /proc/version, assume regular Linux
        logError(error)
      }

      // Regular Linux
      return 'linux'
    }

    // Unknown platform
    return 'unknown'
  } catch (error) {
    logError(error)
    return 'unknown'
  }
})

const VCS_MARKERS: Array<[string, string]> = [
  ['.git', 'git'],
  ['.hg', 'mercurial'],
  ['.svn', 'svn'],
  ['.p4config', 'perforce'],
  ['$tf', 'tfs'],
  ['.tfvc', 'tfs'],
  ['.jj', 'jujutsu'],
  ['.sl', 'sapling'],
]

/**
 * Checks if we're currently running inside iTerm2.
 * Uses multiple detection methods:
 * 1. TERM_PROGRAM env var set to "iTerm.app"
 * 2. ITERM_SESSION_ID env var is present
 * 3. env.terminal detection from utils/env.ts
 */
export const isInITerm2 = memoize((): boolean => {
  const termProgram = process.env.TERM_PROGRAM
  const hasItermSessionId = !!process.env.ITERM_SESSION_ID
  const terminalIsITerm = env.terminal === 'iTerm.app'

  return termProgram === 'iTerm.app' || hasItermSessionId || terminalIsITerm
})
