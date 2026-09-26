import { countCharInString } from 'src/utils/stringUtils.js'
import { getPatchFromContents } from '../../utils/diff.js'
import { addLineNumbers } from '../../utils/file.js'

// Wider than the permission-UI default (3): attachment snippets carry more
// surrounding context so the model can re-orient in the edited file.
const SNIPPET_CONTEXT_LINES = 8

/**
 * Strips trailing whitespace from each line in a string while preserving line endings
 * @param str The string to process
 * @returns The string with trailing whitespace removed from each line
 */
export function stripTrailingWhitespace(str: string): string {
  // Handle different line endings: CRLF, LF, CR
  // Use a regex that matches line endings and captures them
  const lines = str.split(/(\r\n|\n|\r)/)

  let result = ''
  for (let i = 0; i < lines.length; i++) {
    const part = lines[i]
    if (part !== undefined) {
      if (i % 2 === 0) {
        // Even indices are line content
        result += part.replace(/\s+$/, '')
      } else {
        // Odd indices are line endings
        result += part
      }
    }
  }

  return result
}

// Cap on edited_text_file attachment snippets. Format-on-save of a large file
// previously injected the entire file per turn (observed max 16.1KB, ~14K
// tokens/session). 8KB preserves meaningful context while bounding worst case.
const DIFF_SNIPPET_MAX_BYTES = 8192

/**
 * Used for attachments, to show snippets when files change.
 * Builds on getPatchFromContents — the single content-based patch engine
 * (with its &/$ escaping workaround) — styled as numbered context blocks.
 */
export function getSnippetForTwoFileDiff(
  fileAContents: string,
  fileBContents: string,
): string {
  const hunks = getPatchFromContents({
    filePath: 'file.txt',
    oldContent: fileAContents,
    newContent: fileBContents,
    contextLines: SNIPPET_CONTEXT_LINES,
  })

  const full = hunks
    .map(_ => ({
      startLine: _.oldStart,
      content: _.lines
        // Filter out deleted lines AND diff metadata lines
        .filter(_ => !_.startsWith('-') && !_.startsWith('\\'))
        .map(_ => _.slice(1))
        .join('\n'),
    }))
    .map(addLineNumbers)
    .join('\n...\n')

  if (full.length <= DIFF_SNIPPET_MAX_BYTES) {
    return full
  }

  // Truncate at the last line boundary that fits within the cap.
  // Marker format matches BashTool/utils.ts.
  const cutoff = full.lastIndexOf('\n', DIFF_SNIPPET_MAX_BYTES)
  const kept =
    cutoff > 0 ? full.slice(0, cutoff) : full.slice(0, DIFF_SNIPPET_MAX_BYTES)
  const remaining = countCharInString(full, '\n', kept.length) + 1
  return `${kept}\n\n... [${remaining} lines truncated] ...`
}
