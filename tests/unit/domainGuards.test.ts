import { describe, expect, test } from 'bun:test'
import { hasOpaqueReasoning } from '../../src/types/domainGuards.js'
import type { DomainReasoningBlock } from '../../src/types/domain.js'

describe('hasOpaqueReasoning', () => {
  test('returns true for Bedrock redacted content with empty text', () => {
    const block: DomainReasoningBlock = {
      type: 'reasoning',
      text: '',
      providerState: {
        bedrockConverse: { redactedContent: 'base64data' },
      },
    }
    expect(hasOpaqueReasoning(block)).toBe(true)
  })

  test('returns false when text is non-empty', () => {
    const block: DomainReasoningBlock = {
      type: 'reasoning',
      text: 'Visible reasoning.',
      providerState: {
        bedrockConverse: { redactedContent: 'base64data' },
      },
    }
    expect(hasOpaqueReasoning(block)).toBe(false)
  })

  test('returns false with no provider state', () => {
    const block: DomainReasoningBlock = {
      type: 'reasoning',
      text: '',
    }
    expect(hasOpaqueReasoning(block)).toBe(false)
  })

  test('returns false for OpenAI encrypted-only content', () => {
    const block: DomainReasoningBlock = {
      type: 'reasoning',
      text: '',
      providerState: {
        openaiResponses: {
          reasoningId: 'rs_1',
          encryptedContent: 'encrypted',
          summary: [],
          rawContent: [],
        },
      },
    }
    expect(hasOpaqueReasoning(block)).toBe(false)
  })

  test('returns false for Anthropic reasoning', () => {
    const block: DomainReasoningBlock = {
      type: 'reasoning',
      text: '',
      providerState: {
        anthropic: { signature: 'sig', blockKind: 'thinking' },
      },
    }
    expect(hasOpaqueReasoning(block)).toBe(false)
  })
})
