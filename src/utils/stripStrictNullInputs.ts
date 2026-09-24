/**
 * Lightweight input normalizer for tool call arguments.
 *
 * Some models send `null` or `""` for fields they intend to omit, and some
 * cannot do anything else: OpenAI's strict schema subset — which the Responses
 * API applies to our tools on its own unless the tool opts out — requires every
 * property to appear in `required`, and can only say "unset" with null. Those
 * placeholders are cleaned up before Zod validation, which expects an optional
 * field to be genuinely absent rather than set to `null`.
 *
 * A key is deleted only when the schema accepts the field being absent, and —
 * for `null` — does not itself admit null. Deleting every placeholder
 * unconditionally rewrote two kinds of legitimate call:
 *
 * - An argument whose schema admits null. agent-browser's `browser_open
 *   {profile: null}` asks for a throwaway profile that is deleted on close, and
 *   silently became the persistent default profile instead.
 * - An empty string a required field needs. `browser_type_text {text: ""}`
 *   clears a field, and became a missing required argument.
 *
 * An optional field carrying `""` is still treated as omitted, because that is
 * the placeholder this exists for and a caller cannot mean both.
 *
 * Pass the schema the model was shown: a tool's `inputJSONSchema` where it has
 * one — MCP tools, whose Zod schema is an opaque passthrough — else its Zod
 * schema. Where neither describes a key, the placeholder is stripped as before.
 * Nested objects and array elements are cleaned the same way against their
 * sub-schemas (models mirror the null-is-unset convention downward), while the
 * array value itself is never dropped. The runtime `inputSchema.safeParse`
 * remains the authoritative validation boundary.
 */

type JSONSchemaNode = {
  type?: unknown
  properties?: Record<string, unknown>
  required?: unknown
  anyOf?: unknown
  oneOf?: unknown
  enum?: unknown
  const?: unknown
  items?: unknown
}

/** Strip `null` and empty-string placeholder values from tool input objects. */
export function stripStrictNullInputs(
  schema: unknown,
  input: unknown,
): unknown {
  return stripPlaceholders(input, schema)
}

function stripPlaceholders(value: unknown, schema: unknown): unknown {
  if (Array.isArray(value)) {
    return stripArrayPlaceholders(value, schema)
  }
  if (typeof value !== 'object' || value === null) {
    return value
  }

  const obj = value as Record<string, unknown>
  let cloned: Record<string, unknown> | undefined

  for (const key of Object.keys(obj)) {
    const v = obj[key]

    if (v === null || v === '') {
      if (isPlaceholder(schema, key, v)) {
        if (!cloned) cloned = { ...obj }
        delete cloned[key]
      }
      continue
    }

    if (typeof v === 'object' && v !== null) {
      const cleaned = stripPlaceholders(v, propertySchema(schema, key))
      if (cleaned !== v) {
        if (!cloned) cloned = { ...obj }
        cloned[key] = cleaned
      }
    }
  }

  return cloned ?? value
}

/**
 * Clean placeholders inside array values. The array itself is kept (an empty
 * array is a real value — e.g. `addBlocks: []`), but strict presentation teaches
 * models "null = unset" and they mirror it downward into item objects, so
 * elements are cleaned against the array's element schema. Nulls/empty strings
 * that the element schema doesn't explicitly admit are dropped (the element
 * reads as "meant to omit this entry"); object elements are recursed.
 */
function stripArrayPlaceholders(arr: unknown[], schema: unknown): unknown[] {
  const elementFor = (index: number): unknown => {
    const items = jsonSchemaNode(schema)?.items
    if (items !== undefined) return Array.isArray(items) ? items[index] : items
    return elementSchema(schema)
  }
  let out: unknown[] | undefined
  for (let i = 0; i < arr.length; i++) {
    const el = arr[i]
    if (el === null || el === '') {
      if (elementMeansAbsent(elementFor(i), el)) {
        if (!out) out = arr.slice(0, i)
        continue
      }
      out?.push(el)
      continue
    }
    if (typeof el === 'object') {
      const cleaned = stripPlaceholders(el, elementFor(i))
      if (cleaned !== el) {
        if (!out) out = arr.slice(0, i)
        out.push(cleaned)
        continue
      }
    }
    out?.push(el)
  }
  return out ?? arr
}

/** Whether a null/'' array element reads as "the model meant to omit this entry". */
function elementMeansAbsent(element: unknown, value: null | ''): boolean {
  if (element === undefined) return true
  if (value === '') return true
  return !zodAccepts(element, null) && !jsonAdmitsNull(element)
}

/**
 * The element schema of a Zod array, unwrapping `.optional()`/`.default()`/
 * `.nullable()` wrappers that sit between the property and the array. v4
 * arrays expose `.element`/`.def.element`; wrappers carry the inner schema as
 * `.def.innerType`.
 */
function elementSchema(schema: unknown): unknown {
  let node = schema as
    | {
        safeParse?: unknown
        element?: unknown
        def?: Record<string, unknown>
        _def?: Record<string, unknown>
      }
    | undefined
  for (
    let depth = 0;
    depth < 6 && node && typeof node.safeParse === 'function';
    depth++
  ) {
    const def = (node.def ?? node._def) as Record<string, unknown> | undefined
    if (def?.['type'] === 'array' || node.element !== undefined) {
      return node.element ?? def?.['element'] ?? def?.['valueType']
    }
    node = (def?.['innerType'] ??
      def?.['valueType'] ??
      def?.['elementType']) as typeof node | undefined
  }
  return undefined
}

/** Whether `value` at `key` reads as "the model meant to omit this field". */
function isPlaceholder(
  schema: unknown,
  key: string,
  value: null | '',
): boolean {
  const shape = zodShape(schema)
  if (shape) {
    const field = shape[key]
    if (field === undefined) return true
    if (!zodAccepts(field, undefined)) return false
    return value === '' || !zodAccepts(field, null)
  }

  const json = jsonSchemaNode(schema)
  if (json?.properties) {
    const field = json.properties[key]
    if (field === undefined) return true
    if (isRequired(json, key)) return false
    return value === '' || !jsonAdmitsNull(field)
  }

  return true
}

/** The sub-schema for a nested object, so recursion stays schema-aware. */
function propertySchema(schema: unknown, key: string): unknown {
  const shape = zodShape(schema)
  if (shape) return shape[key]
  return jsonSchemaNode(schema)?.properties?.[key]
}

function zodShape(schema: unknown): Record<string, unknown> | undefined {
  const shape = (schema as { shape?: unknown } | undefined)?.shape
  return shape && typeof shape === 'object'
    ? (shape as Record<string, unknown>)
    : undefined
}

function zodAccepts(field: unknown, value: unknown): boolean {
  const safeParse = (
    field as { safeParse?: (v: unknown) => { success: boolean } } | undefined
  )?.safeParse
  if (typeof safeParse !== 'function') return false
  try {
    return safeParse.call(field, value).success
  } catch {
    // An async refinement cannot be parsed synchronously. Reporting "rejects
    // absence" keeps the key, so the authoritative validation produces the
    // error rather than this silently dropping an argument.
    return false
  }
}

function jsonAdmitsNull(node: unknown): boolean {
  const schema = jsonSchemaNode(node)
  if (!schema) return false

  for (const branch of [...toArray(schema.anyOf), ...toArray(schema.oneOf)]) {
    if (jsonAdmitsNull(branch)) return true
  }
  if (Array.isArray(schema.enum)) return schema.enum.includes(null)
  if ('const' in schema) return schema.const === null

  return typeof schema.type === 'string'
    ? schema.type === 'null'
    : toArray(schema.type).includes('null')
}

function isRequired(schema: JSONSchemaNode, key: string): boolean {
  return Array.isArray(schema.required) && schema.required.includes(key)
}

function jsonSchemaNode(node: unknown): JSONSchemaNode | undefined {
  return typeof node === 'object' && node !== null && !Array.isArray(node)
    ? (node as JSONSchemaNode)
    : undefined
}

function toArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}
