/**
 * Unit tests: openai-chat-completions reasoning round-trip.
 *
 * OpenAI-compatible endpoints disagree on which field carries reasoning, so the
 * adapter records whichever one a response used and echoes back into that same
 * one. These tests pin that detection and the outbound shape per convention.
 */
import { describe, test, expect } from 'bun:test'
import { openaiChatCompletionsAdapter } from '../../src/services/api/adapters/openai-chat-completions-adapter-impl.js'
import type { ProviderConfig } from '../../src/utils/settings/types.js'
import type { DomainMessageRequest } from '../../src/services/api/domain-transport.js'
import type { DomainStreamEvent } from '../../src/types/domain.js'

const testConfig: ProviderConfig = {
  type: 'openai-chat-completions',
  baseUrl: 'http://localhost:9999/v1',
  models: [{ id: 'deepseek-chat' }],
  auth: { active: 'apiKey', apiKey: { key: 'test-key' } },
}

function makeRequest(
  overrides?: Partial<DomainMessageRequest>,
): DomainMessageRequest {
  return {
    model: 'deepseek-chat',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
    maxTokens: 1024,
    ...overrides,
  }
}

function sseResponse(chunks: unknown[]): Response {
  const body =
    chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') +
    'data: [DONE]\n\n'
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

function deltaChunk(delta: Record<string, unknown>, finish?: string) {
  return {
    id: 'chatcmpl-1',
    choices: [{ index: 0, delta, finish_reason: finish ?? null }],
  }
}

async function collectEvents(chunks: unknown[]): Promise<DomainStreamEvent[]> {
  const fetchOverride = (async () =>
    sseResponse(chunks)) as unknown as typeof globalThis.fetch
  const streaming = await openaiChatCompletionsAdapter.createStream(
    testConfig,
    makeRequest(),
    new AbortController().signal,
    fetchOverride,
  )
  const out: DomainStreamEvent[] = []
  for await (const event of streaming.stream) out.push(event)
  return out
}

async function capturedMessages(
  assistantContent: unknown[],
): Promise<Array<Record<string, unknown>>> {
  let captured: Record<string, unknown> = {}
  const fetchOverride = (async (_url: string, init: RequestInit) => {
    captured = JSON.parse(init.body as string)
    return sseResponse([deltaChunk({ content: 'ok' }, 'stop')])
  }) as unknown as typeof globalThis.fetch

  const streaming = await openaiChatCompletionsAdapter.createStream(
    testConfig,
    makeRequest({
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'go' }] },
        { role: 'assistant', content: assistantContent as never },
        { role: 'user', content: [{ type: 'text', text: 'next' }] },
      ],
    }),
    new AbortController().signal,
    fetchOverride,
  )
  for await (const _ of streaming.stream) {
    // drain
  }
  return captured.messages as Array<Record<string, unknown>>
}

describe('chat-completions stream: reasoning field detection', () => {
  test('reasoning_content is detected and recorded', async () => {
    const events = await collectEvents([
      deltaChunk({ reasoning_content: 'pondering' }),
      deltaChunk({ content: 'answer' }, 'stop'),
    ])
    const stop = events.find(e => e.type === 'content_block_stop')
    expect(stop?.providerState).toEqual({
      openaiChatCompletions: { field: 'reasoning_content' },
    })
  })

  // vLLM renamed its output field to `reasoning`; Groq and Together use it too.
  test('reasoning is detected and recorded', async () => {
    const events = await collectEvents([
      deltaChunk({ reasoning: 'pondering' }),
      deltaChunk({ content: 'answer' }, 'stop'),
    ])
    const stop = events.find(e => e.type === 'content_block_stop')
    expect(stop?.providerState).toEqual({
      openaiChatCompletions: { field: 'reasoning' },
    })
  })

  test('reasoning text still surfaces as thinking deltas', async () => {
    const events = await collectEvents([
      deltaChunk({ reasoning: 'step one' }),
      deltaChunk({ reasoning: ' step two' }),
      deltaChunk({ content: 'answer' }, 'stop'),
    ])
    const thinking = events
      .filter(
        e =>
          e.type === 'content_block_delta' &&
          (e.delta as { type: string }).type === 'thinking_delta',
      )
      .map(e => (e.delta as { thinking: string }).thinking)
    expect(thinking).toEqual(['step one', ' step two'])
  })

  test('OpenRouter reasoning_details fragments accumulate verbatim', async () => {
    const events = await collectEvents([
      deltaChunk({
        reasoning_content: 'x',
        reasoning_details: [{ type: 'reasoning.text', text: 'a', index: 0 }],
      }),
      deltaChunk({
        reasoning_details: [
          { type: 'reasoning.encrypted', data: 'blob', index: 1 },
        ],
      }),
      deltaChunk({ content: 'answer' }, 'stop'),
    ])
    const stop = events.find(e => e.type === 'content_block_stop')
    expect(stop?.providerState).toEqual({
      openaiChatCompletions: {
        field: 'reasoning_content',
        details: [
          { type: 'reasoning.text', text: 'a', index: 0 },
          { type: 'reasoning.encrypted', data: 'blob', index: 1 },
        ],
      },
    })
  })

  test('a plain endpoint yields no reasoning provider state', async () => {
    const events = await collectEvents([deltaChunk({ content: 'hi' }, 'stop')])
    for (const event of events) {
      if (event.type === 'content_block_stop') {
        expect(event.providerState).toBeUndefined()
      }
    }
  })
})

describe('chat-completions outbound: reasoning replay', () => {
  test('echoes back into reasoning_content when that is what arrived', async () => {
    const messages = await capturedMessages([
      {
        type: 'reasoning',
        text: 'because',
        providerState: {
          openaiChatCompletions: { field: 'reasoning_content' },
        },
      },
      { type: 'text', text: 'answer' },
    ])
    expect(messages[1]).toMatchObject({
      role: 'assistant',
      content: 'answer',
      reasoning_content: 'because',
    })
    expect(messages[1]!.reasoning).toBeUndefined()
  })

  test('echoes back into reasoning when that is what arrived', async () => {
    const messages = await capturedMessages([
      {
        type: 'reasoning',
        text: 'because',
        providerState: { openaiChatCompletions: { field: 'reasoning' } },
      },
      { type: 'text', text: 'answer' },
    ])
    expect(messages[1]).toMatchObject({ reasoning: 'because' })
    expect(messages[1]!.reasoning_content).toBeUndefined()
  })

  // DeepSeek V4 returns 400 if the assistant tool call arrives without the
  // reasoning that produced it.
  test('reasoning accompanies a tool call', async () => {
    const messages = await capturedMessages([
      {
        type: 'reasoning',
        text: 'need to read',
        providerState: {
          openaiChatCompletions: { field: 'reasoning_content' },
        },
      },
      { type: 'tool_use', id: 'call_1', name: 'Read', input: { path: 'a' } },
    ])
    expect(messages[1]).toMatchObject({
      role: 'assistant',
      reasoning_content: 'need to read',
    })
    expect((messages[1]!.tool_calls as Array<{ id: string }>)[0]!.id).toBe(
      'call_1',
    )
  })

  test('reasoning_details replay verbatim, preserving order', async () => {
    const details = [
      { type: 'reasoning.text', text: 'a', signature: 'sig', index: 0 },
      { type: 'reasoning.encrypted', data: 'blob', index: 1 },
    ]
    const messages = await capturedMessages([
      {
        type: 'reasoning',
        text: 'a',
        providerState: {
          openaiChatCompletions: { field: 'reasoning_content', details },
        },
      },
    ])
    expect(messages[1]!.reasoning_details).toEqual(details)
  })

  // Without a recorded field there is nothing safe to guess, and an endpoint
  // that rejects unknown assistant fields would 400.
  test('reasoning with no recorded field is not echoed', async () => {
    const messages = await capturedMessages([
      { type: 'reasoning', text: 'orphan' },
      { type: 'text', text: 'answer' },
    ])
    expect(messages[1]!.reasoning_content).toBeUndefined()
    expect(messages[1]!.reasoning).toBeUndefined()
    expect(messages[1]).toMatchObject({ content: 'answer' })
  })

  test('another provider\u2019s state is not echoed', async () => {
    const messages = await capturedMessages([
      {
        type: 'reasoning',
        text: 'signed',
        providerState: { anthropic: { signature: 'sig' } },
      },
      { type: 'text', text: 'answer' },
    ])
    expect(messages[1]!.reasoning_content).toBeUndefined()
    expect(messages[1]!.reasoning).toBeUndefined()
  })
})

describe('chat-completions non-streaming: reasoning field detection', () => {
  async function contentFor(message: Record<string, unknown>) {
    const fetchOverride = (async () =>
      new Response(
        JSON.stringify({
          id: 'chatcmpl-1',
          choices: [{ index: 0, message, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof globalThis.fetch

    const result = await openaiChatCompletionsAdapter.createMessage(
      testConfig,
      makeRequest(),
      new AbortController().signal,
      fetchOverride,
    )
    return result.message.content as unknown as Array<Record<string, unknown>>
  }

  test('reasoning_content is captured with its field name', async () => {
    const content = await contentFor({
      role: 'assistant',
      reasoning_content: 'because',
      content: 'answer',
    })
    expect(content[0]).toEqual({
      type: 'reasoning',
      text: 'because',
      providerState: {
        openaiChatCompletions: { field: 'reasoning_content' },
      },
    })
    expect(content[1]).toEqual({ type: 'text', text: 'answer' })
  })

  test('reasoning is captured with its field name', async () => {
    const content = await contentFor({
      role: 'assistant',
      reasoning: 'because',
      content: 'answer',
    })
    expect(content[0]).toEqual({
      type: 'reasoning',
      text: 'because',
      providerState: { openaiChatCompletions: { field: 'reasoning' } },
    })
  })

  test('reasoning_details are captured even with no text field', async () => {
    const details = [{ type: 'reasoning.encrypted', data: 'blob' }]
    const content = await contentFor({
      role: 'assistant',
      reasoning_details: details,
      content: 'answer',
    })
    expect(content[0]).toEqual({
      type: 'reasoning',
      text: '',
      providerState: { openaiChatCompletions: { details } },
    })
  })

  test('no reasoning block when the endpoint sent none', async () => {
    const content = await contentFor({ role: 'assistant', content: 'answer' })
    expect(content).toEqual([{ type: 'text', text: 'answer' }])
  })
})

describe('round-trip: detected field survives a full turn', () => {
  test('what the response used is what the next request sends', async () => {
    for (const field of ['reasoning_content', 'reasoning'] as const) {
      const events = await collectEvents([
        deltaChunk({ [field]: 'thought' }),
        deltaChunk({ content: 'answer' }, 'stop'),
      ])
      const stop = events.find(
        e => e.type === 'content_block_stop' && e.providerState,
      )
      const state = stop?.providerState as {
        openaiChatCompletions: { field: string }
      }

      const messages = await capturedMessages([
        {
          type: 'reasoning',
          text: 'thought',
          providerState: state,
        },
        { type: 'text', text: 'answer' },
      ])
      expect(messages[1]![field]).toBe('thought')
    }
  })
})
