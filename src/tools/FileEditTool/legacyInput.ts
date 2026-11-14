// Input coercion for the string-replacement Edit schema. Models trained on
// older shapes emit aliases (`old_str`, camelCase fields) or retired optional
// modes (`edits[]` batches, the `end_string` anchor range). Aliases convert
// silently; retired modes fail loudly with a lesson, because converting
// them would change what gets edited (an anchored rewrite silently reduced
// to a plain replacement could edit the wrong, smaller span).

import { ToolInputCoercionError } from '../../utils/toolErrors.js'

const ALIASES: Record<string, string> = {
  path: 'file_path',
  old_str: 'old_string',
  new_str: 'new_string',
  oldText: 'old_string',
  newText: 'new_string',
  replace_name: 'replace_all',
  replaceAll: 'replace_all',
}

// Dropped silently: placement hints from earlier schema shapes. They were
// advisory (a re-plan against disk always ran), so dropping them keeps the
// call working instead of tripping the strict schema.
const DROPPED = new Set(['start_line', 'end_line', 'startLine', 'endLine'])

// Retired optional modes: an edits[] batch and the end_string anchor range.
// Both change WHICH text gets replaced, so they must never be dropped
// silently — a silent drop would turn them into a smaller, wrong edit.
const RETIRED = new Set(['edits', 'end_string', 'endString', 'endText'])

function coerceFields(obj: Record<string, unknown>): {
  out: Record<string, unknown>
  changed: boolean
} {
  const out: Record<string, unknown> = {}
  let changed = false
  for (const [key, value] of Object.entries(obj)) {
    if (DROPPED.has(key)) {
      changed = true
      continue
    }
    if (RETIRED.has(key)) {
      throw new ToolInputCoercionError(
        key === 'edits'
          ? 'The Edit tool no longer takes an "edits" array: it replaces one span per call. Read the file or run a file-printing Bash command, copy the exact text to replace into old_string (strip the "N:" line-number prefix), and put the new text in new_string. For multiple changes, issue several Edit calls in the same turn — same-file calls serialize safely, each matched against the file as the previous left it.'
          : 'The Edit tool no longer takes an "end_string" anchor range: quote the full text to replace in old_string instead (read the file or run a file-printing Bash command and copy it exactly, stripping any "N:" line-number prefix).',
      )
    }
    const canonical = ALIASES[key]
    if (canonical !== undefined && !(canonical in obj)) {
      out[canonical] = value
      changed = true
    } else {
      out[key] = value
    }
  }
  return { out, changed }
}

export function coerceEditInput(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return raw
  }
  const { out, changed } = coerceFields(raw as Record<string, unknown>)
  return changed ? out : raw
}
