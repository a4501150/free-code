import { randomUUID } from 'crypto'
import { describe, expect, test } from 'bun:test'
import type { AssistantMessage } from '../../src/types/message.js'
import type { ProviderState } from '../../src/types/domain.js'
import { stripForeignReasoningBlocks } from '../../src/utils/messages.js'

function assistant(content: unknown[]): AssistantMessage {
  return {
    type: 'assistant',
    uuid: randomUUID(),
    timestamp: '2026-07-31T00:00:00.000Z',
    message: {
      id: randomUUID(),
      type: 'message',
      role: 'assistant',
      model: 'test-model',
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      content,
    },
  } as AssistantMessage
}

function reasoning(providerState?: ProviderState) {
  return { type: 'reasoning', text: 'deliberating', providerState }
}

function redacted(providerState?: ProviderState) {
  return { type: 'redacted_reasoning', providerState }
}

const toolUse = { type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} }

function keptTypes(
  content: unknown[],
  providerType: Parameters<typeof stripForeignReasoningBlocks>[1],
  preserves = true,
): string[] {
  const [msg] = stripForeignReasoningBlocks(
    [assistant(content)],
    providerType,
    preserves,
  )
  const out = (msg as AssistantMessage).message.content as {
    type: string
  }[]
  return out.map(b => b.type)
}

describe('stripForeignReasoningBlocks', () => {
  const signed = reasoning({
    anthropic: { signature: 'sig', blockKind: 'thinking' },
  })

  test('keeps signed thinking on anthropic', () => {
    expect(keptTypes([signed, toolUse], 'anthropic')).toEqual([
      'reasoning',
      'tool_use',
    ])
  })

  // The regression this file exists for: vertex and foundry share Anthropic's
  // wire format and signed thinking blocks, but used to fall through the
  // provider check and have every block stripped, silently breaking
  // interleaved thinking on both.
  test.each(['vertex', 'foundry'] as const)(
    'keeps signed thinking on %s',
    providerType => {
      expect(keptTypes([signed, toolUse], providerType)).toEqual([
        'reasoning',
        'tool_use',
      ])
    },
  )

  test.each(['anthropic', 'vertex', 'foundry'] as const)(
    'drops unsigned thinking on %s',
    providerType => {
      expect(keptTypes([reasoning(), toolUse], providerType)).toEqual([
        'tool_use',
      ])
    },
  )

  test('keeps redacted thinking only when it carries data', () => {
    expect(
      keptTypes(
        [redacted({ anthropic: { redactedData: 'abc' } })],
        'anthropic',
      ),
    ).toEqual(['redacted_reasoning'])
    expect(keptTypes([redacted()], 'anthropic')).toEqual([])
  })

  test('does not accept a signature as redacted data, or vice versa', () => {
    expect(
      keptTypes([redacted({ anthropic: { signature: 'sig' } })], 'anthropic'),
    ).toEqual([])
    expect(
      keptTypes(
        [reasoning({ anthropic: { redactedData: 'abc' } })],
        'anthropic',
      ),
    ).toEqual([])
  })

  test('keeps reasoning with a reasoningId on openai-responses', () => {
    expect(
      keptTypes(
        [reasoning({ openaiResponses: { reasoningId: 'rs_1' } })],
        'openai-responses',
      ),
    ).toEqual(['reasoning'])
    expect(keptTypes([signed], 'openai-responses')).toEqual([])
  })

  test('keeps reasoning with a signature on bedrock-converse', () => {
    expect(
      keptTypes(
        [reasoning({ bedrockConverse: { signature: 'sig' } })],
        'bedrock-converse',
      ),
    ).toEqual(['reasoning'])
    expect(
      keptTypes(
        [redacted({ bedrockConverse: { redactedContent: 'base64' } })],
        'bedrock-converse',
      ),
    ).toEqual(['redacted_reasoning'])
    expect(keptTypes([signed], 'bedrock-converse')).toEqual([])
  })

  test('keeps reasoning with a thought signature on gemini', () => {
    expect(
      keptTypes([reasoning({ gemini: { thoughtSignature: 'sig' } })], 'gemini'),
    ).toEqual(['reasoning'])
    // A thought summary with no signature is display-only; Gemini has nothing
    // to verify it against, so it must not be replayed.
    expect(keptTypes([reasoning({ gemini: {} })], 'gemini')).toEqual([])
  })

  test('keeps reasoning on openai-chat-completions once a field is known', () => {
    expect(
      keptTypes(
        [reasoning({ openaiChatCompletions: { field: 'reasoning_content' } })],
        'openai-chat-completions',
      ),
    ).toEqual(['reasoning'])
    expect(
      keptTypes(
        [
          reasoning({
            openaiChatCompletions: { details: [{ type: 'reasoning.text' }] },
          }),
        ],
        'openai-chat-completions',
      ),
    ).toEqual(['reasoning'])
    // Never observed which field the endpoint uses, so there is nothing safe
    // to echo back.
    expect(
      keptTypes(
        [reasoning({ openaiChatCompletions: {} })],
        'openai-chat-completions',
      ),
    ).toEqual([])
  })

  test('cross-provider state is never accepted', () => {
    const geminiSigned = reasoning({ gemini: { thoughtSignature: 'sig' } })
    expect(keptTypes([geminiSigned], 'anthropic')).toEqual([])
    expect(keptTypes([geminiSigned], 'openai-responses')).toEqual([])
    expect(keptTypes([geminiSigned], 'bedrock-converse')).toEqual([])
  })

  test('preservesReasoning=false strips everything, whatever the state', () => {
    expect(keptTypes([signed, toolUse], 'anthropic', false)).toEqual([
      'tool_use',
    ])
    expect(
      keptTypes(
        [reasoning({ openaiResponses: { reasoningId: 'rs_1' } })],
        'openai-responses',
        false,
      ),
    ).toEqual([])
  })

  test('a null provider type strips everything', () => {
    expect(keptTypes([signed, toolUse], null)).toEqual(['tool_use'])
  })

  test('non-reasoning blocks and user messages are untouched', () => {
    const text = { type: 'text', text: 'hi' }
    expect(keptTypes([text, toolUse], 'anthropic')).toEqual([
      'text',
      'tool_use',
    ])
  })

  test('returns the same array identity when nothing changes', () => {
    const messages = [assistant([signed, toolUse])]
    expect(stripForeignReasoningBlocks(messages, 'anthropic', true)).toBe(
      messages,
    )
  })

  test('block order is preserved around a dropped block', () => {
    // Bedrock rejects a rewritten assistant turn, so surviving blocks must keep
    // their original relative order.
    const content = [
      signed,
      toolUse,
      reasoning(),
      { type: 'text', text: 'done' },
    ]
    expect(keptTypes(content, 'anthropic')).toEqual([
      'reasoning',
      'tool_use',
      'text',
    ])
  })
})
