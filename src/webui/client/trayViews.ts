/**
 * Pure mapping between wire requests and what the trays render and send.
 *
 * The same pattern as `itemViews.ts`: everything that can be decided without
 * a DOM lives here, so the request round-trip is unit-testable — the form
 * fields a server-constructed MCP schema implies, the content a filled form
 * answers with, the edited permission input that must parse before it ships.
 */

import type { WirePermissionMode } from '../../session/wire.js'

export type ElicitationField = {
  name: string
  label: string
  description?: string
  type: 'text' | 'number' | 'checkbox' | 'select'
  /** Only for `select`: the wire's enum values. */
  options?: string[]
  required: boolean
}

/**
 * MCP `ElicitRequestParams` requestedSchema -> form fields.
 *
 * The params arrive as JSON, so every read is a maybe; a property whose type
 * the browser cannot render (nested objects, unknown types) is skipped
 * rather than guessed at — the form answers without it and the server's
 * schema check is the one that matters.
 */
export function elicitationFields(params: unknown): ElicitationField[] {
  const schema = (params as { requestedSchema?: unknown } | null)
    ?.requestedSchema
  if (typeof schema !== 'object' || schema === null) return []
  const properties = (schema as { properties?: unknown }).properties
  if (typeof properties !== 'object' || properties === null) return []
  const required = new Set(
    Array.isArray((schema as { required?: unknown }).required)
      ? (schema as { required: unknown[] }).required.filter(
          (name): name is string => typeof name === 'string',
        )
      : [],
  )

  const fields: ElicitationField[] = []
  for (const [name, raw] of Object.entries(properties)) {
    if (typeof raw !== 'object' || raw === null) continue
    const def = raw as Record<string, unknown>
    const title = typeof def.title === 'string' ? def.title : undefined
    const description =
      typeof def.description === 'string' ? def.description : undefined
    const enumValues = Array.isArray(def.enum)
      ? def.enum.filter((v): v is string => typeof v === 'string')
      : undefined
    const field = (
      type: ElicitationField['type'],
      options?: string[],
    ): ElicitationField => ({
      name,
      label: title ?? name,
      ...(description ? { description } : {}),
      type,
      ...(options ? { options } : {}),
      required: required.has(name),
    })
    if (enumValues?.length) {
      fields.push(field('select', enumValues))
    } else if (def.type === 'boolean') {
      fields.push(field('checkbox'))
    } else if (def.type === 'number' || def.type === 'integer') {
      fields.push(field('number'))
    } else if (def.type === 'string') {
      fields.push(field('text'))
    }
  }
  return fields
}

export type ElicitationValues = Record<string, string | boolean>

/**
 * A filled form -> `ElicitResult.content`, or the message to show inline.
 *
 * Absent means absent, not zero: a blank optional number must not answer
 * `0`, and a missing required field is an error the tray shows rather than a
 * request the server rejects.
 */
export function elicitationContent(
  fields: readonly ElicitationField[],
  values: ElicitationValues,
):
  | { ok: true; content: Record<string, unknown> }
  | { ok: false; error: string } {
  const content: Record<string, unknown> = {}
  for (const field of fields) {
    const raw = values[field.name]
    if (field.type === 'checkbox') {
      // A checkbox always answers, checked or not: "no" is an answer.
      content[field.name] = raw === true
      continue
    }
    const text = typeof raw === 'string' ? raw.trim() : ''
    if (text === '') {
      if (field.required)
        return { ok: false, error: `${field.label} is required` }
      continue
    }
    if (field.type === 'number') {
      const parsed = Number(text)
      if (!Number.isFinite(parsed)) {
        return { ok: false, error: `${field.label} must be a number` }
      }
      content[field.name] = parsed
      continue
    }
    if (field.type === 'select' && !field.options?.includes(text)) {
      return { ok: false, error: `${field.label}: unknown choice` }
    }
    content[field.name] = text
  }
  return { ok: true, content }
}

/**
 * The permission tray's edited-input pane -> `updatedInput`.
 *
 * The wire admits any record, so the only gate is "parses to an object":
 * an array or a scalar is the user retyping the tool's whole contract, and
 * the tool will choke on it — reject it here with a readable error instead.
 */
export function parseUpdatedInput(
  text: string,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, error: 'input is not valid JSON' }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: 'input must be a JSON object' }
  }
  return { ok: true, value: parsed as Record<string, unknown> }
}

/** The modes the surface may ask the session to switch to after an allow. */
export const ALLOW_SET_MODES: readonly WirePermissionMode[] = [
  'default',
  'acceptEdits',
  'plan',
]

/**
 * The permission tray's answer, assembled from its controls.
 *
 * `updatedInput` is only carried when it differs from the request's own
 * input — an unchanged pane sends nothing, so the terminal sees a plain
 * allow exactly as before the pane existed.
 */
export function buildAllowDecision(options: {
  persist: boolean
  setMode: WirePermissionMode | null
  editedInput: string | null
  originalInput: unknown
}):
  | {
      ok: true
      decision: {
        behavior: 'allow'
        persist?: boolean
        setMode?: WirePermissionMode
        updatedInput?: Record<string, unknown>
      }
    }
  | { ok: false; error: string } {
  const decision: {
    behavior: 'allow'
    persist?: boolean
    setMode?: WirePermissionMode
    updatedInput?: Record<string, unknown>
  } = { behavior: 'allow' }
  if (options.persist) decision.persist = true
  if (options.setMode) decision.setMode = options.setMode
  if (options.editedInput !== null) {
    const parsed = parseUpdatedInput(options.editedInput)
    if (!parsed.ok) return parsed
    if (
      JSON.stringify(parsed.value) !== JSON.stringify(options.originalInput)
    ) {
      decision.updatedInput = parsed.value
    }
  }
  return { ok: true, decision }
}
