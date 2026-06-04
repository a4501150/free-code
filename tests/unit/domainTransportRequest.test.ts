import { describe, expect, test } from 'bun:test'
import { buildAnthropicWireBody } from '../../src/services/api/adapters/anthropic-wire-body.js'
import { adjustDomainRequestForNonStreaming } from '../../src/services/api/claude.js'
import type { DomainMessageRequest } from '../../src/services/api/domain-transport.js'

function makeRequest(
  overrides: Partial<DomainMessageRequest> = {},
): DomainMessageRequest {
  return {
    model: 'claude-test',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
    maxTokens: 1024,
    ...overrides,
  }
}

describe('domain request transport', () => {
  test('maps domain thinking budget and stop sequences to Anthropic wire fields', () => {
    const params = buildAnthropicWireBody(
      makeRequest({
        thinking: { type: 'enabled', budgetTokens: 512 },
        stopSequences: ['done'],
      }),
    )

    expect(params.thinking).toEqual({
      type: 'enabled',
      budget_tokens: 512,
    })
    expect(params.stop_sequences).toEqual(['done'])
  })

  test('translates assistant reasoning blocks at the Anthropic wire boundary', () => {
    const params = buildAnthropicWireBody(
      makeRequest({
        messages: [
          {
            role: 'assistant',
            content: [
              {
                type: 'reasoning',
                text: 'Think carefully',
                providerState: {
                  anthropic: { signature: 'signature', blockKind: 'thinking' },
                },
              },
              {
                type: 'text',
                text: 'Done',
                cache_control: { type: 'ephemeral' },
              },
            ],
          },
        ] as DomainMessageRequest['messages'],
      }),
    )

    expect(params.messages).toEqual([
      {
        role: 'assistant',
        content: [
          {
            type: 'thinking',
            thinking: 'Think carefully',
            signature: 'signature',
          },
          {
            type: 'text',
            text: 'Done',
            cache_control: { type: 'ephemeral' },
          },
        ],
      },
    ])
  })

  test('caps non-streaming output and thinking tokens without mutating request', () => {
    const request = makeRequest({
      maxTokens: 100_000,
      thinking: { type: 'enabled', budgetTokens: 90_000 },
    })

    const adjusted = adjustDomainRequestForNonStreaming(request, 64_000)

    expect(adjusted.maxTokens).toBe(64_000)
    expect(adjusted.thinking).toEqual({
      type: 'enabled',
      budgetTokens: 63_999,
    })
    expect(request.maxTokens).toBe(100_000)
    expect(request.thinking).toEqual({
      type: 'enabled',
      budgetTokens: 90_000,
    })
  })
})
