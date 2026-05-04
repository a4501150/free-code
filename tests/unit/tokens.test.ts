import { describe, expect, test } from 'bun:test'
import type { Message } from '../../src/types/message.js'
import {
  getCurrentTotalInputTokens,
  getCurrentUsage,
} from '../../src/utils/tokens.js'

function assistantMessage(usage: {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens?: number | null
  cache_read_input_tokens?: number | null
}): Message {
  return {
    type: 'assistant',
    uuid: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    message: {
      id: crypto.randomUUID(),
      type: 'message',
      role: 'assistant',
      model: 'openai:gpt-5.5',
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: null,
      stop_sequence: null,
      usage,
    },
  } as Message
}

describe('getCurrentUsage', () => {
  test('skips trailing streaming placeholder usage', () => {
    const usage = getCurrentUsage([
      assistantMessage({
        input_tokens: 100,
        output_tokens: 20,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 30,
      }),
      assistantMessage({
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      }),
    ])

    expect(usage).toEqual({
      input_tokens: 100,
      output_tokens: 20,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 30,
    })
  })
})

describe('getCurrentTotalInputTokens', () => {
  test('uses latest context usage instead of cumulative session usage', () => {
    const tokens = getCurrentTotalInputTokens([
      assistantMessage({
        input_tokens: 400_000,
        output_tokens: 20,
        cache_creation_input_tokens: 10,
        cache_read_input_tokens: 20,
      }),
      assistantMessage({
        input_tokens: 68_000,
        output_tokens: 20,
        cache_creation_input_tokens: 1_000,
        cache_read_input_tokens: 2_000,
      }),
    ])

    expect(tokens).toBe(71_000)
  })
})
