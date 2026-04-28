/**
 * Unit tests: OpenAI Chat Completions adapter inbound thinking emission.
 *
 * The adapter emits synthetic unsigned `thinking` blocks when the upstream
 * model streams `reasoning_content` deltas, so users can see the model's
 * reasoning live in the UI. Outbound translation (covered in
 * `openaiAdapter.thinking.test.ts`) drops those blocks on the way back to
 * OpenAI so they never reach the wire as input.
 */

import { describe, expect, test } from 'bun:test'
import { createChatCompletionsFetch } from '../../src/services/api/openai-chat-completions-adapter.js'

type SSEEvent = { event: string; data: Record<string, unknown> }

function parseAnthropicSSE(text: string): SSEEvent[] {
  const events: SSEEvent[] = []
  const chunks = text.split('\n\n')
  for (const chunk of chunks) {
    if (!chunk.trim()) continue
    let eventName = ''
    let dataLine = ''
    for (const line of chunk.split('\n')) {
      if (line.startsWith('event: ')) eventName = line.slice(7).trim()
      else if (line.startsWith('data: ')) dataLine = line.slice(6)
    }
    if (!eventName || !dataLine) continue
    try {
      events.push({ event: eventName, data: JSON.parse(dataLine) })
    } catch {
      continue
    }
  }
  return events
}

async function drainToString(
  body: ReadableStream<Uint8Array>,
): Promise<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let out = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    out += decoder.decode(value, { stream: true })
  }
  out += decoder.decode()
  return out
}

describe('OpenAI Chat Completions adapter: inbound reasoning emission', () => {
  test('emits thinking block for reasoning_content deltas followed by text', async () => {
    const upstreamSSE =
      [
        'data: {"choices":[{"delta":{"reasoning_content":"Let me "},"finish_reason":null}]}',
        '',
        'data: {"choices":[{"delta":{"reasoning_content":"think..."},"finish_reason":null}]}',
        '',
        'data: {"choices":[{"delta":{"content":"Answer"},"finish_reason":null}]}',
        '',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
        '',
        'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":3}}',
        '',
        'data: [DONE]',
        '',
        '',
      ].join('\n') + '\n'

    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(upstreamSSE, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })) as unknown as typeof globalThis.fetch

    try {
      const adapterFetch = createChatCompletionsFetch(
        {
          type: 'openai-chat-completions',
          baseUrl: 'http://localhost/v1',
          models: [{ id: 'test' }],
          auth: { active: 'apiKey', apiKey: { key: 'k' } },
        },
        { Authorization: 'Bearer k' },
      )

      const response = await adapterFetch('http://localhost/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'test',
          messages: [{ role: 'user', content: 'hi' }],
        }),
      })

      expect(response.body).not.toBeNull()
      const text = await drainToString(response.body!)
      const events = parseAnthropicSSE(text)

      // Find the thinking block start
      const thinkingStarts = events.filter(
        e =>
          e.event === 'content_block_start' &&
          (e.data.content_block as Record<string, unknown>)?.type ===
            'thinking',
      )
      expect(thinkingStarts).toHaveLength(1)

      // Find thinking_delta events
      const thinkingDeltas = events.filter(
        e =>
          e.event === 'content_block_delta' &&
          (e.data.delta as Record<string, unknown>)?.type === 'thinking_delta',
      )
      expect(thinkingDeltas.length).toBe(2)
      const concatenated = thinkingDeltas
        .map(e => (e.data.delta as Record<string, string>).thinking)
        .join('')
      expect(concatenated).toBe('Let me think...')

      // Exactly one content_block_stop for the thinking block, then
      // text block opens at the next index.
      const blockStarts = events.filter(e => e.event === 'content_block_start')
      const blockStops = events.filter(e => e.event === 'content_block_stop')
      expect(blockStarts.length).toBe(2) // thinking + text
      expect(blockStops.length).toBe(2)
      // Thinking block index is 0, text block is 1
      expect(thinkingStarts[0].data.index).toBe(0)
      const textStart = blockStarts.find(
        e => (e.data.content_block as Record<string, unknown>)?.type === 'text',
      )
      expect(textStart?.data.index).toBe(1)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('no thinking block when model only streams content (no reasoning)', async () => {
    const upstreamSSE =
      [
        'data: {"choices":[{"delta":{"content":"plain answer"},"finish_reason":null}]}',
        '',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
        '',
        'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2}}',
        '',
        'data: [DONE]',
        '',
        '',
      ].join('\n') + '\n'

    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(upstreamSSE, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })) as unknown as typeof globalThis.fetch

    try {
      const adapterFetch = createChatCompletionsFetch(
        {
          type: 'openai-chat-completions',
          baseUrl: 'http://localhost/v1',
          models: [{ id: 'test' }],
          auth: { active: 'apiKey', apiKey: { key: 'k' } },
        },
        { Authorization: 'Bearer k' },
      )
      const response = await adapterFetch('http://localhost/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'test',
          messages: [{ role: 'user', content: 'hi' }],
        }),
      })
      const events = parseAnthropicSSE(await drainToString(response.body!))

      const thinkingStarts = events.filter(
        e =>
          e.event === 'content_block_start' &&
          (e.data.content_block as Record<string, unknown>)?.type ===
            'thinking',
      )
      expect(thinkingStarts).toHaveLength(0)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
