/**
 * Recursive JSON Schema transformer that produces "strict" schemas as
 * required by OpenAI structured outputs / strict tool calls.
 *
 * Strict mode requires every property to be listed in `required` and
 * `additionalProperties: false` on every object node. Optional Zod fields
 * become nullable so the model can explicitly omit them by sending `null`.
 *
 * Skip rules — schemas that are NOT rewritten:
 * - Top-level objects whose `additionalProperties` is the empty schema `{}`
 *   (Zod's `.passthrough()` opt-out — preserve as-is).
 * - Schemas owned externally (MCP / StructuredOutput) — caller responsibility
 *   to skip those before calling this.
 *
 * The transform is idempotent: calling it on an already-strict schema is a
 * no-op (every key is already required, additionalProperties already false,
 * already-nullable fields are not re-wrapped).
 */

type JsonSchema = Record<string, unknown>

/**
 * True if `schema` is the empty object literal `{}` — Zod's marker for
 * `.passthrough()`. We must preserve passthrough opt-outs untouched.
 */
function isPassthroughMarker(schema: unknown): boolean {
  return (
    typeof schema === 'object' &&
    schema !== null &&
    !Array.isArray(schema) &&
    Object.keys(schema as object).length === 0
  )
}

/**
 * True if `schema` already accepts null — either as `type: 'null'`, or
 * unioned with null via `anyOf`/`oneOf`, or `nullable: true` (legacy).
 */
function permitsNull(schema: unknown): boolean {
  if (typeof schema !== 'object' || schema === null) return false
  const s = schema as JsonSchema
  if (s.type === 'null') return true
  if (s.nullable === true) return true
  if (Array.isArray(s.type) && (s.type as unknown[]).includes('null')) return true
  for (const key of ['anyOf', 'oneOf'] as const) {
    const variants = s[key]
    if (Array.isArray(variants) && variants.some(v => permitsNull(v))) {
      return true
    }
  }
  return false
}

/**
 * Wrap `schema` so it accepts null in addition to its existing type.
 * Uses `anyOf` to preserve `description`, `default`, etc. on the original.
 */
function widenWithNull(schema: unknown): JsonSchema {
  if (permitsNull(schema)) {
    return schema as JsonSchema
  }
  return {
    anyOf: [schema, { type: 'null' }],
  }
}

/**
 * Recursively transform a JSON Schema node into strict form.
 * Returns a deep-cloned, strict version of the input.
 */
export function makeJsonSchemaStrict(schema: unknown): unknown {
  if (typeof schema !== 'object' || schema === null) {
    return schema
  }
  if (Array.isArray(schema)) {
    return schema.map(item => makeJsonSchemaStrict(item))
  }

  const node = schema as JsonSchema
  const out: JsonSchema = {}

  for (const [key, value] of Object.entries(node)) {
    if (key === 'properties' && typeof value === 'object' && value !== null) {
      const transformed: JsonSchema = {}
      for (const [propKey, propValue] of Object.entries(
        value as JsonSchema,
      )) {
        transformed[propKey] = makeJsonSchemaStrict(propValue)
      }
      out[key] = transformed
    } else if (key === 'items') {
      out[key] = makeJsonSchemaStrict(value)
    } else if (
      (key === 'anyOf' || key === 'oneOf' || key === 'allOf') &&
      Array.isArray(value)
    ) {
      out[key] = value.map(v => makeJsonSchemaStrict(v))
    } else if (key === 'additionalProperties') {
      // Boolean values pass through unchanged. Schema objects recurse.
      // Empty-object marker `{}` — passthrough — also passes unchanged
      // here; the caller decides at the top level whether to honor it.
      if (typeof value === 'boolean') {
        out[key] = value
      } else if (isPassthroughMarker(value)) {
        out[key] = value
      } else {
        out[key] = makeJsonSchemaStrict(value)
      }
    } else {
      out[key] = value
    }
  }

  // For object nodes, lock down strict invariants:
  //   - additionalProperties: false (unless caller marked passthrough with {})
  //   - required: every property name in `properties`
  //   - properties not in original `required` are widened with `null`
  if (out.type === 'object' || out.properties) {
    const props = (out.properties as JsonSchema | undefined) ?? {}
    const propKeys = Object.keys(props)

    // additionalProperties: preserve `{}` (passthrough opt-out); otherwise force false.
    if (!isPassthroughMarker(out.additionalProperties)) {
      out.additionalProperties = false
    }

    const originalRequired = Array.isArray(out.required)
      ? new Set(out.required as string[])
      : new Set<string>()

    if (propKeys.length > 0) {
      // Widen previously-optional properties with null so the model can
      // explicitly omit them via `null`. Skip widening when the property
      // already permits null (idempotent on re-run).
      const widenedProps: JsonSchema = {}
      for (const [propKey, propValue] of Object.entries(props)) {
        if (!originalRequired.has(propKey) && !permitsNull(propValue)) {
          widenedProps[propKey] = widenWithNull(propValue)
        } else {
          widenedProps[propKey] = propValue
        }
      }
      out.properties = widenedProps
      out.required = propKeys
    }
  }

  return out
}

/**
 * True when the top-level schema opted out via Zod `.passthrough()`.
 * Detected by `additionalProperties: {}` (the empty schema marker that
 * Zod's `toJSONSchema` emits for passthrough objects).
 */
export function isPassthroughSchema(schema: unknown): boolean {
  if (typeof schema !== 'object' || schema === null) return false
  return isPassthroughMarker((schema as JsonSchema).additionalProperties)
}
