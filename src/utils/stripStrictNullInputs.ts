/**
 * Lightweight input normalizer for tool call arguments.
 *
 * Some models send `null` or `""` for fields they intend to omit. This
 * cleans up those placeholders before Zod validation, which expects optional
 * fields to be genuinely absent rather than set to `null`.
 *
 * Only operates on top-level and one-level-nested object fields. Does not
 * introspect Zod schema internals — the runtime `inputSchema.safeParse`
 * remains the authoritative validation boundary.
 */

/**
 * Strip `null` and empty-string placeholder values from tool input objects.
 *
 * - Top-level `null` or `""` values are deleted (the field becomes absent).
 * - Nested objects are recursively cleaned one level deep.
 * - Arrays and non-object values pass through unchanged.
 *
 * The second `_schema` parameter is accepted for call-site compatibility
 * but is no longer used — the normalizer is schema-agnostic.
 */
export function stripStrictNullInputs(
  _schema: unknown,
  input: unknown,
): unknown {
  return stripPlaceholders(input)
}

function stripPlaceholders(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return value
  }

  const obj = value as Record<string, unknown>
  let cloned: Record<string, unknown> | undefined

  for (const key of Object.keys(obj)) {
    const v = obj[key]

    if (v === null || v === '') {
      if (!cloned) cloned = { ...obj }
      delete cloned[key]
      continue
    }

    if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      const cleaned = stripPlaceholders(v)
      if (cleaned !== v) {
        if (!cloned) cloned = { ...obj }
        cloned[key] = cleaned
      }
    }
  }

  return cloned ?? value
}
