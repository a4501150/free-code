/**
 * Unit tests: Bedrock Converse prompt caching.
 *
 * Converse expresses a cache breakpoint as a standalone `cachePoint` entry in
 * `system[]`, `toolConfig.tools[]` or `messages[].content[]`, rather than as a
 * field on the block it follows. The adapter used to drop our `cache_control`
 * markers entirely, which meant Bedrock got no prompt caching at all.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { bedrockAdapter } from '../../src/services/api/adapters/bedrock-adapter-impl.js'
import type { ProviderConfig } from '../../src/utils/settings/types.js'
import type { DomainMessageRequest } from '../../src/services/api/domain-transport.js'

const testConfig: ProviderConfig = {
  type: 'bedrock-converse',
  baseUrl: 'http://localhost:9999',
  models: [{ id: 'us.anthropic.claude-sonnet-4-6' }],
  auth: { aws: { region: 'us-east-1' } },
} as ProviderConfig

let previousSkipAuth: string | undefined
beforeAll(() => {
  previousSkipAuth = process.env.CLAUDE_CODE_SKIP_BEDROCK_AUTH
  process.env.CLAUDE_CODE_SKIP_BEDROCK_AUTH = '1'
})
afterAll(() => {
  if (previousSkipAuth === undefined) {
    delete process.env.CLAUDE_CODE_SKIP_BEDROCK_AUTH
  } else {
    process.env.CLAUDE_CODE_SKIP_BEDROCK_AUTH = previousSkipAuth
  }
})

function eventStreamResponse() {
  return () =>
    new Response(new Uint8Array(0), {
      status: 200,
      headers: { 'content-type': 'application/vnd.amazon.eventstream' },
    })
}

async function capturedBody(
  request: DomainMessageRequest,
): Promise<Record<string, unknown>> {
  let captured: Record<string, unknown> = {}
  const fetchOverride = (async (_url: string, init: RequestInit) => {
    captured = JSON.parse(init.body as string)
    return eventStreamResponse()()
  }) as unknown as typeof globalThis.fetch

  const streaming = await bedrockAdapter.createStream(
    testConfig,
    request,
    new AbortController().signal,
    fetchOverride,
  )
  for await (const _ of streaming.stream) {
    // drain
  }
  return captured
}

describe('bedrock cachePoint serialization', () => {
  test('translates a system cache_control into a system cachePoint', async () => {
    const body = await capturedBody({
      model: 'us.anthropic.claude-sonnet-4-6',
      maxTokens: 1024,
      system: [
        { type: 'text', text: 'uncached prefix' },
        {
          type: 'text',
          text: 'cached body',
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
    })

    expect(body.system).toEqual([
      { text: 'uncached prefix' },
      { text: 'cached body' },
      { cachePoint: { type: 'default' } },
    ])
  })

  test('translates a tool cache_control into a tools cachePoint', async () => {
    const body = await capturedBody({
      model: 'us.anthropic.claude-sonnet-4-6',
      maxTokens: 1024,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
      tools: [
        { name: 'first', input_schema: { type: 'object', properties: {} } },
        {
          name: 'last',
          input_schema: { type: 'object', properties: {} },
          cache_control: { type: 'ephemeral' },
        },
      ],
    })

    const tools = (body.toolConfig as { tools: unknown[] }).tools
    expect(tools).toHaveLength(3)
    expect(tools[2]).toEqual({ cachePoint: { type: 'default' } })
  })

  test('translates a message cache_control into a content cachePoint', async () => {
    const body = await capturedBody({
      model: 'us.anthropic.claude-sonnet-4-6',
      maxTokens: 1024,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Hi' },
            {
              type: 'text',
              text: 'last',
              cache_control: { type: 'ephemeral' },
            },
          ],
        },
      ],
    })

    const messages = body.messages as Array<{ content: unknown[] }>
    expect(messages[0]?.content).toEqual([
      { text: 'Hi' },
      { text: 'last' },
      { cachePoint: { type: 'default' } },
    ])
  })

  test('propagates the 1h ttl', async () => {
    const body = await capturedBody({
      model: 'us.anthropic.claude-sonnet-4-6',
      maxTokens: 1024,
      system: [
        {
          type: 'text',
          text: 'cached body',
          cache_control: { type: 'ephemeral', ttl: '1h' },
        },
      ],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
    })

    expect(body.system).toEqual([
      { text: 'cached body' },
      { cachePoint: { type: 'default', ttl: '1h' } },
    ])
  })

  test('emits no cachePoint when nothing is marked', async () => {
    const body = await capturedBody({
      model: 'us.anthropic.claude-sonnet-4-6',
      maxTokens: 1024,
      system: [{ type: 'text', text: 'plain' }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
      tools: [
        { name: 'only', input_schema: { type: 'object', properties: {} } },
      ],
    })

    expect(JSON.stringify(body)).not.toContain('cachePoint')
  })

  test('stays within the Converse limit of 4 cache points', async () => {
    const body = await capturedBody({
      model: 'us.anthropic.claude-sonnet-4-6',
      maxTokens: 1024,
      system: [
        {
          type: 'text',
          text: 'system',
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Hi',
              cache_control: { type: 'ephemeral' },
            },
          ],
        },
      ],
      tools: [
        {
          name: 'only',
          input_schema: { type: 'object', properties: {} },
          cache_control: { type: 'ephemeral' },
        },
      ],
    })

    const count = JSON.stringify(body).split('"cachePoint"').length - 1
    expect(count).toBe(3)
    expect(count).toBeLessThanOrEqual(4)
  })
})
