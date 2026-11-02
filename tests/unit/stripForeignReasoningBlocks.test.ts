import { randomUUID } from 'crypto'
import { describe, expect, test } from 'bun:test'
import type { AssistantMessage } from '../../src/types/message.js'
import type { ProviderState } from '../../src/types/domain.js'
import {
  stripForeignReasoningBlocks,
  type ModelBackendResolver,
} from '../../src/utils/messages.js'

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

describe('stripForeignReasoningBlocks model identity', () => {
  const signed = reasoning({
    anthropic: { signature: 'sig', blockKind: 'thinking' },
  })

  // Mirrors ProviderRegistry.resolveModelBackend: only qualified
  // provider:model strings resolve to the entry's identity; bare strings
  // return null.
  const resolveBackend: ModelBackendResolver = model => {
    const table: Record<string, { providerName: string; modelId: string }> = {
      'taskforce:glm-5-3': { providerName: 'taskforce', modelId: 'glm-5-3' },
      'anthropic:claude-opus-5-5': {
        providerName: 'anthropic',
        modelId: 'claude-opus-5-5',
      },
      'anthropic:claude-sonnet-5-5': {
        providerName: 'anthropic',
        modelId: 'claude-sonnet-5-5',
      },
      // A second entry fronting the same account — same model id, same
      // credential, but a different ROUTE.
      'anthropic-eu:claude-opus-5-5': {
        providerName: 'anthropic-eu',
        modelId: 'claude-opus-5-5',
      },
    }
    return table[model.toLowerCase()] ?? null
  }

  function minted(model: string, modelId?: string): AssistantMessage {
    const msg = assistant([signed, toolUse])
    msg.message.model = model
    if (modelId !== undefined) msg.modelId = modelId
    return msg
  }

  function keptModel(msg: AssistantMessage, targetModelId: string): string[] {
    const [out] = stripForeignReasoningBlocks(
      [msg],
      'anthropic',
      true,
      targetModelId,
      resolveBackend,
    )
    return (
      (out as AssistantMessage).message.content as {
        type: string
      }[]
    ).map(b => b.type)
  }

  test('drops reasoning minted by a different provider entry (the GLM/Claude 400)', () => {
    // taskforce and anthropic both speak the 'anthropic' wire type AND share
    // one gateway token; the proxy-minted signature is invalid at real
    // Claude, so neither the type-level predicate nor the credential can
    // catch it. Entry comparison drops it.
    expect(
      keptModel(
        minted('zai-org/GLM-5.3', 'taskforce:glm-5-3'),
        'anthropic:claude-opus-5-5',
      ),
    ).toEqual(['tool_use'])
  })

  test('keeps reasoning minted by the target backend', () => {
    expect(
      keptModel(
        minted('claude-opus-5-5', 'anthropic:claude-opus-5-5'),
        'anthropic:claude-opus-5-5',
      ),
    ).toEqual(['reasoning', 'tool_use'])
  })

  test('keeps cross-model reasoning within one entry (verified live: opus-signed thinking accepted by sonnet)', () => {
    expect(
      keptModel(
        minted('claude-opus-5-5', 'anthropic:claude-opus-5-5'),
        'anthropic:claude-sonnet-5-5',
      ),
    ).toEqual(['reasoning', 'tool_use'])
  })

  test('drops reasoning across entries sharing a credential — one gateway token can front different upstreams', () => {
    expect(
      keptModel(
        minted('claude-opus-5-5', 'anthropic:claude-opus-5-5'),
        'anthropic-eu:claude-opus-5-5',
      ),
    ).toEqual(['tool_use'])
  })

  test('untagged legacy envelopes compare by string equality, never registry resolution', () => {
    // Wire string equal to the target's model id → keep (same backend echoed
    // the id it was asked to serve — a resumed session without a switch).
    expect(
      keptModel(minted('claude-opus-5-5'), 'anthropic:claude-opus-5-5'),
    ).toEqual(['reasoning', 'tool_use'])
    // Bare strings never resolve through the registry, so a cross-model
    // switch on pre-tag history drops the reasoning — safe (backends accept
    // history without previous-turn thinking) and strictly better than
    // replaying a signature the sibling backend rejects.
    expect(
      keptModel(minted('claude-opus-5-5'), 'anthropic:claude-sonnet-5-5'),
    ).toEqual(['tool_use'])
    // Proxy-echoed string vs a different backend → drop (the original bug,
    // on a transcript persisted before tagging).
    expect(
      keptModel(minted('zai-org/GLM-5.3'), 'anthropic:claude-opus-5-5'),
    ).toEqual(['tool_use'])
    // Proxy-echoed string vs its own configured target → drop too: the
    // proxy accepts history without previous-turn reasoning (verified
    // against the live backend), and keeping it poisons same-type switches.
    expect(keptModel(minted('zai-org/GLM-5.3'), 'taskforce:glm-5-3')).toEqual([
      'tool_use',
    ])
  })

  test('a bare tag is foreign by definition — bare strings never resolve', () => {
    // The tag is stamped in qualified provider:model form; a bare tag cannot
    // name a backend, so its reasoning is dropped rather than guessed at.
    expect(
      keptModel(
        minted('claude-opus-5-5', 'claude-opus-5-5'),
        'anthropic:claude-sonnet-5-5',
      ),
    ).toEqual(['tool_use'])
  })

  test('a tag naming no configured model is foreign by definition', () => {
    expect(
      keptModel(
        minted('whatever', 'old-provider:gone'),
        'anthropic:claude-opus-5-5',
      ),
    ).toEqual(['tool_use'])
  })

  test('an unresolvable target model disables the identity check', () => {
    expect(
      keptModel(
        minted('zai-org/GLM-5.3', 'taskforce:glm-5-3'),
        'unknown:model',
      ),
    ).toEqual(['reasoning', 'tool_use'])
  })

  test('without a target model id the pass is a no-op (same array identity)', () => {
    const messages = [minted('zai-org/GLM-5.3', 'taskforce:glm-5-3')]
    expect(stripForeignReasoningBlocks(messages, 'anthropic')).toBe(messages)
  })
})
