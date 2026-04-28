/**
 * Unit tests: OpenAI Chat Completions adapter thinking-block handling.
 *
 * Under Step 5 of the provider-agnostic plan, this adapter:
 *   (1) MUST NOT translate incoming thinking blocks into
 *       `reasoning_content` on outbound — they are foreign-provider
 *       content and get dropped.
 *   (2) MUST NOT emit synthetic `thinking` blocks on inbound — reasoning
 *       text is dropped (counts still flow through NormalizedUsage).
 * These tests exercise (1) directly against translateToOpenAIBody by
 * round-tripping through the public createChatCompletionsFetch adapter
 * and inspecting the captured request body.
 */

import { describe, test, expect } from 'bun:test'
import { createChatCompletionsFetch } from '../../src/services/api/openai-chat-completions-adapter.js'

type AnthropicRequestBody = {
  model: string
  messages: Array<{
    role: string
    content: string | Array<{ type: string; text?: string; thinking?: string }>
  }>
}

describe('OpenAI Chat Completions adapter: thinking-block handling', () => {
  test('drops thinking blocks when translating to OpenAI messages', async () => {
    let capturedBody: {
      messages?: Array<{
        role: string
        content: unknown
        reasoning_content?: unknown
      }>
    } = {}
    const upstreamFetch = async (_url: string, init?: RequestInit) => {
      const body = init?.body
      if (typeof body === 'string') {
        capturedBody = JSON.parse(body)
      }
      // Minimal OpenAI SSE reply — just enough to let the stream translator
      // run to completion without error.
      const sse =
        'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}\n\n' +
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
        'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":1}}\n\n' +
        'data: [DONE]\n\n'
      return new Response(sse, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    }
    // Patch globalThis.fetch for the duration of this test.
    const originalFetch = globalThis.fetch
    globalThis.fetch = upstreamFetch as unknown as typeof globalThis.fetch

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

      // Anthropic-shape request body carrying a thinking block that is
      // tagged as sourced from the Anthropic provider. The adapter should
      // strip it during translation.
      const anthropicBody: AnthropicRequestBody = {
        model: 'test',
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'foreign thinking content' },
              { type: 'text', text: 'visible answer' },
            ],
          },
          { role: 'user', content: 'follow up' },
        ],
      }

      const response = await adapterFetch('http://localhost/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(anthropicBody),
      })

      // Drain the stream so finishStream runs cleanly.
      if (response.body) {
        const reader = response.body.getReader()
        while (!(await reader.read()).done) {
          /* noop */
        }
      }

      const messages = capturedBody.messages!
      const assistantMsg = messages.find(m => m.role === 'assistant')!
      expect(assistantMsg).toBeDefined()
      // The thinking block's content MUST NOT appear anywhere in the
      // outbound assistant message. `reasoning_content` MUST NOT be set.
      expect(assistantMsg.reasoning_content).toBeUndefined()
      const content = assistantMsg.content
      if (typeof content === 'string') {
        expect(content).not.toContain('foreign thinking content')
        expect(content).toContain('visible answer')
      } else {
        const serialized = JSON.stringify(content)
        expect(serialized).not.toContain('foreign thinking content')
        expect(serialized).toContain('visible answer')
      }
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
