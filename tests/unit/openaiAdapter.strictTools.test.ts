/**
 * Unit test: OpenAI Chat Completions adapter `strict: true` gating per tool.
 *
 * Tool-owned schemas (MCP servers / StructuredOutput) and `.passthrough()`
 * opt-outs skip `makeJsonSchemaStrict` in toolToAPISchema, so they reach the
 * adapter without the strict-shape invariants OpenAI requires. Setting
 * `strict: true` on them would 400 the entire request — one rogue MCP tool
 * kills every turn. The adapter detects strict-compatible schemas via the
 * root-level `additionalProperties: false` marker and only emits the wire
 * strict flag for those.
 */
import { describe, expect, test, afterEach, beforeEach } from 'bun:test'
import { createChatCompletionsFetch } from '../../src/services/api/openai-chat-completions-adapter.js'
import {
  initProviderRegistry,
  resetProviderRegistry,
} from '../../src/utils/model/providerRegistry.js'
import type { ProviderConfig } from '../../src/utils/settings/types.js'

type CapturedBody = {
  tools?: Array<{
    type?: string
    function?: {
      name?: string
      strict?: boolean
      parameters?: unknown
    }
  }>
}

function setupProvider(structuredOutputs: boolean) {
  resetProviderRegistry()
  const providers: Record<string, ProviderConfig> = {
    openai: {
      type: 'openai-chat-completions',
      baseUrl: 'http://localhost/v1',
      auth: { active: 'apiKey', apiKey: { keyEnv: 'TEST_API_KEY' } },
      models: [{ id: 'gpt-test', structuredOutputs }],
    },
  }
  initProviderRegistry(providers)
}

async function runAdapterWithTools(
  structuredOutputs: boolean,
  tools: Array<{ name: string; input_schema: unknown }>,
): Promise<CapturedBody> {
  let captured: CapturedBody = {}
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    if (typeof init?.body === 'string') {
      captured = JSON.parse(init.body)
    }
    const sse =
      'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}\n\n' +
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
      'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":1}}\n\n' +
      'data: [DONE]\n\n'
    return new Response(sse, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })
  }) as unknown as typeof globalThis.fetch
  try {
    setupProvider(structuredOutputs)
    const adapterFetch = createChatCompletionsFetch(
      {
        type: 'openai-chat-completions',
        baseUrl: 'http://localhost/v1',
        models: [{ id: 'gpt-test' }],
        auth: { active: 'apiKey', apiKey: { key: 'k' } },
      },
      { Authorization: 'Bearer k' },
    )
    const response = await adapterFetch('http://localhost/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-test',
        messages: [{ role: 'user', content: 'hi' }],
        tools,
      }),
    })
    if (response.body) {
      const reader = response.body.getReader()
      while (!(await reader.read()).done) {
        /* drain */
      }
    }
    return captured
  } finally {
    globalThis.fetch = originalFetch
    resetProviderRegistry()
  }
}

describe('OpenAI Chat Completions adapter: strict tool gating', () => {
  beforeEach(() => {
    process.env.TEST_API_KEY = 'sk-test'
  })
  afterEach(() => {
    resetProviderRegistry()
  })

  test('structuredOutputs=true + strict-shaped schema → strict: true on wire', async () => {
    const captured = await runAdapterWithTools(true, [
      {
        name: 'StrictTool',
        input_schema: {
          type: 'object',
          properties: { x: { type: 'string' } },
          required: ['x'],
          additionalProperties: false,
        },
      },
    ])
    const tool = captured.tools?.[0]
    expect(tool?.function?.name).toBe('StrictTool')
    expect(tool?.function?.strict).toBe(true)
  })

  test('structuredOutputs=true + tool-owned schema (no additionalProperties:false) → strict omitted', async () => {
    const captured = await runAdapterWithTools(true, [
      // Mimics an MCP tool / StructuredOutput shape: caller-controlled, no
      // additionalProperties:false marker because it skipped
      // makeJsonSchemaStrict.
      {
        name: 'mcp__server__tool',
        input_schema: {
          type: 'object',
          properties: { foo: { type: 'string' } },
        },
      },
    ])
    const tool = captured.tools?.[0]
    expect(tool?.function?.name).toBe('mcp__server__tool')
    expect(tool?.function?.strict).toBeUndefined()
  })

  test('structuredOutputs=true + passthrough schema (additionalProperties:{}) → strict omitted', async () => {
    const captured = await runAdapterWithTools(true, [
      // Mimics a Zod .passthrough() schema preserved by makeJsonSchemaStrict.
      {
        name: 'ExitPlanMode',
        input_schema: {
          type: 'object',
          properties: {},
          additionalProperties: {},
        },
      },
    ])
    const tool = captured.tools?.[0]
    expect(tool?.function?.strict).toBeUndefined()
  })

  test('structuredOutputs=false → strict omitted regardless of schema', async () => {
    const captured = await runAdapterWithTools(false, [
      {
        name: 'StrictTool',
        input_schema: {
          type: 'object',
          properties: { x: { type: 'string' } },
          required: ['x'],
          additionalProperties: false,
        },
      },
    ])
    const tool = captured.tools?.[0]
    expect(tool?.function?.strict).toBeUndefined()
  })

  test('mixed tools: strict-shaped emits strict, MCP-style omits — same request', async () => {
    const captured = await runAdapterWithTools(true, [
      {
        name: 'StrictTool',
        input_schema: {
          type: 'object',
          properties: { x: { type: 'string' } },
          required: ['x'],
          additionalProperties: false,
        },
      },
      {
        name: 'mcp__server__tool',
        input_schema: {
          type: 'object',
          properties: { foo: { type: 'string' } },
        },
      },
    ])
    const byName = Object.fromEntries(
      (captured.tools ?? []).map(t => [t.function?.name, t.function?.strict]),
    )
    expect(byName['StrictTool']).toBe(true)
    expect(byName['mcp__server__tool']).toBeUndefined()
  })
})
