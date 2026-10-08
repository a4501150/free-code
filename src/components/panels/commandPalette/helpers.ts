/**
 * Pure typeahead helpers for the slash-command palette — input/token math
 * and suggestion application with no store, React, or host dependencies.
 */
import type { ShellCompletionType } from '../../../utils/bash/shellCompletion.js'
import type { PromptInputMode } from '../../../types/textInputTypes.js'
import type { SuggestionItem } from './types.js'

// Unicode-aware character class for file path tokens:
// \p{L} = letters (CJK, Latin, Cyrillic, etc.)
// \p{N} = numbers (incl. fullwidth)
// \p{M} = combining marks (macOS NFD accents, Devanagari vowel signs)
const AT_TOKEN_HEAD_RE = /^@[\p{L}\p{N}\p{M}_\-./\\()[\]~:]*/u
const PATH_CHAR_HEAD_RE = /^[\p{L}\p{N}\p{M}_\-./\\()[\]~:]+/u
const TOKEN_WITH_AT_RE =
  /(@[\p{L}\p{N}\p{M}_\-./\\()[\]~:]*|[\p{L}\p{N}\p{M}_\-./\\()[\]~:]+)$/u
const TOKEN_WITHOUT_AT_RE = /[\p{L}\p{N}\p{M}_\-./\\()[\]~:]+$/u

/**
 * Extract search token from a completion token by removing @ prefix and quotes
 * @param completionToken The completion token
 * @returns The search token with @ and quotes removed
 */
export function extractSearchToken(completionToken: {
  token: string
  isQuoted?: boolean
}): string {
  if (completionToken.isQuoted) {
    // Remove @" prefix and optional closing "
    return completionToken.token.slice(2).replace(/"$/, '')
  } else if (completionToken.token.startsWith('@')) {
    return completionToken.token.substring(1)
  } else {
    return completionToken.token
  }
}

/**
 * Format a replacement value with proper @ prefix and quotes based on context
 * @param options Configuration for formatting
 * @param options.displayText The text to display
 * @param options.mode The current mode (bash or prompt)
 * @param options.hasAtPrefix Whether the original token has @ prefix
 * @param options.needsQuotes Whether the text needs quotes (contains spaces)
 * @param options.isQuoted Whether the original token was already quoted (user typed @"...)
 * @param options.isComplete Whether this is a complete suggestion (adds trailing space)
 * @returns The formatted replacement value
 */
export function formatReplacementValue(options: {
  displayText: string
  mode: string
  hasAtPrefix: boolean
  needsQuotes: boolean
  isQuoted?: boolean
  isComplete: boolean
}): string {
  const { displayText, mode, hasAtPrefix, needsQuotes, isQuoted, isComplete } =
    options
  const space = isComplete ? ' ' : ''

  if (isQuoted || needsQuotes) {
    // Use quoted format
    return mode === 'bash'
      ? `"${displayText}"${space}`
      : `@"${displayText}"${space}`
  } else if (hasAtPrefix) {
    return mode === 'bash'
      ? `${displayText}${space}`
      : `@${displayText}${space}`
  } else {
    return displayText
  }
}

/**
 * Apply a shell completion suggestion by replacing the current word
 */
export function applyShellSuggestion(
  suggestion: SuggestionItem,
  input: string,
  cursorOffset: number,
  onInputChange: (value: string) => void,
  setCursorOffset: (offset: number) => void,
  completionType: ShellCompletionType | undefined,
): void {
  const beforeCursor = input.slice(0, cursorOffset)
  const lastSpaceIndex = beforeCursor.lastIndexOf(' ')
  const wordStart = lastSpaceIndex + 1

  // Prepare the replacement text based on completion type
  let replacementText: string
  if (completionType === 'variable') {
    replacementText = '$' + suggestion.displayText + ' '
  } else if (completionType === 'command') {
    replacementText = suggestion.displayText + ' '
  } else {
    replacementText = suggestion.displayText
  }

  const newInput =
    input.slice(0, wordStart) + replacementText + input.slice(cursorOffset)

  onInputChange(newInput)
  setCursorOffset(wordStart + replacementText.length)
}

/**
 * Apply a directory/path completion suggestion to the input
 * Always adds @ prefix since we're replacing the entire token (including any existing @)
 *
 * @param input The current input text
 * @param suggestionId The ID of the suggestion to apply
 * @param tokenStartPos The start position of the token being replaced
 * @param tokenLength The length of the token being replaced
 * @param isDirectory Whether the suggestion is a directory (adds / suffix) or file (adds space)
 * @returns Object with the new input text and cursor position
 */
export function applyDirectorySuggestion(
  input: string,
  suggestionId: string,
  tokenStartPos: number,
  tokenLength: number,
  isDirectory: boolean,
): { newInput: string; cursorPos: number } {
  const suffix = isDirectory ? '/' : ' '
  const before = input.slice(0, tokenStartPos)
  const after = input.slice(tokenStartPos + tokenLength)
  // Always add @ prefix - if token already has it, we're replacing
  // the whole token (including @) with @suggestion.id
  const replacement = '@' + suggestionId + suffix
  const newInput = before + replacement + after

  return {
    newInput,
    cursorPos: before.length + replacement.length,
  }
}

/**
 * Extract a completable token at the cursor position
 * @param text The input text
 * @param cursorPos The cursor position
 * @param includeAtSymbol Whether to consider @ symbol as part of the token
 * @returns The completable token and its start position, or null if not found
 */
export function extractCompletionToken(
  text: string,
  cursorPos: number,
  includeAtSymbol = false,
): { token: string; startPos: number; isQuoted?: boolean } | null {
  // Empty input check
  if (!text) return null

  // Get text up to cursor
  const textBeforeCursor = text.substring(0, cursorPos)

  // Check for quoted @ mention first (e.g., @"my file with spaces")
  if (includeAtSymbol) {
    const quotedAtRegex = /@"([^"]*)"?$/
    const quotedMatch = textBeforeCursor.match(quotedAtRegex)
    if (quotedMatch && quotedMatch.index !== undefined) {
      // Include any remaining quoted content after cursor until closing quote or end
      const textAfterCursor = text.substring(cursorPos)
      const afterQuotedMatch = textAfterCursor.match(/^[^"]*"?/)
      const quotedSuffix = afterQuotedMatch ? afterQuotedMatch[0] : ''

      return {
        token: quotedMatch[0] + quotedSuffix,
        startPos: quotedMatch.index,
        isQuoted: true,
      }
    }
  }

  // Fast path for @ tokens: use lastIndexOf to avoid expensive $ anchor scan
  if (includeAtSymbol) {
    const atIdx = textBeforeCursor.lastIndexOf('@')
    if (
      atIdx >= 0 &&
      (atIdx === 0 || /\s/.test(textBeforeCursor[atIdx - 1]!))
    ) {
      const fromAt = textBeforeCursor.substring(atIdx)
      const atHeadMatch = fromAt.match(AT_TOKEN_HEAD_RE)
      if (atHeadMatch && atHeadMatch[0].length === fromAt.length) {
        const textAfterCursor = text.substring(cursorPos)
        const afterMatch = textAfterCursor.match(PATH_CHAR_HEAD_RE)
        const tokenSuffix = afterMatch ? afterMatch[0] : ''
        return {
          token: atHeadMatch[0] + tokenSuffix,
          startPos: atIdx,
          isQuoted: false,
        }
      }
    }
  }

  // Non-@ token or cursor outside @ token — use $ anchor on (short) tail
  const tokenRegex = includeAtSymbol ? TOKEN_WITH_AT_RE : TOKEN_WITHOUT_AT_RE
  const match = textBeforeCursor.match(tokenRegex)
  if (!match || match.index === undefined) {
    return null
  }

  // Check if cursor is in the MIDDLE of a token (more word characters after cursor)
  // If so, extend the token to include all characters until whitespace or end of string
  const textAfterCursor = text.substring(cursorPos)
  const afterMatch = textAfterCursor.match(PATH_CHAR_HEAD_RE)
  const tokenSuffix = afterMatch ? afterMatch[0] : ''

  return {
    token: match[0] + tokenSuffix,
    startPos: match.index,
    isQuoted: false,
  }
}
