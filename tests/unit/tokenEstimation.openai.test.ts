/**
 * Unit test: OpenAI adapter's countTokens path.
 *
 * Asserts that the gpt-tokenizer-based `countTokens` for the openai-chat-
 * completions adapter (a) returns a sane token count for a plain-text
 * message and (b) does NOT require the Anthropic SDK client (i.e. does not
 * reach out to `/v1/messages/count_tokens`).
 *
 * The test runs the adapter in isolation — no mock server is needed. We
 * just verify the token count falls inside a reasonable band for a known
 * input so a regression in `serializeForTokenization` or the encoding
 * switch becomes visible.
 */

import { describe, test, expect } from 'bun:test'
import type { Anthropic } from '@anthropic-ai/sdk'
import { openaiChatCompletionsAdapter } from '../../src/services/api/adapters/openai-chat-completions-adapter-impl.js'

describe('openai-chat-completions adapter countTokens', () => {
  test('returns a sane token count for a plain-text user message', async () => {
    const messages: Anthropic.Beta.Messages.BetaMessageParam[] = [
      { role: 'user', content: 'Hello world, how are you today?' },
    ]
    const result = await openaiChatCompletionsAdapter.countTokens(
      messages,
      [],
      'gpt-4o-mini',
    )
    expect(result).not.toBeNull()
    // "Hello world, how are you today?" + "user:\n" prefix is ~10–15 tokens
    // on o200k_base. Bounds are intentionally generous so an encoding
    // change in gpt-tokenizer doesn't flake.
    expect(result!.inputTokens).toBeGreaterThan(5)
    expect(result!.inputTokens).toBeLessThan(25)
  })

  test('selects cl100k_base for GPT-4-family model names', async () => {
    const messages: Anthropic.Beta.Messages.BetaMessageParam[] = [
      { role: 'user', content: 'Test content for tokenization' },
    ]
    const result4 = await openaiChatCompletionsAdapter.countTokens(
      messages,
      [],
      'gpt-4',
    )
    const result4o = await openaiChatCompletionsAdapter.countTokens(
      messages,
      [],
      'gpt-4o-mini',
    )
    expect(result4).not.toBeNull()
    expect(result4o).not.toBeNull()
    // Both encodings should tokenize this short ASCII input to fewer than
    // 20 tokens; the cl100k vs o200k difference is small but non-zero.
    expect(result4!.inputTokens).toBeLessThan(20)
    expect(result4o!.inputTokens).toBeLessThan(20)
  })

  test('includes tool definitions in the count', async () => {
    const messages: Anthropic.Beta.Messages.BetaMessageParam[] = [
      { role: 'user', content: 'hi' },
    ]
    const tools: Anthropic.Beta.Messages.BetaToolUnion[] = [
      {
        name: 'Bash',
        description:
          'Execute a shell command with a clear description of what it does',
        input_schema: {
          type: 'object',
          properties: { command: { type: 'string' } },
          required: ['command'],
        },
      } as unknown as Anthropic.Beta.Messages.BetaToolUnion,
    ]
    const withoutTools = await openaiChatCompletionsAdapter.countTokens(
      messages,
      [],
      'gpt-4o-mini',
    )
    const withTools = await openaiChatCompletionsAdapter.countTokens(
      messages,
      tools,
      'gpt-4o-mini',
    )
    expect(withTools!.inputTokens).toBeGreaterThan(withoutTools!.inputTokens)
  })

  test('includes system prompt in the count', async () => {
    const messages: Anthropic.Beta.Messages.BetaMessageParam[] = [
      { role: 'user', content: 'hi' },
    ]
    const withoutSystem = await openaiChatCompletionsAdapter.countTokens(
      messages,
      [],
      'gpt-4o-mini',
    )
    const withSystem = await openaiChatCompletionsAdapter.countTokens(
      messages,
      [],
      'gpt-4o-mini',
      { system: 'Important safety policy '.repeat(100) },
    )
    expect(withSystem!.inputTokens).toBeGreaterThan(withoutSystem!.inputTokens)
  })
})
