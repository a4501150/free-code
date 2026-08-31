import { describe, expect, test } from 'bun:test'
import { normalizeReasoningContent } from '../../src/types/domainConversion.js'
import type { DomainContentBlock } from '../../src/types/domain.js'

describe('normalizeReasoningContent', () => {
  test('replaces stale text with joined summary parts', () => {
    const content: DomainContentBlock[] = [
      {
        type: 'reasoning',
        text: 'stale streamed text',
        providerState: {
          openaiResponses: {
            reasoningId: 'rs_1',
            summary: [
              { type: 'summary_text', text: 'First.' },
              { type: 'summary_text', text: 'Second.' },
            ],
          },
        },
      },
    ]

    const result = normalizeReasoningContent(content)
    expect(result).not.toBe(content)
    expect((result[0] as any).text).toBe('First.\n\nSecond.')
  })

  test('filters whitespace-only summary parts', () => {
    const content: DomainContentBlock[] = [
      {
        type: 'reasoning',
        text: '',
        providerState: {
          openaiResponses: {
            summary: [
              { type: 'summary_text', text: '  ' },
              { type: 'summary_text', text: 'Real content.' },
              { type: 'summary_text', text: '' },
            ],
          },
        },
      },
    ]

    const result = normalizeReasoningContent(content)
    expect((result[0] as any).text).toBe('Real content.')
  })

  test('preserves text when summary is absent', () => {
    const content: DomainContentBlock[] = [
      {
        type: 'reasoning',
        text: 'Original reasoning.',
        providerState: { anthropic: { signature: 'sig' } },
      },
    ]

    const result = normalizeReasoningContent(content)
    expect(result).toBe(content)
    expect((result[0] as any).text).toBe('Original reasoning.')
  })

  test('preserves text when summary is empty', () => {
    const content: DomainContentBlock[] = [
      {
        type: 'reasoning',
        text: 'Visible text.',
        providerState: {
          openaiResponses: { reasoningId: 'rs_1', summary: [] },
        },
      },
    ]

    const result = normalizeReasoningContent(content)
    expect(result).toBe(content)
  })

  test('preserves text when all summary parts are whitespace', () => {
    const content: DomainContentBlock[] = [
      {
        type: 'reasoning',
        text: 'Existing text.',
        providerState: {
          openaiResponses: {
            summary: [{ type: 'summary_text', text: '   ' }],
          },
        },
      },
    ]

    const result = normalizeReasoningContent(content)
    expect(result).toBe(content)
  })

  test('returns same reference when text already matches summary', () => {
    const content: DomainContentBlock[] = [
      {
        type: 'reasoning',
        text: 'Already correct.',
        providerState: {
          openaiResponses: {
            summary: [{ type: 'summary_text', text: 'Already correct.' }],
          },
        },
      },
    ]

    const result = normalizeReasoningContent(content)
    expect(result).toBe(content)
  })

  test('leaves non-reasoning blocks unchanged', () => {
    const content: DomainContentBlock[] = [
      { type: 'text', text: 'Hello' },
      { type: 'tool_use', id: 'tu_1', name: 'test', input: {} },
    ]

    const result = normalizeReasoningContent(content)
    expect(result).toBe(content)
  })

  test('preserves providerState on normalized blocks', () => {
    const content: DomainContentBlock[] = [
      {
        type: 'reasoning',
        text: 'stale',
        providerState: {
          openaiResponses: {
            reasoningId: 'rs_1',
            encryptedContent: 'enc',
            summary: [{ type: 'summary_text', text: 'Correct.' }],
            rawContent: [{ type: 'reasoning_text', text: 'raw' }],
          },
        },
      },
    ]

    const result = normalizeReasoningContent(content)
    const block = result[0] as any
    expect(block.text).toBe('Correct.')
    expect(block.providerState.openaiResponses.reasoningId).toBe('rs_1')
    expect(block.providerState.openaiResponses.encryptedContent).toBe('enc')
    expect(block.providerState.openaiResponses.rawContent).toHaveLength(1)
  })
})
