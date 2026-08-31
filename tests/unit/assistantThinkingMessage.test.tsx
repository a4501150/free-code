import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { AssistantThinkingMessage } from '../../src/components/messages/AssistantThinkingMessage.js'
import type { DomainReasoningBlock } from '../../src/types/domain.js'
import { AppStateProvider } from '../../src/state/AppState.js'
import { renderToAnsiString } from '../../src/utils/staticRender.js'

async function renderReasoning(
  param: DomainReasoningBlock,
  overrides: {
    isTranscriptMode?: boolean
    verbose?: boolean
    isStreaming?: boolean
    durationMs?: number
  } = {},
): Promise<string> {
  return renderToAnsiString(
    <AppStateProvider>
      <AssistantThinkingMessage
        param={param}
        addMargin={false}
        isTranscriptMode={overrides.isTranscriptMode ?? false}
        verbose={overrides.verbose ?? false}
        isStreaming={overrides.isStreaming ?? false}
        durationMs={overrides.durationMs}
      />
    </AppStateProvider>,
  )
}

describe('AssistantThinkingMessage OpenAI Responses display', () => {
  test('hides a completed encrypted-only item', async () => {
    const rendered = await renderReasoning(
      {
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
      },
      { durationMs: 9_500 },
    )

    expect(rendered.trim()).toBe('')
  })

  test('hides block with empty text and raw reasoning only', async () => {
    const rendered = await renderReasoning(
      {
        type: 'reasoning',
        text: '',
        providerState: {
          openaiResponses: {
            reasoningId: 'rs_1',
            summary: [],
            rawContent: [{ type: 'reasoning_text', text: 'private raw text' }],
          },
        },
      },
      { verbose: true },
    )

    expect(rendered.trim()).toBe('')
    expect(rendered).not.toContain('private raw text')
  })

  test('shows normalized text in transcript mode', async () => {
    const rendered = await renderReasoning(
      {
        type: 'reasoning',
        text: 'First summary.\n\nSecond summary.',
        providerState: {
          openaiResponses: {
            reasoningId: 'rs_1',
            summary: [
              { type: 'summary_text', text: 'First summary.' },
              { type: 'summary_text', text: 'Second summary.' },
            ],
            rawContent: [{ type: 'reasoning_text', text: 'private raw text' }],
          },
        },
      },
      { isTranscriptMode: true },
    )

    expect(rendered).toContain('First summary.')
    expect(rendered).toContain('Second summary.')
    expect(rendered).not.toContain('private raw text')
  })

  test('hides an empty legacy OpenAI item', async () => {
    const rendered = await renderReasoning({
      type: 'reasoning',
      text: '',
      providerState: {
        openaiResponses: {
          reasoningId: 'rs_legacy',
          encryptedContent: 'encrypted',
        },
      },
    })

    expect(rendered.trim()).toBe('')
  })

  test('keeps legacy visible text', async () => {
    const rendered = await renderReasoning(
      {
        type: 'reasoning',
        text: 'Legacy visible reasoning.',
        providerState: {
          openaiResponses: { reasoningId: 'rs_legacy' },
        },
      },
      { verbose: true },
    )

    expect(rendered).toContain('Legacy visible reasoning.')
  })

  test('keeps the Bedrock opaque marker', async () => {
    const rendered = await renderReasoning(
      {
        type: 'reasoning',
        text: '',
        providerState: {
          bedrockConverse: { redactedContent: 'redacted' },
        },
      },
      { durationMs: 2_000 },
    )

    expect(rendered).toContain('thought for 2.0s')
  })

  test('keeps provider-neutral visible reasoning', async () => {
    const rendered = await renderReasoning(
      { type: 'reasoning', text: 'Visible reasoning.' },
      { verbose: true },
    )

    expect(rendered).toContain('Visible reasoning.')
  })
})
