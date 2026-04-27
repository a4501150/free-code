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
  test('non-strict path preserves JSON Schema constraints (Anthropic accepts them)', async () => {
    // Without a model OR with an Anthropic-wire provider, no strict transform
    // applies, and constraint keywords (minItems/maxItems/minimum/maximum/…)
    // are passed through. This is correct: only strict mode rejects them, and
    // we don't want to silently lose validation info on the Anthropic path.
    const schema = await toolToAPISchema(AskUserQuestionTool, {
      getToolPermissionContext: async () => ({}) as never,
      tools: [AskUserQuestionTool],
      agents: [],
    })

    const hits = findStrictDisallowed(schema)
    // AskUserQuestionTool's `questions` and nested `options` arrays carry
    // .min/.max bounds that surface as minItems/maxItems.
    expect(hits.length).toBeGreaterThan(0)
    expect(hits).toContain('$.input_schema.properties.questions.minItems')
    expect(hits).toContain('$.input_schema.properties.questions.maxItems')
  })
})
