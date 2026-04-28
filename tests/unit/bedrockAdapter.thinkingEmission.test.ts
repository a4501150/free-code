/**
 * Unit tests: Bedrock Converse adapter inbound thinking emission.
 *
 * Covers both streaming (contentBlockStart/Delta with reasoningContent
 * → `content_block_start {type:"thinking"}` + `content_block_delta
 * {thinking_delta}`) and non-streaming (`reasoningContent` in the
 * response message → synthetic `thinking` content block).
 *
 * The streaming path is exercised by feeding a synthetic AWS EventStream
 * binary frame through the public adapter with a mocked upstream fetch.
 * The non-streaming path sends `Accept: application/json` plus a JSON body.
 */

import { describe, expect, test } from 'bun:test'
import { createBedrockConverseFetch } from '../../src/services/api/bedrock-converse-adapter.js'

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
      /* skip malformed */
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

// ── AWS EventStream binary frame builder (test-only) ─────────────────
// Matches the format consumed by parseEventStreamMessage in the adapter.
// CRCs are zero-filled; the adapter does not validate them.

function encodeString(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

function buildEventFrame(eventType: string, payloadJson: string): Uint8Array {
  // Encode the payload as { bytes: "<base64>" } wrapping the actual event JSON
  const base64 = Buffer.from(payloadJson, 'utf-8').toString('base64')
  const wrapped = JSON.stringify({ bytes: base64 })
  const payloadBytes = encodeString(wrapped)

  // Build headers: :message-type = "event", :event-type = eventType
  // Each header: nameLen(u8), name, type(u8=7), valueLen(u16), value
  const headers: Uint8Array[] = []
  const addStringHeader = (name: string, value: string) => {
    const nameBytes = encodeString(name)
    const valueBytes = encodeString(value)
    const buf = new Uint8Array(1 + nameBytes.length + 1 + 2 + valueBytes.length)
    let off = 0
    buf[off++] = nameBytes.length
    buf.set(nameBytes, off)
    off += nameBytes.length
    buf[off++] = 7 // string type
    new DataView(buf.buffer).setUint16(off, valueBytes.length)
    off += 2
    buf.set(valueBytes, off)
    headers.push(buf)
  }
  addStringHeader(':message-type', 'event')
  addStringHeader(':event-type', eventType)

  const headersBuf = new Uint8Array(
    headers.reduce((acc, h) => acc + h.length, 0),
  )
  let off = 0
  for (const h of headers) {
    headersBuf.set(h, off)
    off += h.length
  }

  const headersLength = headersBuf.length
  // totalLength = 4 (totalLength) + 4 (headersLength) + 4 (preludeCRC) +
  //               headers + payload + 4 (messageCRC)
  const totalLength = 12 + headersLength + payloadBytes.length + 4

  const frame = new Uint8Array(totalLength)
  const view = new DataView(frame.buffer)
  view.setUint32(0, totalLength)
  view.setUint32(4, headersLength)
  view.setUint32(8, 0) // prelude CRC (ignored by parser)
  frame.set(headersBuf, 12)
  frame.set(payloadBytes, 12 + headersLength)
  view.setUint32(totalLength - 4, 0) // message CRC (ignored)
  return frame
}

function concatFrames(frames: Uint8Array[]): Uint8Array {
  const total = frames.reduce((acc, f) => acc + f.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const f of frames) {
    out.set(f, off)
    off += f.length
  }
  return out
}

describe('Bedrock Converse adapter: inbound reasoning emission', () => {
  test('streaming: reasoningContent start + deltas → thinking block', async () => {
    const frames = [
      buildEventFrame(
        'contentBlockStart',
        JSON.stringify({
          contentBlockIndex: 0,
          start: { reasoningContent: {} },
        }),
      ),
      buildEventFrame(
        'contentBlockDelta',
        JSON.stringify({
          contentBlockIndex: 0,
          delta: { reasoningContent: { text: 'Let me ' } },
        }),
      ),
      buildEventFrame(
        'contentBlockDelta',
        JSON.stringify({
          contentBlockIndex: 0,
          delta: { reasoningContent: { text: 'think.' } },
        }),
      ),
      buildEventFrame(
        'contentBlockStop',
        JSON.stringify({ contentBlockIndex: 0 }),
      ),
      buildEventFrame(
        'contentBlockStart',
        JSON.stringify({ contentBlockIndex: 1, start: {} }),
      ),
      buildEventFrame(
        'contentBlockDelta',
        JSON.stringify({ contentBlockIndex: 1, delta: { text: 'Answer' } }),
      ),
      buildEventFrame(
        'contentBlockStop',
        JSON.stringify({ contentBlockIndex: 1 }),
      ),
      buildEventFrame(
        'messageStop',
        JSON.stringify({ stopReason: 'end_turn' }),
      ),
      buildEventFrame(
        'metadata',
        JSON.stringify({
          usage: { inputTokens: 10, outputTokens: 5 },
        }),
      ),
    ]
    const body = concatFrames(frames)

    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'application/vnd.amazon.eventstream' },
      })) as unknown as typeof globalThis.fetch

    try {
      const adapterFetch = createBedrockConverseFetch(
        {
          type: 'bedrock-converse',
          baseUrl: 'http://localhost',
          models: [{ id: 'anthropic.claude-test' }],
          auth: { active: 'aws', aws: { region: 'us-east-1' } },
        },
        async () => null, // skip SigV4 signing
      )

      const response = await adapterFetch('http://localhost/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'anthropic.claude-test',
          messages: [{ role: 'user', content: 'hi' }],
          stream: true,
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
      const thinkingDeltas = events.filter(
        e =>
          e.event === 'content_block_delta' &&
          (e.data.delta as Record<string, unknown>)?.type === 'thinking_delta',
      )
      expect(thinkingDeltas).toHaveLength(2)
      const concatenated = thinkingDeltas
        .map(e => (e.data.delta as Record<string, string>).thinking)
        .join('')
      expect(concatenated).toBe('Let me think.')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('non-streaming: reasoningContent in response → thinking content block', async () => {
    const converseJson = {
      output: {
        message: {
          role: 'assistant',
          content: [
            {
              reasoningContent: {
                reasoningText: { text: 'non-streaming reasoning' },
              },
            },
            { text: 'final answer' },
          ],
        },
      },
      stopReason: 'end_turn',
      usage: { inputTokens: 5, outputTokens: 3 },
    }

    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(converseJson), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as unknown as typeof globalThis.fetch

    try {
      const adapterFetch = createBedrockConverseFetch(
        {
          type: 'bedrock-converse',
          baseUrl: 'http://localhost',
          models: [{ id: 'anthropic.claude-test' }],
          auth: { active: 'aws', aws: { region: 'us-east-1' } },
        },
        async () => null,
      )

      const response = await adapterFetch('http://localhost/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'anthropic.claude-test',
          messages: [{ role: 'user', content: 'hi' }],
          stream: false,
        }),
      })

      const parsed = (await response.json()) as {
        content: Array<Record<string, unknown>>
      }
      const thinkingBlock = parsed.content.find(b => b.type === 'thinking')
      expect(thinkingBlock).toBeDefined()
      expect(thinkingBlock!.thinking).toBe('non-streaming reasoning')
      expect(thinkingBlock!.signature).toBe('')
      const textBlock = parsed.content.find(b => b.type === 'text')
      expect(textBlock).toBeDefined()
      expect(textBlock!.text).toBe('final answer')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
