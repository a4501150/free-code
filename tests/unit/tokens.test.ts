import { describe, expect, test } from 'bun:test'
import type { Message } from '../../src/types/message.js'
import { getCurrentUsage } from '../../src/utils/tokens.js'

function assistantMessage(
  usage: {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens?: number | null
    cache_read_input_tokens?: number | null
  },
): Message {
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
