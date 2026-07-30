import { describe, expect, test } from 'bun:test'
import {
  createProgressTracker,
  getTokenCountFromTracker,
  updateProgressFromMessage,
  updateProgressFromUsage,
} from '../../src/tasks/LocalAgentTask/LocalAgentTask.js'
import type { Message } from '../../src/types/message.js'

function assistantMessage({
  id,
  inputTokens,
  outputTokens,
  cacheReadTokens = 0,
}: {
  id: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
}): Message {
  return {
    type: 'assistant',
    uuid: `uuid-${id}`,
    timestamp: '2026-07-30T00:00:00.000Z',
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model: 'test-model',
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: cacheReadTokens,
      },
      content: [{ type: 'text', text: 'hi' }],
    },
  } as unknown as Message
}

describe('LocalAgentTask progress tracker', () => {
  test('sums output and keeps the latest input while context grows', () => {
    const tracker = createProgressTracker()
    updateProgressFromMessage(
      tracker,
      assistantMessage({ id: 'a', inputTokens: 1000, outputTokens: 100 }),
    )
    updateProgressFromMessage(
      tracker,
      assistantMessage({ id: 'b', inputTokens: 1500, outputTokens: 200 }),
    )
    expect(getTokenCountFromTracker(tracker)).toBe(1800)
  })

  test('input tokens are a high-water mark across a compaction', () => {
    const tracker = createProgressTracker()
    updateProgressFromMessage(
      tracker,
      assistantMessage({ id: 'a', inputTokens: 150_000, outputTokens: 400 }),
    )
    const beforeCompact = getTokenCountFromTracker(tracker)

    // Post-compaction the API reports a much smaller cumulative input.
    updateProgressFromMessage(
      tracker,
      assistantMessage({ id: 'b', inputTokens: 20_000, outputTokens: 100 }),
    )
    expect(getTokenCountFromTracker(tracker)).toBe(beforeCompact + 100)
  })

  test('usage-only updates are also a high-water mark', () => {
    const tracker = createProgressTracker()
    updateProgressFromUsage(tracker, {
      input_tokens: 90_000,
      cache_read_input_tokens: 10_000,
      output_tokens: 50,
    })
    updateProgressFromUsage(tracker, {
      input_tokens: 5_000,
      output_tokens: 25,
    })
    expect(getTokenCountFromTracker(tracker)).toBe(100_000 + 75)
  })

  test('cache tokens count toward the input peak', () => {
    const tracker = createProgressTracker()
    updateProgressFromMessage(
      tracker,
      assistantMessage({
        id: 'a',
        inputTokens: 100,
        outputTokens: 10,
        cacheReadTokens: 900,
      }),
    )
    expect(getTokenCountFromTracker(tracker)).toBe(1010)
  })
})
