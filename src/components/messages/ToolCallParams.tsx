import { jsonStringify } from '../../utils/slowOperations.js'

export type ToolCallDisplayMode = 'compact' | 'full'

const COMPACT_MAX_VALUE_CHARS = 80
const COMPACT_MAX_PARAMS = 6
const FULL_MAX_VALUE_CHARS = 200

export function renderToolCallParams(
  input: Record<string, unknown>,
  mode: ToolCallDisplayMode,
): string {
  const entries = Object.entries(input)
  if (entries.length === 0) return ''

  const maxValueChars =
    mode === 'compact' ? COMPACT_MAX_VALUE_CHARS : FULL_MAX_VALUE_CHARS
  const maxParams = mode === 'compact' ? COMPACT_MAX_PARAMS : entries.length

  const visible = entries.slice(0, maxParams)
  const parts = visible.map(([key, value]) => {
    let rendered = jsonStringify(value) ?? 'undefined'
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
