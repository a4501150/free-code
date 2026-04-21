/**
 * Unit tests: Codex adapter reasoning round-trip via content-block
 * side-channel (`codexReasoningId` + `codexEncryptedContent`).
 *
 * Inbound: a Responses-API SSE stream containing `output_item.added`
 * (reasoning), reasoning text deltas, and `output_item.done` (with
 * encrypted_content) must produce a single synthetic thinking block
 * carrying the codex fields.
 *
 * Outbound: an Anthropic assistant message containing a thinking block
 * with codex fields must produce a top-level `{type:"reasoning"}` item
 * in the translated Responses-API `input[]`.
 */

import { describe, expect, test } from 'bun:test'
import { createCodexFetch } from '../../src/services/api/codex-fetch-adapter.js'

type SSEEvent = { event: string; data: Record<string, unknown> }

function parseAnthropicSSE(text: string): SSEEvent[] {
  const events: SSEEvent[] = []
  for (const chunk of text.split('\n\n')) {
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
      /* skip */
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

describe('Codex adapter: reasoning round-trip', () => {
  test('inbound — buffered reasoning emitted once on output_item.done with encrypted_content', async () => {
    const responsesSSE = [
      'event: response.output_item.added',
      'data: {"type":"response.output_item.added","item":{"type":"reasoning","id":"rs_test_123","summary":[]}}',
      '',
      'event: response.reasoning_text.delta',
      'data: {"type":"response.reasoning_text.delta","delta":"Let me "}',
      '',
      'event: response.reasoning_text.delta',
      'data: {"type":"response.reasoning_text.delta","delta":"think about it."}',
      '',
      'event: response.output_item.done',
      'data: {"type":"response.output_item.done","item":{"type":"reasoning","id":"rs_test_123","encrypted_content":"ENC_BLOB_XYZ","summary":[{"type":"summary_text","text":"Let me think about it."}]}}',
      '',
      'event: response.output_item.added',
      'data: {"type":"response.output_item.added","item":{"type":"message"}}',
      '',
      'event: response.output_text.delta',
      'data: {"type":"response.output_text.delta","delta":"Answer"}',
      '',
      'event: response.output_item.done',
      'data: {"type":"response.output_item.done","item":{"type":"message"}}',
      '',
      'event: response.completed',
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":10,"output_tokens":5}}}',
      '',
      '',
    ].join('\n')

    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(responsesSSE, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })) as unknown as typeof globalThis.fetch

    try {
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
        }),
      })

      const events = parseAnthropicSSE(await drainToString(response.body!))

      const thinkingStarts = events.filter(
        e =>
          e.event === 'content_block_start' &&
          (e.data.content_block as Record<string, unknown>)?.type ===
            'thinking',
      )
      expect(thinkingStarts).toHaveLength(1)
      const thinkingBlock = thinkingStarts[0].data.content_block as Record<
        string,
        unknown
      >
      expect(thinkingBlock.codexReasoningId).toBe('rs_test_123')
      expect(thinkingBlock.codexEncryptedContent).toBe('ENC_BLOB_XYZ')
      expect(thinkingBlock.signature).toBe('')

      const thinkingDeltas = events.filter(
        e =>
          e.event === 'content_block_delta' &&
          (e.data.delta as Record<string, unknown>)?.type ===
            'thinking_delta',
      )
      expect(thinkingDeltas).toHaveLength(1)
      expect((thinkingDeltas[0].data.delta as Record<string, string>).thinking).toBe(
        'Let me think about it.',
      )

      // Followed by a text block.
      const textStart = events.find(
        e =>
          e.event === 'content_block_start' &&
          (e.data.content_block as Record<string, unknown>)?.type === 'text',
      )
      expect(textStart).toBeDefined()
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('outbound — thinking block with codex fields emits reasoning item in input[]', async () => {
    // Capture the upstream request body so we can inspect the translated
    // `input[]` array after translateMessages runs.
    let capturedBody: Record<string, unknown> = {}
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      if (typeof init?.body === 'string') {
        capturedBody = JSON.parse(init.body)
      }
      // Minimal stream so the adapter can finish without error
      const sse = [
        'event: response.completed',
        'data: {"type":"response.completed","response":{"usage":{"input_tokens":5,"output_tokens":0}}}',
        '',
        '',
      ].join('\n')
      return new Response(sse, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    }) as unknown as typeof globalThis.fetch

    try {
      const adapterFetch = createCodexFetch({
        accessToken: 'unused',
        baseUrl: 'http://localhost',
        getSessionId: () => 'test-session',
      })

      const anthropicBody = {
        model: 'gpt-test',
        messages: [
          { role: 'user', content: 'first question' },
          {
            role: 'assistant',
            content: [
              {
                type: 'thinking',
                thinking: 'Prior reasoning summary',
                signature: '',
                codexReasoningId: 'rs_prev_turn',
                codexEncryptedContent: 'PRIOR_ENC_BLOB',
              },
              { type: 'text', text: 'Prior answer' },
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
      // Drain response so the pipeline finishes cleanly.
      if (response.body) {
        const reader = response.body.getReader()
        while (!(await reader.read()).done) {
          /* noop */
        }
      }

      const input = capturedBody.input as Array<Record<string, unknown>>
      expect(Array.isArray(input)).toBe(true)

      const reasoningItem = input.find(i => i.type === 'reasoning')
      expect(reasoningItem).toBeDefined()
      expect(reasoningItem!.id).toBe('rs_prev_turn')
      expect(reasoningItem!.encrypted_content).toBe('PRIOR_ENC_BLOB')
      const summary = reasoningItem!.summary as Array<Record<string, unknown>>
      expect(summary[0].type).toBe('summary_text')
      expect(summary[0].text).toBe('Prior reasoning summary')

      // The reasoning item must appear BEFORE the text message that comes
      // from the same assistant turn (in original block order).
      const reasoningIdx = input.findIndex(i => i.type === 'reasoning')
      const messageIdx = input.findIndex(
        i => i.type === 'message' && i.role === 'assistant',
      )
      expect(reasoningIdx).toBeGreaterThan(-1)
      expect(messageIdx).toBeGreaterThan(reasoningIdx)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('outbound — thinking block without codex fields is skipped', async () => {
    let capturedBody: Record<string, unknown> = {}
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      if (typeof init?.body === 'string') {
        capturedBody = JSON.parse(init.body)
      }
      const sse = [
        'event: response.completed',
        'data: {"type":"response.completed","response":{"usage":{"input_tokens":5,"output_tokens":0}}}',
        '',
        '',
      ].join('\n')
      return new Response(sse, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    }) as unknown as typeof globalThis.fetch

    try {
      const adapterFetch = createCodexFetch({
        accessToken: 'unused',
        baseUrl: 'http://localhost',
        getSessionId: () => 'test-session',
      })

      const anthropicBody = {
        model: 'gpt-test',
        messages: [
          {
            role: 'assistant',
            content: [
              {
                type: 'thinking',
                thinking: 'foreign provenance - no codex fields',
                signature: '',
              },
              { type: 'text', text: 'hello' },
            ],
          },
        ],
      }

      const response = await adapterFetch('http://localhost/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(anthropicBody),
      })
      if (response.body) {
        const reader = response.body.getReader()
        while (!(await reader.read()).done) {
          /* noop */
        }
      }

      const input = capturedBody.input as Array<Record<string, unknown>>
      const reasoningItem = input.find(i => i.type === 'reasoning')
      expect(reasoningItem).toBeUndefined()
      // The thinking text must NOT have leaked into any other item.
      expect(JSON.stringify(input)).not.toContain('foreign provenance')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
