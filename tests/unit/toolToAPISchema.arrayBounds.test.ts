/**
 * Strict-disallowed validation keywords are now stripped universally on the
 * Zod-derived strict-shape path (see toolToAPISchema in src/utils/api.ts).
 * Anthropic strict-tools rejects them; OpenAI strict rejects a few of them
 * (`format: "uri"`, etc.); the bounds the model needs are documented in
 * `.describe()` text on each affected tool's Zod schema. Stripping universally
 * keeps one schema shape across all providers.
 */
import { describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import { AskUserQuestionTool } from '../../src/tools/AskUserQuestionTool/AskUserQuestionTool.js'
import { GlobTool } from '../../src/tools/GlobTool/GlobTool.js'
import { GrepTool } from '../../src/tools/GrepTool/GrepTool.js'
import { toolToAPISchema } from '../../src/utils/api.js'
import { makeJsonSchemaStrict } from '../../src/utils/jsonSchemaStrict.js'
import { zodToJsonSchema } from '../../src/utils/zodToJsonSchema.js'

const SCHEMA_MAP_KEYS = new Set([
  'properties',
  '$defs',
  'definitions',
  'patternProperties',
  'dependentSchemas',
])

function findStrictDisallowed(
  value: unknown,
  path = '$',
  isSchemaMap = false,
): string[] {
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
  if (!isSchemaMap) {
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
  }

  for (const [key, child] of Object.entries(node)) {
    hits.push(
      ...findStrictDisallowed(
        child,
        `${path}.${key}`,
        SCHEMA_MAP_KEYS.has(key),
      ),
    )
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

  test('preserves legitimate pattern properties for Grep and Glob', async () => {
    for (const tool of [GrepTool, GlobTool]) {
      const schema = await toolToAPISchema(tool, {
        getToolPermissionContext: async () => ({}) as never,
        tools: [tool],
        agents: [],
      })
      const inputSchema = schema.input_schema as {
        properties: Record<string, unknown>
      }
      expect(inputSchema.properties.pattern).toBeDefined()
      expect(findStrictDisallowed(schema)).toEqual([])
    }
  })

  test('preserves typed and unknown record value schemas', () => {
    const schema = makeJsonSchemaStrict(
      zodToJsonSchema(
        z.strictObject({
          typed: z.record(z.string(), z.string()),
          unknown: z.record(z.string(), z.unknown()),
        }),
      ),
    ) as {
      properties: Record<string, { additionalProperties: unknown }>
    }

    expect(schema.properties.typed.additionalProperties).toMatchObject({
      type: 'string',
    })
    expect(schema.properties.unknown.additionalProperties).toEqual({})
  })
})
