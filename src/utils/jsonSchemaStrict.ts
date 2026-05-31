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
  if (Array.isArray(s.type) && (s.type as unknown[]).includes('null'))
    return true
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
 *
 * When the schema's top level has a single string `type` keyword, emit
 * `type: [..., "null"]` so constrained-output decoders (llama.cpp grammars,
 * vLLM xgrammar, etc.) don't see a nested `anyOf`. qwen3.6 / similar small
 * models double-quote string values when they encounter `anyOf:[{string},
 * {null}]` — the flat `type: ["string","null"]` shape side-steps that quirk
 * and is semantically identical. `enum`, `const`, `properties`, `items`
 * carry over on the same node, preserving the original constraints.
 *
 * Composite schemas (top-level `anyOf`/`oneOf`/`allOf`, or no `type` keyword)
 * fall back to the `anyOf` wrapping. `permitsNull` already recognizes
 * array-typed `type` containing `"null"`, so the transform stays idempotent.
 */
function widenWithNull(schema: unknown): JsonSchema {
  if (permitsNull(schema)) {
    return schema as JsonSchema
  }
  if (typeof schema === 'object' && schema !== null && !Array.isArray(schema)) {
    const s = schema as JsonSchema
    if (typeof s.type === 'string') {
      return { ...s, type: [s.type, 'null'] }
    }
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
      for (const [propKey, propValue] of Object.entries(value as JsonSchema)) {
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

  // For fixed object nodes, lock down strict invariants:
  //   - additionalProperties: false (unless caller marked passthrough with {})
  //   - required: every property name in `properties`
  //   - properties not in original `required` are widened with `null`
  // Record schemas have no `properties` map and use `additionalProperties` as
  // their value schema. Preserve that schema so best-effort tool calls retain
  // their map semantics; wire-level strict gating rejects records separately.
  if (out.type === 'object' || out.properties) {
    const hasProperties = Object.prototype.hasOwnProperty.call(
      out,
      'properties',
    )
    const isRecord =
      out.type === 'object' &&
      !hasProperties &&
      Object.prototype.hasOwnProperty.call(out, 'additionalProperties') &&
      out.additionalProperties !== false
    const props = (out.properties as JsonSchema | undefined) ?? {}
    const propKeys = Object.keys(props)

    if (!isRecord && !isPassthroughMarker(out.additionalProperties)) {
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
 * True when a JSON Schema can safely use wire-level strict tool decoding.
 * Every object node must be closed and list all fixed properties as required.
 * Record-shaped objects intentionally fail this check because strict decoding
 * cannot preserve arbitrary keys while also requiring additionalProperties:false.
 */
export function isStrictCompatibleSchema(schema: unknown): boolean {
  return isStrictCompatibleNode(schema, true)
}

function isStrictCompatibleNode(
  schema: unknown,
  requireRootObject = false,
): boolean {
  if (typeof schema === 'boolean') return true
  if (typeof schema !== 'object' || schema === null) return true
  if (Array.isArray(schema)) {
    return schema.every(item => isStrictCompatibleNode(item))
  }

  const node = schema as JsonSchema
  const isObjectNode =
    node.type === 'object' ||
    Object.prototype.hasOwnProperty.call(node, 'properties') ||
    Object.prototype.hasOwnProperty.call(node, 'additionalProperties')

  if (requireRootObject && node.type !== 'object') return false
  if (isObjectNode) {
    if (node.additionalProperties !== false) return false
    if (node.properties !== undefined) {
      if (
        typeof node.properties !== 'object' ||
        node.properties === null ||
        Array.isArray(node.properties)
      ) {
        return false
      }
      const propKeys = Object.keys(node.properties as JsonSchema)
      const required = Array.isArray(node.required)
        ? new Set(node.required as unknown[])
        : new Set<unknown>()
      if (propKeys.some(key => !required.has(key))) return false
    }
  }

  for (const key of [
    'properties',
    '$defs',
    'definitions',
    'dependentSchemas',
  ]) {
    const map = node[key]
    if (map === undefined) continue
    if (typeof map !== 'object' || map === null || Array.isArray(map)) {
      return false
    }
    if (
      !Object.values(map as JsonSchema).every(value =>
        isStrictCompatibleNode(value),
      )
    ) {
      return false
    }
  }

  if (
    node.patternProperties !== undefined &&
    (typeof node.patternProperties !== 'object' ||
      node.patternProperties === null ||
      Array.isArray(node.patternProperties) ||
      Object.keys(node.patternProperties as JsonSchema).length > 0)
  ) {
    return false
  }

  for (const key of ['items', 'contains', 'not', 'if', 'then', 'else']) {
    if (node[key] !== undefined && !isStrictCompatibleNode(node[key])) {
      return false
    }
  }

  for (const key of ['anyOf', 'oneOf', 'allOf', 'prefixItems']) {
    const variants = node[key]
    if (variants === undefined) continue
    if (
      !Array.isArray(variants) ||
      !variants.every(variant => isStrictCompatibleNode(variant))
    ) {
      return false
    }
  }

  return true
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
