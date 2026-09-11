// Input coercion for the string-replacement Edit schema. Models trained on
// older shapes emit aliases (`old_str`, camelCase fields) or, when resumed
// from a pre-replacement transcript, the old anchored `edits[]` array. Aliases
// convert silently; anchored inputs fail loudly with a lesson, because
// converting LINE:HASH anchors here would need hash machinery we removed.

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

export function coerceEditInput(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return raw
  }
  const obj = raw as Record<string, unknown>

  if (Array.isArray(obj.edits)) {
    throw new ToolInputCoercionError(
      `The Edit tool no longer takes an "edits" array of LINE:HASH anchors. Call it with {file_path, old_string, new_string, replace_all?}: Read or Grep the file, copy the exact text to replace into old_string (strip the "N:" line-number prefix), and put the new text in new_string.`,
    )
  }

  let changed = false
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(obj)) {
    if (DROPPED.has(key)) {
      changed = true
      continue
    }
    const canonical = ALIASES[key]
    if (canonical !== undefined && !(canonical in obj)) {
      out[canonical] = value
      changed = true
    } else {
      out[key] = value
    }
  }
  return changed ? out : raw
}
