import { jsonStringify } from '../../utils/slowOperations.js'

export type ToolCallDisplayMode = 'compact' | 'full'

const COMPACT_MAX_VALUE_CHARS = 80
const COMPACT_MAX_PARAMS = 6
const FULL_MAX_VALUE_CHARS = 200

export function renderToolCallParams(
  input: Record<string, unknown>,
  mode: ToolCallDisplayMode,
  compactParamKeys?: readonly string[],
): string {
  let entries: [string, unknown][]

  if (mode === 'compact' && compactParamKeys !== undefined) {
    entries = []
    for (const key of compactParamKeys) {
      if (key in input && input[key] != null) {
        entries.push([key, input[key]])
      }
    }
  } else {
    // Inputs built in JS (RunCode bridge child calls) can carry explicit
    // undefined values, which JSON.stringify renders as no output at all.
    entries = Object.entries(input).filter(([, value]) => value != null)
  }

  if (entries.length === 0) return ''

  const maxValueChars =
    mode === 'compact' ? COMPACT_MAX_VALUE_CHARS : FULL_MAX_VALUE_CHARS
  const maxParams = mode === 'compact' ? COMPACT_MAX_PARAMS : entries.length

  const visible = entries.slice(0, maxParams)
  const parts = visible.map(([key, value]) => {
    // jsonStringify is typed as string but returns undefined for
    // functions and symbols.
    let rendered = jsonStringify(value) ?? String(value)
    // Escaped newlines/tabs (JSON.stringify escapes them, so they are
    // literal "\n" two-char sequences) make values like a pasted tool
    // result unreadable inline; show them as spaces instead.
    rendered = rendered.replace(/\\r\\n|\\[nrt]/g, ' ')
    if (mode === 'compact') {
      rendered = rendered.replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ')
    }
    if (rendered.length > maxValueChars) {
      rendered = rendered.slice(0, maxValueChars).trimEnd() + '…'
    }
    return `${key}: ${rendered}`
  })

  const remaining = entries.length - visible.length
  if (remaining > 0) {
    parts.push(`…+${remaining} more`)
  }

  return parts.join(', ')
}
