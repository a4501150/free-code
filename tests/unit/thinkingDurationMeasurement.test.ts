import { describe, expect, setSystemTime, test } from 'bun:test'
import {
  createAssistantMessage,
  handleMessageFromStream,
  type StreamingThinking,
} from '../../src/utils/messages.js'
import type { Message, StreamEvent } from '../../src/types/message.js'
;(globalThis as typeof globalThis & { MACRO?: unknown }).MACRO ??= {
  VERSION: 'test',
  BUILD_TIME: '',
  PACKAGE_URL: '',
  ISSUES_EXPLAINER: '',
  FEEDBACK_CHANNEL: '',
}

const T0 = 1_000_000

function streamEvent(event: StreamEvent['event']): StreamEvent {
  return { type: 'stream_event', event }
}

function reasoningMessage() {
  const message = createAssistantMessage({ content: '' })
  message.message.content = [{ type: 'reasoning', text: 'hmm' }]
  return message
}

function harness() {
  let current: StreamingThinking | null = null
  const messages: Message[] = []
  return {
    send(event: Message | StreamEvent) {
      handleMessageFromStream(
        event,
        m => messages.push(m),
        () => {},
        () => {},
        () => {},
        undefined,
        updater => {
          current = updater(current)
          return current
        },
      )
    },
    get current() {
      return current
    },
    messages,
  }
}

describe('thinking duration measurement', () => {
  test('finalizes duration at reasoning content_block_stop, not message arrival', () => {
    setSystemTime(T0)
    try {
      const h = harness()
      h.send({ type: 'stream_request_start' })
      h.send(
        streamEvent({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'reasoning', text: '' },
        }),
      )
      h.send(
        streamEvent({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'hmm' },
        }),
      )

      // Opened block: streaming, no duration yet.
      expect(h.current?.isStreaming).toBe(true)
      expect(h.current?.durationMs).toBeUndefined()

      // Block stops at T0+2400 — duration is measured here, while the overlay
      // flag stays streaming so its removal batches with the committed row.
      setSystemTime(T0 + 2400)
      h.send(streamEvent({ type: 'content_block_stop', index: 0 }))
      expect(h.current?.isStreaming).toBe(true)
      expect(h.current?.durationMs).toBe(2400)

      // The assistant message lands 6.6s later (trailing text generation).
      // The stamped duration must be the block-stop measurement, not elapsed
      // time since block start.
      setSystemTime(T0 + 9000)
      h.send(reasoningMessage())
      expect(h.current?.isStreaming).toBe(false)
      expect(h.current?.durationMs).toBe(2400)
      expect(
        (h.messages[0] as Record<string, unknown>).thinkingDurationMs,
      ).toBe(2400)
    } finally {
      setSystemTime()
    }
  })

  test('a non-reasoning block stop does not finalize the reasoning duration', () => {
    setSystemTime(T0)
    try {
      const h = harness()
      h.send(
        streamEvent({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'reasoning', text: '' },
        }),
      )
      h.send(
        streamEvent({
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'text', text: '' },
        }),
      )
      h.send(streamEvent({ type: 'content_block_stop', index: 1 }))
      expect(h.current?.durationMs).toBeUndefined()
    } finally {
      setSystemTime()
    }
  })

  test('falls back to message arrival when the provider omits block-stop events', () => {
    setSystemTime(T0)
    try {
      const h = harness()
      h.send(
        streamEvent({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'reasoning', text: '' },
        }),
      )
      setSystemTime(T0 + 3000)
      h.send(reasoningMessage())
      expect(h.current?.durationMs).toBe(3000)
      expect(
        (h.messages[0] as Record<string, unknown>).thinkingDurationMs,
      ).toBe(3000)
    } finally {
      setSystemTime()
    }
  })

  test('a completed readout is dropped at the next request start', () => {
    setSystemTime(T0)
    try {
      const h = harness()
      h.send(
        streamEvent({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'reasoning', text: '' },
        }),
      )
      h.send(streamEvent({ type: 'content_block_stop', index: 0 }))
      h.send(reasoningMessage())
      expect(h.current?.durationMs).toBe(0)

      h.send({ type: 'stream_request_start' })
      expect(h.current).toBeNull()
    } finally {
      setSystemTime()
    }
  })
})
