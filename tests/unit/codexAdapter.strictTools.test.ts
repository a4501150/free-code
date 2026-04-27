/**
 * Unit test: Codex (OpenAI Responses API) adapter `strict` gating per tool.
 *
 * Tool-owned schemas (MCP servers / StructuredOutput) and `.passthrough()`
 * opt-outs reach the adapter without `additionalProperties: false`. Setting
 * `strict: true` on them would 400 the entire request. The adapter detects
 * strict-compatible schemas via the root marker and only emits `strict: true`
 * for those when the model declares `structuredOutputs: true`. When the
 * model declares `structuredOutputs: false`, every tool gets `strict: false`
 * (explicit best-effort, unchanged). When undefined, the field is omitted.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createCodexFetch } from '../../src/services/api/codex-fetch-adapter.js'
import {
  initProviderRegistry,
  resetProviderRegistry,
} from '../../src/utils/model/providerRegistry.js'
import type { ProviderConfig } from '../../src/utils/settings/types.js'

type CapturedBody = {
  tools?: Array<{
    type?: string
    name?: string
    strict?: boolean
    parameters?: unknown
  }>
}

function setupProvider(structuredOutputs: boolean | undefined) {
  resetProviderRegistry()
  const providers: Record<string, ProviderConfig> = {
    codex: {
      type: 'openai-responses',
      auth: { active: 'apiKey', apiKey: { keyEnv: 'TEST_API_KEY' } },
      models: [
        {
          id: 'gpt-test',
          ...(structuredOutputs === undefined ? {} : { structuredOutputs }),
        },
      ],
    },
  }
  initProviderRegistry(providers)
}

async function runAdapterWithTools(
  structuredOutputs: boolean | undefined,
  tools: Array<{ name: string; input_schema: unknown }>,
): Promise<CapturedBody> {
  let captured: CapturedBody = {}
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    if (typeof init?.body === 'string') {
      captured = JSON.parse(init.body)
    }
    const sse = [
      'event: response.completed',
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":0}}}',
      '',
      '',
    ].join('\n')
    return new Response(sse, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })
  }) as unknown as typeof globalThis.fetch
  try {
    setupProvider(structuredOutputs)
    const adapterFetch = createCodexFetch({
      accessToken: 'unused',
      baseUrl: 'http://localhost',
      getSessionId: () => 'test-session',
    })
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

describe('Codex adapter: strict tool gating', () => {
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
    expect(tool?.name).toBe('StrictTool')
    expect(tool?.strict).toBe(true)
  })

  test('structuredOutputs=true + tool-owned schema → strict omitted', async () => {
    const captured = await runAdapterWithTools(true, [
      {
        name: 'mcp__server__tool',
        input_schema: {
          type: 'object',
          properties: { foo: { type: 'string' } },
        },
      },
    ])
    const tool = captured.tools?.[0]
    expect(tool?.name).toBe('mcp__server__tool')
    expect(tool?.strict).toBeUndefined()
  })

  test('structuredOutputs=true + passthrough schema → strict omitted', async () => {
    const captured = await runAdapterWithTools(true, [
      {
        name: 'ExitPlanMode',
        input_schema: {
          type: 'object',
          properties: {},
          additionalProperties: {},
        },
      },
    ])
    expect(captured.tools?.[0]?.strict).toBeUndefined()
  })

  test('structuredOutputs=false → strict: false on every tool (unchanged)', async () => {
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
      {
        name: 'mcp__server__tool',
        input_schema: {
          type: 'object',
          properties: { foo: { type: 'string' } },
        },
      },
    ])
    const byName = Object.fromEntries(
      (captured.tools ?? []).map(t => [t.name, t.strict]),
    )
    expect(byName['StrictTool']).toBe(false)
    expect(byName['mcp__server__tool']).toBe(false)
  })

  test('structuredOutputs=undefined → strict omitted everywhere', async () => {
    const captured = await runAdapterWithTools(undefined, [
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
    expect(captured.tools?.[0]?.strict).toBeUndefined()
  })

  test('mixed tools: strict-shaped emits strict, MCP omits — same request', async () => {
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
      (captured.tools ?? []).map(t => [t.name, t.strict]),
    )
    expect(byName['StrictTool']).toBe(true)
    expect(byName['mcp__server__tool']).toBeUndefined()
  })
})
