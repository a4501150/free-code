/**
 * Present tool parameter schemas to OpenAI-compatible endpoints in a
 * strict-shaped form without opting into the `strict` flag: every property
 * listed as required and nullable (an omitted optional is sent as `null`),
 * objects closed with additionalProperties: false, and draft/JSON Schema
 * keywords the strict subset rejects stripped.
 *
 * Why shape-without-flag: strict-enforcing servers (OpenAI for newer models,
 * vLLM/SGLang guided decoding, gateways that auto-force strict) either
 * reject schemas with optionals outside `required` or silently drop the
 * tool — that is where GPT-family "failed to call Read/Edit" reports came
 * from. Presenting the strict shape makes the tools acceptable everywhere,
 * and the null placeholders the models then send are mapped back to absent
 * before validation (utils/stripStrictNullInputs.ts, which runs against the
 * authoritative Zod schema, not this presented one).
 */

type JSONSchemaObject = Record<string, unknown>

const DROPPED_KEYS = new Set([
  '$schema',
  'default',
  '$defs',
  'definitions',
  '$comment',
  'examples',
])

export function toPresentedToolSchema(
  schema: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!schema) return { type: 'object', properties: {} }
  if (usesRefs(schema)) return schema
  return normalizeNode(schema, true)
}

/** Local $refs we won't attempt to inline; present the original schema. */
function usesRefs(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(usesRefs)
  if (typeof node !== 'object' || node === null) return false
  for (const [key, value] of Object.entries(node)) {
    if (key === '$ref') return true
    if (usesRefs(value)) return true
  }
  return false
}

function normalizeNode(
  node: JSONSchemaObject,
  isRoot: boolean,
): JSONSchemaObject {
  const out: JSONSchemaObject = {}
  for (const [key, value] of Object.entries(node)) {
    if (DROPPED_KEYS.has(key)) continue
    out[key] = value
  }

  for (const branch of ['anyOf', 'oneOf'] as const) {
    if (Array.isArray(out[branch])) {
      out[branch] = (out[branch] as unknown[]).map(b =>
        typeof b === 'object' && b !== null
          ? normalizeNode(b as JSONSchemaObject, false)
          : b,
      )
      addNullBranch(out, branch)
    }
  }

  if (
    out['type'] === 'object' ||
    (out['properties'] && out['type'] === undefined)
  ) {
    const properties = out['properties']
    if (properties && typeof properties === 'object') {
      const normalizedProps: JSONSchemaObject = {}
      const required: string[] = []
      for (const [name, prop] of Object.entries(properties)) {
        const normalized =
          typeof prop === 'object' && prop !== null
            ? nullable(normalizeNode(prop as JSONSchemaObject, false))
            : prop
        normalizedProps[name] = normalized
        required.push(name)
      }
      out['properties'] = normalizedProps
      out['required'] = required
      if (out['additionalProperties'] === undefined) {
        out['additionalProperties'] = false
      }
    } else if (isRoot) {
      out['required'] = []
      if (out['additionalProperties'] === undefined) {
        out['additionalProperties'] = false
      }
    }
  }

  return out
}

/** Mark this node as accepting null (the only strict-legal "unset"). */
function nullable(node: JSONSchemaObject): JSONSchemaObject {
  const type = node['type']
  if (typeof type === 'string') {
    return type === 'null' ? node : { ...node, type: [type, 'null'] }
  }
  if (Array.isArray(type)) {
    return type.includes('null') ? node : { ...node, type: [...type, 'null'] }
  }
  if (Array.isArray(node['anyOf']) || Array.isArray(node['oneOf'])) {
    return node
  }
  return { anyOf: [node, { type: 'null' }] }
}

function addNullBranch(out: JSONSchemaObject, branch: 'anyOf' | 'oneOf'): void {
  const list = out[branch] as unknown[]
  const hasNull = list.some(
    b =>
      typeof b === 'object' &&
      b !== null &&
      ((b as JSONSchemaObject)['type'] === 'null' ||
        (Array.isArray((b as JSONSchemaObject)['type']) &&
          ((b as JSONSchemaObject)['type'] as unknown[]).includes('null'))),
  )
  if (!hasNull) list.push({ type: 'null' })
}
