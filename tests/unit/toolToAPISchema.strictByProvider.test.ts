/**
 * Unit test: the broad strict-tool transform is gated on provider wire format.
 *
 * - openai-responses / openai-chat-completions / gemini → strict transform
 *   applies; constraint keywords stripped; `strict: true` set.
 * - anthropic / foundry / vertex / bedrock-converse → transform skipped;
 *   schema passes through unchanged; `strict` not set.
 *
 * This is the regression guard for b767110: we used to apply the OpenAI-
 * shaped strict transform to every provider with `structuredOutputs: true`,
 * including Anthropic-wire providers — but Anthropic's structured-outputs
 * beta caps strict tools at 20 per request, total optional params at 24,
 * and rejects `minimum`/`maximum`/`pattern`/etc., so the broad transform
 * was 400'ing every Anthropic request.
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
  // Minimal stub matching the Tool surface that toolToAPISchema actually
  // touches (name, description, prompt, inputSchema). Other Tool methods are
  // unused in this codepath.
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

describe('toolToAPISchema: broad strict gated on provider wire format', () => {
  beforeEach(() => {
    process.env.TEST_API_KEY = 'sk-test'
  })
  afterEach(() => {
    resetProviderRegistry()
    clearToolSchemaCache()
  })

  test('openai-responses with structuredOutputs=true → strict transform applies', async () => {
    setupProvider('openai', 'openai-responses', 'gpt-test', true)
    const tool = makeFakeTool('FakeTool')
    const schema = (await toolToAPISchema(tool, {
      getToolPermissionContext: async () => ({}) as never,
      tools: [tool],
      agents: [],
      model: 'gpt-test',
    })) as { strict?: boolean; input_schema: Record<string, unknown> }

    expect(schema.strict).toBe(true)
    const inputSchema = schema.input_schema as {
      additionalProperties?: unknown
      required?: string[]
      properties: Record<string, Record<string, unknown>>
    }
    expect(inputSchema.additionalProperties).toBe(false)
    // Every property must appear in `required` for strict mode.
    expect(new Set(inputSchema.required)).toEqual(
      new Set(['file_path', 'offset', 'pattern']),
    )
    // Optional fields widened with null.
    const offset = inputSchema.properties.offset
    expect(JSON.stringify(offset)).toContain('"type":"null"')
    // Strict-disallowed keywords stripped (offset.minimum, pattern.minLength).
    expect(JSON.stringify(inputSchema)).not.toContain('"minimum"')
    expect(JSON.stringify(inputSchema)).not.toContain('"minLength"')
  })

  test('anthropic with structuredOutputs=true → strict transform skipped', async () => {
    setupProvider('anthropic', 'anthropic', 'claude-opus-4-7', true)
    const tool = makeFakeTool('FakeTool')
    const schema = (await toolToAPISchema(tool, {
      getToolPermissionContext: async () => ({}) as never,
      tools: [tool],
      agents: [],
      model: 'claude-opus-4-7',
    })) as { strict?: boolean; input_schema: Record<string, unknown> }

    expect(schema.strict).not.toBe(true)
    const inputSchema = schema.input_schema as {
      required?: string[]
      properties: Record<string, Record<string, unknown>>
    }
    // Optional fields stay out of `required`.
    expect(inputSchema.required).toEqual(['file_path'])
    // Constraint keywords preserved (Anthropic non-strict accepts them).
    expect(JSON.stringify(inputSchema)).toContain('"minimum"')
    expect(JSON.stringify(inputSchema)).toContain('"minLength"')
  })

  test('foundry (Anthropic-wire proxy) → strict transform skipped', async () => {
    setupProvider('foundry', 'foundry', 'claude-opus-4-7', true)
    const tool = makeFakeTool('FakeTool')
    const schema = (await toolToAPISchema(tool, {
      getToolPermissionContext: async () => ({}) as never,
      tools: [tool],
      agents: [],
      model: 'claude-opus-4-7',
    })) as { strict?: boolean; input_schema: Record<string, unknown> }

    expect(schema.strict).not.toBe(true)
    const inputSchema = schema.input_schema as { required?: string[] }
    expect(inputSchema.required).toEqual(['file_path'])
  })

  test('gemini with structuredOutputs=true → strict transform applies', async () => {
    setupProvider('gemini', 'gemini', 'gemini-test', true)
    const tool = makeFakeTool('FakeTool')
    const schema = (await toolToAPISchema(tool, {
      getToolPermissionContext: async () => ({}) as never,
      tools: [tool],
      agents: [],
      model: 'gemini-test',
    })) as { strict?: boolean; input_schema: Record<string, unknown> }

    expect(schema.strict).toBe(true)
    const inputSchema = schema.input_schema as {
      additionalProperties?: unknown
    }
    expect(inputSchema.additionalProperties).toBe(false)
  })
})
