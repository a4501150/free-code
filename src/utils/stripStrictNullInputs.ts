/**
 * Normalize placeholder values emitted for strict tool-call schemas.
 *
 * When `makeJsonSchemaStrict` rewrites a Zod-derived JSON schema, it widens
 * each previously-optional field with `{anyOf: [original, {type:'null'}]}`
 * so OpenAI structured outputs / strict mode can satisfy the requirement
 * that every key be present and explicit. The model should emit `null` to
 * mean "field omitted," but some models emit an empty string instead.
 *
 * For optional non-nullable fields, delete both `null` and empty-string
 * placeholders before `tool.inputSchema.safeParse`. For nullable fields,
 * preserve `null` and normalize empty-string placeholders to `null`. Required
 * non-nullable strings keep their empty values because those can be meaningful.
 *
 * Recurses into nested objects (matched against the Zod sub-schema) so deeply
 * nested placeholder values are normalized too. Pure runtime introspection
 * over `(schema as ZodObject).shape`.
 */

import type { z } from 'zod/v4'

type ZodLikeDef = {
  type?: string
  innerType?: ZodLike
  // ZodPipe uses `in` / `out` for its two ends instead of `innerType`. We drill
  // into `out` (the output schema) so e.g. `z.preprocess(fn, z.optional(...))`
  // is treated as optional rather than an opaque pipe.
  out?: ZodLike
  shape?: Record<string, ZodLike>
  element?: ZodLike
  options?: ZodLike[]
  discriminator?: string
  values?: unknown[]
}
type ZodLike = {
  _def?: ZodLikeDef
  shape?: Record<string, ZodLike>
  safeParse?(value: unknown): { success: boolean }
}

/** Get the next schema down through a transparent wrapper. */
function getInner(def: ZodLikeDef | undefined): ZodLike | undefined {
  if (!def) return undefined
  if (def.type === 'pipe') return def.out
  return def.innerType
}

/**
 * Drill through transparent wrappers to the underlying traversal schema.
 * Placeholder classification separately inspects nullable wrappers before
 * unwrapping them.
 */
function unwrap(node: ZodLike | undefined): ZodLike | undefined {
  let cur = node
  while (cur) {
    const t = cur._def?.type
    if (
      t === 'optional' ||
      t === 'nullable' ||
      t === 'default' ||
      t === 'readonly' ||
      t === 'pipe'
    ) {
      cur = getInner(cur._def)
      continue
    }
    break
  }
  return cur
}

function getPlaceholderHandling(node: unknown): 'delete' | 'null' | 'keep' {
  if (typeof node !== 'object' || node === null) return 'keep'
  // Walk through every transparent wrapper. We can't shortcut on "outer must
  // be optional": semantic helpers wrap their inner schemas in a pipe.
  let cur: ZodLike | undefined = node as ZodLike
  let foundOptional = false
  while (cur) {
    const t = cur._def?.type
    if (t === 'nullable') return 'null'
    if (t === 'optional') foundOptional = true
    if (
      t === 'optional' ||
      t === 'default' ||
      t === 'readonly' ||
      t === 'pipe'
    ) {
      cur = getInner(cur._def)
      continue
    }
    break
  }
  return foundOptional ? 'delete' : 'keep'
}

/**
 * Get the `.shape` of a Zod object schema, drilling through wrappers like
 * optional/nullable/default. Returns undefined for non-object schemas.
 */
function getShape(
  node: ZodLike | undefined,
): Record<string, ZodLike> | undefined {
  const target = unwrap(node)
  if (!target) return undefined
  // ZodObject has `shape` directly on the instance
  const shape = (target as { shape?: Record<string, ZodLike> }).shape
  if (shape && typeof shape === 'object') return shape
  return undefined
}

/**
 * Get the array element schema for a ZodArray, if applicable.
 */
function getArrayElement(node: ZodLike | undefined): ZodLike | undefined {
  const target = unwrap(node)
  if (!target) return undefined
  const def = target._def
  if (def?.type !== 'array') return undefined
  return def.element
}

type UnionSchema = {
  options: ZodLike[]
  discriminator?: string
}

function getUnion(node: ZodLike | undefined): UnionSchema | undefined {
  const target = unwrap(node)
  const def = target?._def
  if (def?.type !== 'union' || !Array.isArray(def.options)) return undefined
  return { options: def.options, discriminator: def.discriminator }
}

function literalAccepts(node: ZodLike | undefined, value: unknown): boolean {
  const target = unwrap(node)
  return (
    target?._def?.type === 'literal' &&
    Array.isArray(target._def.values) &&
    target._def.values.includes(value)
  )
}

function orderedUnionOptions(union: UnionSchema, value: unknown): ZodLike[] {
  if (
    !union.discriminator ||
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value)
  ) {
    return union.options
  }

  const discriminatorValue = (value as Record<string, unknown>)[
    union.discriminator
  ]
  const matching: ZodLike[] = []
  const remaining: ZodLike[] = []
  for (const option of union.options) {
    const discriminatorSchema = getShape(option)?.[union.discriminator]
    if (literalAccepts(discriminatorSchema, discriminatorValue)) {
      matching.push(option)
    } else {
      remaining.push(option)
    }
  }
  return [...matching, ...remaining]
}

function stripUnion(union: UnionSchema, value: unknown): unknown {
  for (const option of orderedUnionOptions(union, value)) {
    const stripped = strip(option, value)
    if (option.safeParse?.(stripped).success) return stripped
  }
  return value
}

function strip(node: ZodLike | undefined, value: unknown): unknown {
  const union = getUnion(node)
  if (union) return stripUnion(union, value)

  if (Array.isArray(value)) {
    const elemSchema = getArrayElement(node)
    if (!elemSchema) return value
    let cloned: unknown[] | undefined
    for (let i = 0; i < value.length; i++) {
      const stripped = strip(elemSchema, value[i])
      if (stripped !== value[i]) {
        if (!cloned) cloned = value.slice()
        cloned[i] = stripped
      }
    }
    return cloned ?? value
  }

  if (typeof value !== 'object' || value === null) {
    return value
  }

  const shape = getShape(node)
  if (!shape) return value

  const obj = value as Record<string, unknown>
  let cloned: Record<string, unknown> | undefined

  for (const key of Object.keys(obj)) {
    const fieldSchema = shape[key]
    if (!fieldSchema) continue
    const v = obj[key]
    const placeholderHandling = getPlaceholderHandling(fieldSchema)
    if ((v === null || v === '') && placeholderHandling === 'delete') {
      if (!cloned) cloned = { ...obj }
      delete cloned[key]
      continue
    }
    if (v === '' && placeholderHandling === 'null') {
      if (!cloned) cloned = { ...obj }
      cloned[key] = null
      continue
    }
    if (typeof v === 'object' && v !== null) {
      const recursed = strip(fieldSchema, v)
      if (recursed !== v) {
        if (!cloned) cloned = { ...obj }
        cloned[key] = recursed
      }
    }
  }
  return cloned ?? value
}

export function stripStrictNullInputs(
  schema: z.ZodTypeAny,
  input: unknown,
): unknown {
  return strip(schema as ZodLike, input)
}
