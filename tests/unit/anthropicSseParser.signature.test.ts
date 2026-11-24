import { describe, expect, test } from 'bun:test'
import { parseAnthropicSSEStream } from '../../src/services/api/adapters/anthropic-sse-parser.js'
import { DomainTransportError } from '../../src/services/api/domain-errors.js'
import type { DomainStreamEvent } from '../../src/types/domain.js'

function makeSSEStream(events: unknown[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
      }
      controller.close()
    },
  })
}

async function collectStreamEvents(
  events: unknown[],
): Promise<DomainStreamEvent[]> {
  const collected: DomainStreamEvent[] = []
  for await (const event of parseAnthropicSSEStream(
    makeSSEStream(events),
    'anthropic',
    (raw, providerType) => ({
      kind: 'unknown',
      message: 'test error',
      providerType,
      raw,
    }),
  )) {
    collected.push(event)
  }
  return collected
}

/** Same as above, but rejects with the thrown error instead of propagating. */
async function collectStreamEventsExpectThrow(
  events: unknown[],
): Promise<unknown> {
  let thrown: unknown
  try {
    await collectStreamEvents(events)
  } catch (err) {
    thrown = err
  }
  return thrown
}

describe('parseAnthropicSSEStream', () => {
  test('accumulates Anthropic signature deltas onto content_block_stop providerState', async () => {
    const events = await collectStreamEvents([
      {
        type: 'message_start',
        message: {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'claude-test',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking', thinking: '' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'Thought' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'signature_delta', signature: 'sig-' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'signature_delta', signature: 'tail' },
      },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_stop' },
    ])

    expect(
      events.some(
        event =>
          event.type === 'content_block_delta' &&
          event.delta.type === 'signature_delta',
      ),
    ).toBe(false)
    expect(events.find(event => event.type === 'content_block_stop')).toEqual({
      type: 'content_block_stop',
      index: 0,
      providerState: {
        anthropic: {
          blockKind: 'thinking',
          signature: 'sig-tail',
        },
      },
    })
  })

  test('EOF without message_stop is a severed stream, not a clean end', async () => {
    const thrown = await collectStreamEventsExpectThrow([
      {
        type: 'message_start',
        message: {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'claude-test',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'cut off mid-' },
      },
    ])
    expect(thrown).toBeInstanceOf(DomainTransportError)
    // The test's normalizeError stub fixes normalized.message; the severed-
    // stream fact lives on the raw cause.
    expect((thrown as Error & { raw: unknown }).raw).toBeInstanceOf(Error)
    expect(((thrown as Error & { raw: Error }).raw as Error).message).toContain(
      'without message_stop',
    )
  })

  test('message_stop before EOF ends the stream cleanly', async () => {
    const events = await collectStreamEvents([
      {
        type: 'message_start',
        message: {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'claude-test',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      },
      { type: 'message_stop' },
    ])
    expect(events.some(event => event.type === 'message_stop')).toBe(true)
  })
})
