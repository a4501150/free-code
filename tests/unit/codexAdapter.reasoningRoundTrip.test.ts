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
  test('inbound — reasoning streams live; codex side-channel fields arrive on a codex_reasoning_meta_delta before content_block_stop', async () => {
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

      // Thinking block opens eagerly on output_item.added(reasoning) so
      // reasoning text can stream live to the UI. codexReasoningId is
      // available at that point (rides on the start payload);
      // codexEncryptedContent is not (only arrives on output_item.done).
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
      expect(thinkingBlock.codexEncryptedContent).toBeUndefined()
      expect(thinkingBlock.signature).toBe('')

      // One thinking_delta per reasoning_text.delta — live streaming, not buffered.
      const thinkingDeltas = events.filter(
        e =>
          e.event === 'content_block_delta' &&
          (e.data.delta as Record<string, unknown>)?.type === 'thinking_delta',
      )
      expect(thinkingDeltas).toHaveLength(2)
      const concatenated = thinkingDeltas
        .map(e => (e.data.delta as Record<string, string>).thinking)
        .join('')
      expect(concatenated).toBe('Let me think about it.')

      // codexEncryptedContent arrives via a codex_reasoning_meta_delta
      // emitted just before content_block_stop. claude.ts patches the
      // active thinking block with these fields. Real Anthropic streams
      // never emit this delta type — safe additive extension.
      const metaDeltas = events.filter(
        e =>
          e.event === 'content_block_delta' &&
          (e.data.delta as Record<string, unknown>)?.type ===
            'codex_reasoning_meta_delta',
      )
      expect(metaDeltas).toHaveLength(1)
      const metaDelta = metaDeltas[0].data.delta as Record<string, string>
      expect(metaDelta.codexReasoningId).toBe('rs_test_123')
      expect(metaDelta.codexEncryptedContent).toBe('ENC_BLOB_XYZ')

      // The meta delta must arrive before the thinking block's content_block_stop.
      const metaDeltaIdx = events.indexOf(metaDeltas[0])
      const thinkingStopIdx = events.findIndex(
        e =>
          e.event === 'content_block_stop' &&
          (e.data.index as number) === (thinkingStarts[0].data.index as number),
      )
      expect(thinkingStopIdx).toBeGreaterThan(metaDeltaIdx)

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

      // `content[]` must accompany the summary on the OpenAI happy path —
      // it's what llama.cpp reads, and OpenAI tolerates it per spec.
      const content = reasoningItem!.content as Array<Record<string, unknown>>
      expect(content).toEqual([
        { type: 'reasoning_text', text: 'Prior reasoning summary' },
      ])

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

  test('outbound — llama.cpp reasoning with empty encrypted_content emits content[] with reasoning_text', async () => {
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

      const reasoningText = 'Qwen preserved thinking for turn one.'
      const anthropicBody = {
        model: 'gpt-test',
        messages: [
          { role: 'user', content: 'first question' },
          {
            role: 'assistant',
            content: [
              {
                type: 'thinking',
                thinking: reasoningText,
                signature: '',
                codexReasoningId: 'rs_llama_prev_turn',
                // Explicitly empty — simulates llama.cpp's stateless response
                // shape where encrypted_content:"" is returned and stored.
                codexEncryptedContent: '',
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
      if (response.body) {
        const reader = response.body.getReader()
        while (!(await reader.read()).done) {
          /* noop */
        }
      }

      const input = capturedBody.input as Array<Record<string, unknown>>
      const reasoningItem = input.find(i => i.type === 'reasoning')
      expect(reasoningItem).toBeDefined()
      expect(reasoningItem!.id).toBe('rs_llama_prev_turn')
      expect(reasoningItem!.encrypted_content).toBe('')
      expect(reasoningItem!.summary).toEqual([
        { type: 'summary_text', text: reasoningText },
      ])
      expect(reasoningItem!.content).toEqual([
        { type: 'reasoning_text', text: reasoningText },
      ])

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

  test('outbound — llama.cpp reasoning with codexEncryptedContent field absent still round-trips', async () => {
    // The streaming-emit gate at codex-fetch-adapter.ts:1180 only stores
    // `codexEncryptedContent` when the inbound encrypted_content is truthy.
    // For llama.cpp (always returns ""), the in-memory thinking block ends
    // up with the field ENTIRELY ABSENT — this test exercises that real
    // shape, distinct from Test A which sets it to '' explicitly.
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

      const reasoningText = 'Qwen reasoning, no encrypted content stored.'
      const anthropicBody = {
        model: 'gpt-test',
        messages: [
          {
            role: 'assistant',
            content: [
              {
                type: 'thinking',
                thinking: reasoningText,
                signature: '',
                codexReasoningId: 'rs_llama_absent_field',
                // codexEncryptedContent intentionally omitted — mirrors the
                // in-memory shape produced when streaming-inbound dropped
                // an empty encrypted_content.
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
      if (response.body) {
        const reader = response.body.getReader()
        while (!(await reader.read()).done) {
          /* noop */
        }
      }

      const input = capturedBody.input as Array<Record<string, unknown>>
      const reasoningItem = input.find(i => i.type === 'reasoning')
      expect(reasoningItem).toBeDefined()
      expect(reasoningItem!.id).toBe('rs_llama_absent_field')
      // The type guard in the adapter must default missing field to ''.
      expect(reasoningItem!.encrypted_content).toBe('')
      expect(reasoningItem!.summary).toEqual([
        { type: 'summary_text', text: reasoningText },
      ])
      expect(reasoningItem!.content).toEqual([
        { type: 'reasoning_text', text: reasoningText },
      ])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('outbound — summary-less encrypted reasoning emits no content field', async () => {
    // Real-OpenAI Codex/GPT-5.x high-effort path: encrypted_content present
    // but visible thinking text empty. We must round-trip the encrypted
    // blob with summary:[] and NO content field — emitting an empty
    // content[] would 400 on llama.cpp's parser.
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
                thinking: '',
                signature: '',
                codexReasoningId: 'rs_summaryless_prev_turn',
                codexEncryptedContent: 'ENC_ONLY_BLOB',
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
      if (response.body) {
        const reader = response.body.getReader()
        while (!(await reader.read()).done) {
          /* noop */
        }
      }

      const input = capturedBody.input as Array<Record<string, unknown>>
      const reasoningItem = input.find(i => i.type === 'reasoning')
      expect(reasoningItem).toBeDefined()
      expect(reasoningItem!.id).toBe('rs_summaryless_prev_turn')
      expect(reasoningItem!.encrypted_content).toBe('ENC_ONLY_BLOB')
      expect(reasoningItem!.summary).toEqual([])
      // Critical: no content field at all (not [], not undefined-as-key —
      // the property must be absent so JSON.stringify omits it).
      expect(
        Object.prototype.hasOwnProperty.call(reasoningItem!, 'content'),
      ).toBe(false)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('outbound — reasoning block with id but no text or encrypted_content is skipped', async () => {
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
                thinking: '',
                signature: '',
                codexReasoningId: 'rs_empty_noop',
                codexEncryptedContent: '',
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
      expect(JSON.stringify(input)).not.toContain('rs_empty_noop')
      // The text block must still translate normally.
      expect(
        input.some(i => i.type === 'message' && i.role === 'assistant'),
      ).toBe(true)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('inbound — reasoning closes on response.completed without a done event', async () => {
    const responsesSSE = [
      'event: response.output_item.added',
      'data: {"type":"response.output_item.added","item":{"type":"reasoning","id":"rs_unclosed","summary":[]}}',
      '',
      'event: response.reasoning_text.delta',
      'data: {"type":"response.reasoning_text.delta","delta":"still thinking"}',
      '',
      'event: response.completed',
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":5,"output_tokens":1}}}',
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
      const thinkingStart = events.find(
        e =>
          e.event === 'content_block_start' &&
          (e.data.content_block as Record<string, unknown>)?.type ===
            'thinking',
      )
      expect(thinkingStart).toBeDefined()
      const thinkingStopIdx = events.findIndex(
        e =>
          e.event === 'content_block_stop' &&
          e.data.index === thinkingStart!.data.index,
      )
      const messageDeltaIdx = events.findIndex(e => e.event === 'message_delta')
      expect(thinkingStopIdx).toBeGreaterThan(-1)
      expect(messageDeltaIdx).toBeGreaterThan(thinkingStopIdx)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('inbound — reasoning closes before a tool block when reasoning done arrives late', async () => {
    const responsesSSE = [
      'event: response.output_item.added',
      'data: {"type":"response.output_item.added","item":{"type":"reasoning","id":"rs_late","summary":[]}}',
      '',
      'event: response.reasoning_text.delta',
      'data: {"type":"response.reasoning_text.delta","delta":"choose tool"}',
      '',
      'event: response.output_item.added',
      'data: {"type":"response.output_item.added","item":{"type":"function_call","name":"BackgroundTaskOutput","call_id":"fc_block","arguments":""}}',
      '',
      'event: response.output_item.done',
      'data: {"type":"response.output_item.done","item":{"type":"function_call","name":"BackgroundTaskOutput","call_id":"fc_block","arguments":"{\\"task_id\\":\\"task-1\\"}"}}',
      '',
      'event: response.output_item.done',
      'data: {"type":"response.output_item.done","item":{"type":"reasoning","id":"rs_late","encrypted_content":""}}',
      '',
      'event: response.completed',
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":5,"output_tokens":1}}}',
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
      const thinkingStart = events.find(
        e =>
          e.event === 'content_block_start' &&
          (e.data.content_block as Record<string, unknown>)?.type ===
            'thinking',
      )
      const thinkingStopIdx = events.findIndex(
        e =>
          e.event === 'content_block_stop' &&
          e.data.index === thinkingStart!.data.index,
      )
      const toolStartIdx = events.findIndex(
        e =>
          e.event === 'content_block_start' &&
          (e.data.content_block as Record<string, unknown>)?.type ===
            'tool_use',
      )
      const stopReason = events.find(e => e.event === 'message_delta')?.data
        .delta as Record<string, unknown>
      expect(thinkingStopIdx).toBeGreaterThan(-1)
      expect(toolStartIdx).toBeGreaterThan(thinkingStopIdx)
      expect(stopReason.stop_reason).toBe('tool_use')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('inbound — done-only summary-less encrypted reasoning emits metadata and stops', async () => {
    const responsesSSE = [
      'event: response.output_item.done',
      'data: {"type":"response.output_item.done","item":{"type":"reasoning","id":"rs_done_only","encrypted_content":"ENC_ONLY","summary":[]}}',
      '',
      'event: response.completed',
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":5,"output_tokens":1}}}',
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
      const metaDelta = events.find(
        e =>
          e.event === 'content_block_delta' &&
          (e.data.delta as Record<string, unknown>)?.type ===
            'codex_reasoning_meta_delta',
      )
      const thinkingStop = events.find(e => e.event === 'content_block_stop')
      expect(metaDelta).toBeDefined()
      expect(
        (metaDelta!.data.delta as Record<string, unknown>).codexReasoningId,
      ).toBe('rs_done_only')
      expect(
        (metaDelta!.data.delta as Record<string, unknown>)
          .codexEncryptedContent,
      ).toBe('ENC_ONLY')
      expect(thinkingStop).toBeDefined()
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
