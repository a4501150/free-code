import * as teamMemPathsMod from '../../memdir/teamMemPaths.js'
import * as secretScannerMod from './secretScanner.js'

/**
 * Check if a file write/edit to a team memory path contains secrets.
 * Returns an error message if secrets are detected, or null if safe.
 *
 * This is called from FileWriteTool and FileEditTool validateInput to
 * prevent the model from writing secrets into team memory files, which
 * would be synced to all repository collaborators.
 *
 * Callers can import and call this unconditionally.
 * secretScanner assembles sensitive prefixes at runtime (ANT_KEY_PFX).
 */
export function checkTeamMemSecrets(
  filePath: string,
  content: string,
): string | null {
  const { isTeamMemPath } = teamMemPathsMod
  const { scanForSecrets } = secretScannerMod

  if (!isTeamMemPath(filePath)) {
    return null
  }

  const matches = scanForSecrets(content)
  if (matches.length === 0) {
    return null
  }

  const labels = matches.map(m => m.label).join(', ')
  return (
    `Content contains potential secrets (${labels}) and cannot be written to team memory. ` +
    'Team memory is shared with all repository collaborators. ' +
    'Remove the sensitive content and try again.'
  )
}
