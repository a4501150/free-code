import { stat } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import { execFileNoThrow } from './execFileNoThrow.js'
import { logError } from './log.js'

export function getTerminalPlistPath(): string {
  return join(homedir(), 'Library', 'Preferences', 'com.apple.Terminal.plist')
}

export async function backupTerminalPreferences(): Promise<string | null> {
  const terminalPlistPath = getTerminalPlistPath()
  const backupPath = `${terminalPlistPath}.bak`

  try {
    const { code } = await execFileNoThrow('defaults', [
      'export',
      'com.apple.Terminal',
      terminalPlistPath,
    ])

    if (code !== 0) {
      return null
    }

    try {
      await stat(terminalPlistPath)
    } catch {
      return null
    }

    await execFileNoThrow('defaults', [
      'export',
      'com.apple.Terminal',
      backupPath,
    ])

    return backupPath
  } catch (error) {
    logError(error)
    return null
  }
}

type RestoreResult = {
  status: 'no_backup'
}

export async function checkAndRestoreTerminalBackup(): Promise<RestoreResult> {
  return { status: 'no_backup' }
}
