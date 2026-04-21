/**
 * Unit tests for NormalizedUsage helpers.
 *
 * The core semantic contract is `undefined` vs `0` on optional fields:
 *   - undefined: provider does not report / distinguish this metric
 *   - 0        : provider reports and the value is genuinely zero
 * These helpers must preserve that distinction through summation, bridging
 * from Anthropic-shape BetaUsage, and the `totalInputTokens` shortcut.
 */

import { describe, test, expect } from 'bun:test'
import {
  addUsage,
  emptyNormalizedUsage,
  fromAnthropicUsage,
  totalInputTokens,
  type NormalizedUsage,
} from '../../src/utils/normalizedUsage.js'

describe('fromAnthropicUsage', () => {
  test('concrete numbers propagate unchanged', () => {
    const u = fromAnthropicUsage({
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 10,
      cache_read_input_tokens: 20,
    } as Parameters<typeof fromAnthropicUsage>[0])
    expect(u.inputTokens).toBe(100)
    expect(u.outputTokens).toBe(50)
    expect(u.cacheReadTokens).toBe(20)
    expect(u.cacheWriteTokens).toBe(10)
  })

  test('null cache fields become undefined', () => {
    // Non-Anthropic adapters emit `null` for cache fields they do not
    // distinguish. The bridge must turn that into undefined (not 0).
    const u = fromAnthropicUsage({
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: 20,
    } as unknown as Parameters<typeof fromAnthropicUsage>[0])
    expect(u.cacheReadTokens).toBe(20)
    expect(u.cacheWriteTokens).toBeUndefined()
  })
})

describe('totalInputTokens', () => {
  test('adds marginal input + cache read + cache write', () => {
    const u: NormalizedUsage = {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 20,
      cacheWriteTokens: 10,
      raw: null,
    }
    expect(totalInputTokens(u)).toBe(130)
  })

  test('treats undefined cache fields as 0 for sum', () => {
    const u: NormalizedUsage = {
      inputTokens: 100,
      outputTokens: 50,
      raw: null,
    }
    expect(totalInputTokens(u)).toBe(100)
  })
})

describe('addUsage', () => {
  test('sums concrete fields and preserves undefined semantics', () => {
    const a: NormalizedUsage = {
      inputTokens: 100,
      outputTokens: 50,
      raw: null,
    }
    const b: NormalizedUsage = {
      inputTokens: 200,
      outputTokens: 75,
      raw: null,
    }
    const total = addUsage(a, b)
    expect(total.inputTokens).toBe(300)
    expect(total.outputTokens).toBe(125)
    // Both sides undefined → stays undefined.
    expect(total.cacheReadTokens).toBeUndefined()
    expect(total.cacheWriteTokens).toBeUndefined()
  })

  test('when one side has a cache value, the sum is concrete', () => {
    const a: NormalizedUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 30,
      raw: null,
    }
    const b: NormalizedUsage = {
      inputTokens: 0,
      outputTokens: 0,
      raw: null,
    }
    const total = addUsage(a, b)
    expect(total.cacheReadTokens).toBe(30)
  })
})

describe('emptyNormalizedUsage', () => {
  test('cache fields are undefined, numeric fields are zero', () => {
    const u = emptyNormalizedUsage('openai-chat-completions')
    expect(u.inputTokens).toBe(0)
    expect(u.outputTokens).toBe(0)
    expect(u.cacheReadTokens).toBeUndefined()
    expect(u.cacheWriteTokens).toBeUndefined()
    expect(u.sourceProvider).toBe('openai-chat-completions')
  })
})
