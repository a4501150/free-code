/**
 * Unit test: universal strict-shape, selective wire `strict: true`.
 *
 * Design (see ANTHROPIC_STRICT_TOOL_NAMES + shouldEmitWireStrictForAnthropic
 * in src/utils/api.ts):
 *
 *   - Every Zod-derived tool schema is rewritten to strict shape regardless
 *     of provider: `additionalProperties: false` on every object, every
 *     property in `required`, optional fields widened with null. Strict-
 *     disallowed validation keywords (`minimum`, `minLength`, `pattern`,
 *     `format`, `minItems`, etc.) are stripped at the same time.
 *
 *   - The wire-level `strict: true` flag is emitted only on the Anthropic-
 *     wire allowlist (FileEdit, FileWrite, FileRead) when the resolved model
 *     declares `structuredOutputs: true`. OpenAI Chat / Responses adapters
 *     emit `strict: true` for ALL tools downstream from the model flag (not
 *     tested here — adapter-level concern). Gemini never emits strict.
 *
 *   - Anthropic-wire non-allowlist tools and Anthropic models without
 *     `structuredOutputs: true` get the strict-shape but no wire flag.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import {
  initProviderRegistry,
  resetProviderRegistry,
} from '../../src/utils/model/providerRegistry.js'
import type { ProviderConfig } from '../../src/utils/settings/types.js'
import type { Tool } from '../../src/Tool.js'
import { toolToAPISchema } from '../../src/utils/api.js'
import { clearToolSchemaCache } from '../../src/utils/toolSchemaCache.js'

const fakeToolSchema = z.object({
  file_path: z.string(),
  offset: z.number().int().min(0).optional(),
  pattern: z.string().min(1).optional(),
})

function makeFakeTool(name: string): Tool {
  return {
    name,
    description: () => Promise.resolve('test tool'),
    prompt: async () => 'test tool',
    inputSchema: fakeToolSchema,
    inputJSONSchema: undefined,
    isReadOnly: () => true,
    isEnabled: () => true,
    needsPermissions: () => false,
    isConcurrencySafe: () => true,
    userFacingName: () => name,
    renderToolUseMessage: () => '',
    renderToolUseRejectedMessage: () => null,
    renderResultForAssistant: () => '',
    renderToolResultMessage: () => null,
    call: async function* () {},
  } as unknown as Tool
}

function setupProvider(
  name: string,
  type: ProviderConfig['type'],
  modelId: string,
  structuredOutputs: boolean,
) {
  resetProviderRegistry()
  clearToolSchemaCache()
  const providers: Record<string, ProviderConfig> = {
    [name]: {
      type,
      auth: {
        active: 'apiKey',
        apiKey: { keyEnv: 'TEST_API_KEY' },
      },
      models: [
        {
          id: modelId,
          label: modelId,
          structuredOutputs,
        },
      ],
    },
  }
  initProviderRegistry(providers)
}

describe('toolToAPISchema: universal strict-shape + selective wire strict', () => {
  beforeEach(() => {
    process.env.TEST_API_KEY = 'sk-test'
  })
  afterEach(() => {
    resetProviderRegistry()
    clearToolSchemaCache()
  })

  test('any provider: every Zod-derived tool gets strict-shape', async () => {
    setupProvider('anthropic', 'anthropic', 'claude-test', false)
    const tool = makeFakeTool('FakeTool')
    const schema = (await toolToAPISchema(tool, {
      getToolPermissionContext: async () => ({}) as never,
      tools: [tool],
      agents: [],
      model: 'claude-test',
    })) as { strict?: boolean; input_schema: Record<string, unknown> }

    const inputSchema = schema.input_schema as {
      additionalProperties?: unknown
      required?: string[]
      properties: Record<string, Record<string, unknown>>
    }
    expect(inputSchema.additionalProperties).toBe(false)
    expect(new Set(inputSchema.required)).toEqual(
      new Set(['file_path', 'offset', 'pattern']),
    )
    // Optional fields widened with null union.
    const offset = inputSchema.properties.offset
    // The widenWithNull function emits flat type arrays: type: ["number", "null"].
    // Check that the type includes null (as array element or standalone).
    expect(offset.type).toEqual(expect.arrayContaining(['null']))
    // Strict-disallowed keywords stripped universally so the same schema
    // bytes work everywhere (Anthropic-strict allowlist + OpenAI strict).
    expect(JSON.stringify(inputSchema)).not.toContain('"minimum"')
    expect(JSON.stringify(inputSchema)).not.toContain('"minLength"')
  })

  test('Anthropic non-allowlist tool: strict-shape but no wire strict flag', async () => {
    setupProvider('anthropic', 'anthropic', 'claude-test', true)
    const tool = makeFakeTool('FakeTool') // not in allowlist
    const schema = (await toolToAPISchema(tool, {
      getToolPermissionContext: async () => ({}) as never,
      tools: [tool],
      agents: [],
      model: 'claude-test',
    })) as { strict?: boolean }

    expect(schema.strict).not.toBe(true)
  })

  test('Anthropic allowlist tool + structuredOutputs model: wire strict emitted', async () => {
    setupProvider('anthropic', 'anthropic', 'claude-test', true)
    const tool = makeFakeTool('FileRead')
    const schema = (await toolToAPISchema(tool, {
      getToolPermissionContext: async () => ({}) as never,
      tools: [tool],
      agents: [],
      model: 'claude-test',
    })) as { strict?: boolean }

    expect(schema.strict).toBe(true)
  })

  test('Anthropic allowlist tool + non-structuredOutputs model: no wire strict', async () => {
    setupProvider('anthropic', 'anthropic', 'claude-old', false)
    const tool = makeFakeTool('FileRead')
    const schema = (await toolToAPISchema(tool, {
      getToolPermissionContext: async () => ({}) as never,
      tools: [tool],
      agents: [],
      model: 'claude-old',
    })) as { strict?: boolean }

    expect(schema.strict).not.toBe(true)
  })

  test('foundry (Anthropic-wire proxy) allowlist tool: wire strict emitted', async () => {
    setupProvider('foundry', 'foundry', 'claude-test', true)
    const tool = makeFakeTool('FileEdit')
    const schema = (await toolToAPISchema(tool, {
      getToolPermissionContext: async () => ({}) as never,
      tools: [tool],
      agents: [],
      model: 'claude-test',
    })) as { strict?: boolean }

    expect(schema.strict).toBe(true)
  })

  test('OpenAI provider: strict-shape but no wire strict from toolToAPISchema (adapter sets it)', async () => {
    // OpenAI Chat / Responses adapters emit strict from the model's
    // `structuredOutputs` flag uniformly across all tools — that path is
    // adapter-internal. toolToAPISchema does not duplicate it on the
    // BetaTool itself, so the field is absent here.
    setupProvider('openai', 'openai-responses', 'gpt-test', true)
    const tool = makeFakeTool('FakeTool')
    const schema = (await toolToAPISchema(tool, {
      getToolPermissionContext: async () => ({}) as never,
      tools: [tool],
      agents: [],
      model: 'gpt-test',
    })) as { strict?: boolean; input_schema: Record<string, unknown> }

    expect(schema.strict).not.toBe(true)
    const inputSchema = schema.input_schema as {
      additionalProperties?: unknown
    }
    expect(inputSchema.additionalProperties).toBe(false)
  })

  test('Gemini: strict-shape but never wire strict', async () => {
    setupProvider('gemini', 'gemini', 'gemini-test', true)
    const tool = makeFakeTool('FileEdit')
    const schema = (await toolToAPISchema(tool, {
      getToolPermissionContext: async () => ({}) as never,
      tools: [tool],
      agents: [],
      model: 'gemini-test',
    })) as { strict?: boolean; input_schema: Record<string, unknown> }

    expect(schema.strict).not.toBe(true)
    const inputSchema = schema.input_schema as {
      additionalProperties?: unknown
    }
    expect(inputSchema.additionalProperties).toBe(false)
  })
})
