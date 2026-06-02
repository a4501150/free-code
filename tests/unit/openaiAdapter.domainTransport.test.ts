/**
 * Unit tests: OpenAI Chat Completions adapter domain transport.
 *
 * Tests createStream() and createMessage() which produce DomainStreamEvents
 * directly from OpenAI SSE responses without going through the Anthropic SDK.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { openaiChatCompletionsAdapter } from '../../src/services/api/adapters/openai-chat-completions-adapter-impl.js'
import type { ProviderConfig } from '../../src/utils/settings/types.js'
import type { DomainMessageRequest } from '../../src/services/api/domain-transport.js'
import type { DomainStreamEvent } from '../../src/types/domain.js'

const testConfig: ProviderConfig = {
  type: 'openai-chat-completions',
  baseUrl: 'http://localhost:9999/v1',
  models: [{ id: 'gpt-4o' }],
  auth: { active: 'apiKey', apiKey: { key: 'test-key' } },
}

const authArgs = { Authorization: 'Bearer test-key' }

function makeRequest(overrides?: Partial<DomainMessageRequest>): DomainMessageRequest {
  return {
    model: 'gpt-4o',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
    ],
    maxTokens: 1024,
    ...overrides,
  }
}

function sseResponse(chunks: string[]): Response {
  const body = chunks.join('')
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'x-request-id': 'req-test-123',
    },
  })
}

let originalFetch: typeof globalThis.fetch

beforeEach(() => {
  originalFetch = globalThis.fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

async function collectEvents(
  stream: AsyncIterable<DomainStreamEvent>,
): Promise<DomainStreamEvent[]> {
  const events: DomainStreamEvent[] = []
  for await (const event of stream) {
    events.push(event)
  }
  return events
}

describe('OpenAI CC adapter: createStream', () => {
  test('emits correct domain stream lifecycle for text response', async () => {
    globalThis.fetch = async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}\n\n',
        'data: {"choices":[{"delta":{"content":" world"},"finish_reason":null}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n',
        'data: [DONE]\n\n',
      ])

    const result = await openaiChatCompletionsAdapter.createStream(
      testConfig,
      authArgs,
      makeRequest(),
      new AbortController().signal,
    )

    const events = await collectEvents(result.stream)
    result.release()

    expect(events[0].type).toBe('message_start')
    expect(events[1].type).toBe('content_block_start')
    if (events[1].type === 'content_block_start') {
      expect(events[1].content_block.type).toBe('text')
    }
    expect(events[2].type).toBe('content_block_delta')
    if (events[2].type === 'content_block_delta') {
      expect(events[2].delta).toEqual({ type: 'text_delta', text: 'Hello' })
    }
    expect(events[3].type).toBe('content_block_delta')
    if (events[3].type === 'content_block_delta') {
      expect(events[3].delta).toEqual({ type: 'text_delta', text: ' world' })
    }
    expect(events[4].type).toBe('content_block_stop')
    expect(events[5].type).toBe('message_delta')
    if (events[5].type === 'message_delta') {
      expect(events[5].delta.stop_reason).toBe('end_turn')
      expect(events[5].usage?.input_tokens).toBe(10)
      expect(events[5].usage?.output_tokens).toBe(5)
    }
    expect(events[6].type).toBe('message_stop')
  })

  test('emits tool_use blocks for tool calls', async () => {
    globalThis.fetch = async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_abc","type":"function","function":{"name":"read_file","arguments":""}}]},"finish_reason":null}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":"}}]},"finish_reason":null}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"test.txt\\"}"}}]},"finish_reason":null}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":8,"completion_tokens":3}}\n\n',
        'data: [DONE]\n\n',
      ])

    const result = await openaiChatCompletionsAdapter.createStream(
      testConfig,
      authArgs,
      makeRequest(),
      new AbortController().signal,
    )
    const events = await collectEvents(result.stream)
    result.release()

    const toolStart = events.find(
      e => e.type === 'content_block_start' && e.content_block.type === 'tool_use',
    )
    expect(toolStart).toBeDefined()
    if (toolStart?.type === 'content_block_start' && toolStart.content_block.type === 'tool_use') {
      expect(toolStart.content_block.id).toBe('call_abc')
      expect(toolStart.content_block.name).toBe('read_file')
    }

    const inputDeltas = events.filter(
      e => e.type === 'content_block_delta' && e.delta.type === 'input_json_delta',
    )
    expect(inputDeltas.length).toBe(2)

    const messageDelta = events.find(e => e.type === 'message_delta')
    if (messageDelta?.type === 'message_delta') {
      expect(messageDelta.delta.stop_reason).toBe('tool_use')
    }
  })

  test('emits reasoning blocks for reasoning_content', async () => {
    globalThis.fetch = async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"reasoning_content":"Let me think"},"finish_reason":null}]}\n\n',
        'data: {"choices":[{"delta":{"reasoning_content":"..."},"finish_reason":null}]}\n\n',
        'data: {"choices":[{"delta":{"content":"The answer is 42."},"finish_reason":null}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":10}}\n\n',
        'data: [DONE]\n\n',
      ])

    const result = await openaiChatCompletionsAdapter.createStream(
      testConfig,
      authArgs,
      makeRequest(),
      new AbortController().signal,
    )
    const events = await collectEvents(result.stream)
    result.release()

    const reasoningStart = events.find(
      e => e.type === 'content_block_start' && e.content_block.type === 'reasoning',
    )
    expect(reasoningStart).toBeDefined()

    const thinkingDeltas = events.filter(
      e => e.type === 'content_block_delta' && e.delta.type === 'thinking_delta',
    )
    expect(thinkingDeltas.length).toBe(2)

    const textStart = events.find(
      e => e.type === 'content_block_start' && e.content_block.type === 'text',
    )
    expect(textStart).toBeDefined()
  })

  test('handles cache token breakdown', async () => {
    globalThis.fetch = async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":5,"prompt_tokens_details":{"cached_tokens":60}}}\n\n',
        'data: [DONE]\n\n',
      ])

    const result = await openaiChatCompletionsAdapter.createStream(
      testConfig,
      authArgs,
      makeRequest(),
      new AbortController().signal,
    )
    const events = await collectEvents(result.stream)
    result.release()

    const messageDelta = events.find(e => e.type === 'message_delta')
    if (messageDelta?.type === 'message_delta') {
      expect(messageDelta.usage?.input_tokens).toBe(40)
      expect(messageDelta.usage?.cache_read_input_tokens).toBe(60)
      expect(messageDelta.usage?.cache_creation_input_tokens).toBeNull()
    }
  })

  test('throws DomainTransportError on HTTP error', async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          error: { code: 'invalid_api_key', message: 'Invalid API key' },
        }),
        { status: 401 },
      )

    await expect(
      openaiChatCompletionsAdapter.createStream(
        testConfig,
        authArgs,
        makeRequest(),
        new AbortController().signal,
      ),
    ).rejects.toThrow('Invalid API key')
  })

  test('sets requestId from response headers', async () => {
    globalThis.fetch = async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n',
        'data: [DONE]\n\n',
      ])

    const result = await openaiChatCompletionsAdapter.createStream(
      testConfig,
      authArgs,
      makeRequest(),
      new AbortController().signal,
    )
    await collectEvents(result.stream)
    result.release()

    expect(result.requestId).toBe('req-test-123')
  })
})

describe('OpenAI CC adapter: createMessage', () => {
  test('returns DomainAssistantContent for text response', async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          id: 'chatcmpl-abc',
          choices: [
            {
              message: { role: 'assistant', content: 'Hello world' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
        { status: 200 },
      )

    const result = await openaiChatCompletionsAdapter.createMessage(
      testConfig,
      authArgs,
      makeRequest(),
      new AbortController().signal,
    )

    expect(result.id).toBe('chatcmpl-abc')
    expect(result.role).toBe('assistant')
    expect(result.content).toHaveLength(1)
    expect(result.content[0].type).toBe('text')
    if (result.content[0].type === 'text') {
      expect(result.content[0].text).toBe('Hello world')
    }
    expect(result.stop_reason).toBe('end_turn')
    expect(result.usage.input_tokens).toBe(10)
    expect(result.usage.output_tokens).toBe(5)
  })

  test('returns tool_use blocks for tool calls', async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          id: 'chatcmpl-xyz',
          choices: [
            {
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'call_123',
                    type: 'function',
                    function: {
                      name: 'read_file',
                      arguments: '{"path":"test.txt"}',
                    },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
          usage: { prompt_tokens: 8, completion_tokens: 3 },
        }),
        { status: 200 },
      )

    const result = await openaiChatCompletionsAdapter.createMessage(
      testConfig,
      authArgs,
      makeRequest(),
      new AbortController().signal,
    )

    expect(result.stop_reason).toBe('tool_use')
    expect(result.content).toHaveLength(1)
    expect(result.content[0].type).toBe('tool_use')
    if (result.content[0].type === 'tool_use') {
      expect(result.content[0].id).toBe('call_123')
      expect(result.content[0].name).toBe('read_file')
      expect(result.content[0].input).toEqual({ path: 'test.txt' })
    }
  })
})

describe('OpenAI CC adapter: request translation', () => {
  test('sends system prompt as system role message', async () => {
    let capturedBody: Record<string, unknown> = {}
    globalThis.fetch = async (_url: unknown, init?: RequestInit) => {
      if (init?.body && typeof init.body === 'string') {
        capturedBody = JSON.parse(init.body)
      }
      return new Response(
        JSON.stringify({
          id: 'test',
          choices: [
            { message: { content: 'ok' }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
        { status: 200 },
      )
    }

    await openaiChatCompletionsAdapter.createMessage(
      testConfig,
      authArgs,
      makeRequest({
        system: [
          { type: 'text', text: 'You are a helpful assistant.' },
          { type: 'text', text: 'Be concise.' },
        ],
      }),
      new AbortController().signal,
    )

    const messages = capturedBody.messages as Array<{
      role: string
      content: string
    }>
    expect(messages[0].role).toBe('system')
    expect(messages[0].content).toBe(
      'You are a helpful assistant.\nBe concise.',
    )
  })

  test('translates tool definitions', async () => {
    let capturedBody: Record<string, unknown> = {}
    globalThis.fetch = async (_url: unknown, init?: RequestInit) => {
      if (init?.body && typeof init.body === 'string') {
        capturedBody = JSON.parse(init.body)
      }
      return new Response(
        JSON.stringify({
          id: 'test',
          choices: [
            { message: { content: 'ok' }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
        { status: 200 },
      )
    }

    await openaiChatCompletionsAdapter.createMessage(
      testConfig,
      authArgs,
      makeRequest({
        tools: [
          {
            name: 'read_file',
            description: 'Read a file',
            input_schema: {
              type: 'object',
              properties: { path: { type: 'string' } },
            },
          },
        ],
      }),
      new AbortController().signal,
    )

    const tools = capturedBody.tools as Array<{
      type: string
      function: { name: string; description: string; parameters: unknown }
    }>
    expect(tools).toHaveLength(1)
    expect(tools[0].type).toBe('function')
    expect(tools[0].function.name).toBe('read_file')
    expect(tools[0].function.description).toBe('Read a file')
  })

  test('translates tool_result blocks as tool role messages', async () => {
    let capturedBody: Record<string, unknown> = {}
    globalThis.fetch = async (_url: unknown, init?: RequestInit) => {
      if (init?.body && typeof init.body === 'string') {
        capturedBody = JSON.parse(init.body)
      }
      return new Response(
        JSON.stringify({
          id: 'test',
          choices: [
            { message: { content: 'ok' }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
        { status: 200 },
      )
    }

    await openaiChatCompletionsAdapter.createMessage(
      testConfig,
      authArgs,
      makeRequest({
        messages: [
          {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'call_123',
                name: 'read_file',
                input: { path: 'test.txt' },
              },
            ],
          },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'call_123',
                content: 'file contents here',
              },
            ],
          },
        ],
      }),
      new AbortController().signal,
    )

    const messages = capturedBody.messages as Array<{
      role: string
      content?: string | null
      tool_call_id?: string
    }>
    const toolMsg = messages.find(m => m.role === 'tool')
    expect(toolMsg).toBeDefined()
    expect(toolMsg!.tool_call_id).toBe('call_123')
    expect(toolMsg!.content).toBe('file contents here')
  })

  test('drops reasoning blocks on outbound', async () => {
    let capturedBody: Record<string, unknown> = {}
    globalThis.fetch = async (_url: unknown, init?: RequestInit) => {
      if (init?.body && typeof init.body === 'string') {
        capturedBody = JSON.parse(init.body)
      }
      return new Response(
        JSON.stringify({
          id: 'test',
          choices: [
            { message: { content: 'ok' }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
        { status: 200 },
      )
    }

    await openaiChatCompletionsAdapter.createMessage(
      testConfig,
      authArgs,
      makeRequest({
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'reasoning', text: 'internal thinking' },
              { type: 'text', text: 'visible response' },
            ],
          },
          {
            role: 'user',
            content: [{ type: 'text', text: 'follow up' }],
          },
        ],
      }),
      new AbortController().signal,
    )

    const messages = capturedBody.messages as Array<{
      role: string
      content?: string | null
      reasoning_content?: string
    }>
    const assistantMsg = messages.find(m => m.role === 'assistant')!
    expect(assistantMsg.reasoning_content).toBeUndefined()
    expect(assistantMsg.content).toBe('visible response')
  })

  test('passes reasoning_effort from outputConfig', async () => {
    let capturedBody: Record<string, unknown> = {}
    globalThis.fetch = async (_url: unknown, init?: RequestInit) => {
      if (init?.body && typeof init.body === 'string') {
        capturedBody = JSON.parse(init.body)
      }
      return sseResponse([
        'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n',
        'data: [DONE]\n\n',
      ])
    }

    const result = await openaiChatCompletionsAdapter.createStream(
      testConfig,
      authArgs,
      makeRequest({ outputConfig: { effort: 'high' } }),
      new AbortController().signal,
    )
    await collectEvents(result.stream)
    result.release()

    expect(capturedBody.reasoning_effort).toBe('high')
  })
})
