/**
 * Unit tests: parallel_tool_calls flag in the chat-completions request body.
 *
 * OpenAI-compatible stacks that treat an absent flag as false drop all but
 * the first tool call, silently serializing multi-tool assistant turns.
 */
import { describe, test, expect } from 'bun:test'
import { openaiChatCompletionsAdapter } from '../../src/services/api/adapters/openai-chat-completions-adapter-impl.js'
import type { ProviderConfig } from '../../src/utils/settings/types.js'
import type { DomainMessageRequest } from '../../src/services/api/domain-transport.js'

const testConfig: ProviderConfig = {
  type: 'openai-chat-completions',
  baseUrl: 'http://localhost:9999/v1',
  models: [{ id: 'qwen' }],
  auth: { active: 'apiKey', apiKey: { key: 'test-key' } },
}

const sseDone = new Response('data: [DONE]\n\n', {
  status: 200,
  headers: { 'Content-Type': 'text/event-stream' },
})

async function capturedBody(
  request: DomainMessageRequest,
): Promise<Record<string, unknown>> {
  let sent: Record<string, unknown> = {}
  await openaiChatCompletionsAdapter.createStream(
    testConfig,
    request,
    new AbortController().signal,
    (async (_input: unknown, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body)) as Record<string, unknown>
      return sseDone.clone()
    }) as unknown as typeof globalThis.fetch,
  )
  return sent
}

const baseRequest: DomainMessageRequest = {
  model: 'qwen',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
  maxTokens: 64,
}

const tools = [
  { name: 'tool_a', input_schema: { type: 'object', properties: {} } },
  { name: 'tool_b', input_schema: { type: 'object', properties: {} } },
]

describe('chat-completions body: parallel_tool_calls', () => {
  test('is true when the request has tools', async () => {
    const body = await capturedBody({ ...baseRequest, tools })
    expect(body.parallel_tool_calls).toBe(true)
    expect(body.tool_choice).toBe('auto')
    expect(body.tools).toBeDefined()
  })

  test('is absent when the request has no tools', async () => {
    const body = await capturedBody(baseRequest)
    expect('parallel_tool_calls' in body).toBe(false)
    expect('tools' in body).toBe(false)
  })
})
