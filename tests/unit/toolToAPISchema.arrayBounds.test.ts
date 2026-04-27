/**
 * Strict-disallowed validation keywords are now stripped universally on the
 * Zod-derived strict-shape path (see toolToAPISchema in src/utils/api.ts).
 * Anthropic strict-tools rejects them; OpenAI strict rejects a few of them
 * (`format: "uri"`, etc.); the bounds the model needs are documented in
 * `.describe()` text on each affected tool's Zod schema. Stripping universally
 * keeps one schema shape across all providers.
 */
import { describe, expect, test } from 'bun:test'
import { AskUserQuestionTool } from '../../src/tools/AskUserQuestionTool/AskUserQuestionTool.js'
import { toolToAPISchema } from '../../src/utils/api.js'

function findStrictDisallowed(value: unknown, path = '$'): string[] {
  if (typeof value !== 'object' || value === null) {
    return []
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      findStrictDisallowed(item, `${path}[${index}]`),
    )
  }

  const node = value as Record<string, unknown>
  const hits: string[] = []
  // Scope to keywords disallowed inside strict mode (both OpenAI structured
  // outputs and Anthropic structured-outputs reject these — see
  // STRICT_DISALLOWED_KEYWORDS in src/utils/api.ts).
  for (const k of [
    'minimum',
    'maximum',
    'exclusiveMinimum',
    'exclusiveMaximum',
    'multipleOf',
    'minLength',
    'maxLength',
    'pattern',
    'format',
    'minItems',
    'maxItems',
    'uniqueItems',
  ]) {
    if (k in node) hits.push(`${path}.${k}`)
  }

  for (const [key, child] of Object.entries(node)) {
    hits.push(...findStrictDisallowed(child, `${path}.${key}`))
  }
  return hits
}

describe('toolToAPISchema strict-disallowed keyword stripping', () => {
  test('strict-shape path strips constraint keywords (universal)', async () => {
    // AskUserQuestionTool's `questions` and nested `options` arrays carry
    // .min/.max bounds that surface as minItems/maxItems in the raw Zod
    // JSON Schema. Those bounds are now in the field descriptions
    // ("Questions to ask the user (1-4 questions)" / "Must have 2-4
    // options") and the schema itself is stripped clean.
    const schema = await toolToAPISchema(AskUserQuestionTool, {
      getToolPermissionContext: async () => ({}) as never,
      tools: [AskUserQuestionTool],
      agents: [],
    })

    const hits = findStrictDisallowed(schema)
    expect(hits).toEqual([])
  })
})
