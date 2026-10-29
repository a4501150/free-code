// Input coercion for the string-replacement Edit schema. Models trained on
// older shapes emit aliases (`old_str`, camelCase fields) or, when resumed
// from a pre-replacement transcript, the old anchored `edits[]` array with
// LINE:HASH entries. Aliases convert silently; the legacy anchored array
// fails loudly with a lesson, because converting LINE:HASH anchors would
// need hash machinery we removed. The CURRENT edits[] batch shape — entries
// of {old_string, new_string, ...} — passes through (aliases coerced per
// entry), so the discriminator is entry shape, not the array's presence.

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

// Keys of the pre-replacement anchored batch: {op, start: 'LINE:HASH', lines}.
const LEGACY_ENTRY_KEYS = new Set(['op', 'start', 'lines'])

// An entry counts as the new batch shape when it carries old_string under any
// known alias — the discriminator runs before aliases are coerced.
function isNewShapeEntry(e: object): boolean {
  return ['old_string', 'old_str', 'oldText'].some(k => k in e)
}

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
  const obj = raw as Record<string, unknown>

  if (Array.isArray(obj.edits)) {
    const entries = obj.edits as unknown[]
    const legacy = entries.some(
      e =>
        typeof e !== 'object' ||
        e === null ||
        !isNewShapeEntry(e as object) ||
        Object.keys(e as object).some(k => LEGACY_ENTRY_KEYS.has(k)),
    )
    if (legacy) {
      throw new ToolInputCoercionError(
        `The Edit tool no longer takes an "edits" array of LINE:HASH anchors. Call it with {file_path, old_string, new_string, replace_all?} or a batch edits array of {old_string, new_string} entries: Read the file or run a file-printing Bash command, copy the exact text to replace into old_string (strip the "N:" line-number prefix), and put the new text in new_string.`,
      )
    }
    // New batch shape: coerce aliases inside each entry.
    const coercedEntries = entries.map(e => {
      const { out, changed } = coerceFields(e as Record<string, unknown>)
      return changed ? out : e
    })
    const anyChanged = coercedEntries.some((e, i) => e !== entries[i])
    if (anyChanged) {
      return { ...obj, edits: coercedEntries }
    }
    return raw
  }

  const { out, changed } = coerceFields(obj)
  return changed ? out : raw
}
