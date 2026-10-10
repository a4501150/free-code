/**
 * Shared command-preview truncation for shell tool use messages
 * (Bash, PowerShell). Pure string logic; callers wrap the result.
 */

import { truncateToWidthNoEllipsis } from '../../utils/truncate.js'

export const MAX_COMMAND_DISPLAY_LINES = 2
export const MAX_COMMAND_DISPLAY_CHARS = 160

/**
 * Cap a command for non-verbose display: first MAX_COMMAND_DISPLAY_LINES
 * lines, then width-capped (grapheme- and CJK-safe). Returns null when the
 * command needs no truncation.
 */
export function truncateCommandForDisplay(command: string): string | null {
  const lines = command.split('\n')
  const needsLineTruncation = lines.length > MAX_COMMAND_DISPLAY_LINES
  const needsCharTruncation = command.length > MAX_COMMAND_DISPLAY_CHARS

  if (!needsLineTruncation && !needsCharTruncation) {
    return null
  }

  let truncated = command
  if (needsLineTruncation) {
    truncated = lines.slice(0, MAX_COMMAND_DISPLAY_LINES).join('\n')
  }
  if (truncated.length > MAX_COMMAND_DISPLAY_CHARS) {
    truncated = truncateToWidthNoEllipsis(truncated, MAX_COMMAND_DISPLAY_CHARS)
  }
  return `${truncated.trim()}…`
}
