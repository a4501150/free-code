/**
 * The /usage tab's prompt-cache row is derived from transcript usage records,
 * normalized per provider. These cover the walk (sidechain/zero skips, miss
 * heuristic, compaction rebuilds) and the provider-aware rendering.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import {
  computePromptCacheSummary,
  formatPromptCacheLine,
  resetPromptCacheStats,
} from '../../src/services/api/promptCacheStats.js'
import {
  initProviderRegistry,
  resetProviderRegistry,
} from '../../src/utils/model/providerRegistry.js'
import type { ProviderConfig } from '../../src/utils/settings/types.js'
import type { Message } from '../../src/types/message.js'

afterEach(() => {
  resetProviderRegistry()
  resetPromptCacheStats()
})

function useProvider(
  type: ProviderConfig['type'],
  cache?: ProviderConfig['cache'],
): void {
  resetProviderRegistry()
  initProviderRegistry({
    p: {
      type,
      ...(cache ? { cache } : {}),
      auth: { active: 'apiKey', apiKey: { key: 'k' } },
      models: [{ id: 'test-model' }],
    } as ProviderConfig,
  })
}

let seq = 0
function assistant(
  usage: {
    input_tokens: number
    output_tokens: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
  },
  atMs: number,
): Message {
  seq++
  return {
    type: 'assistant',
    uuid: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    timestamp: new Date(atMs).toISOString(),
    message: {
      id: `msg-${seq}`,
      type: 'message',
      role: 'assistant',
      content: [],
      model: 'test-model',
      stop_reason: null,
      stop_sequence: null,
      usage,
    },
  } as unknown as Message
}

function compactBoundary(atMs: number): Message {
  seq++
  return {
    type: 'system',
    uuid: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    timestamp: new Date(atMs).toISOString(),
    subtype: 'compact_boundary',
    compactMetadata: {},
  } as unknown as Message
}

const T0 = 1_760_000_000_000

describe('computePromptCacheSummary', () => {
  test('aggregates totals and hit ratio across requests', () => {
    useProvider('anthropic')
    const messages = [
      assistant(
        {
          input_tokens: 1_000,
          output_tokens: 100,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 50_000,
        },
        T0,
      ),
      assistant(
        {
          input_tokens: 500,
          output_tokens: 100,
          cache_read_input_tokens: 50_000,
          cache_creation_input_tokens: 0,
        },
        T0 + 10_000,
      ),
    ]
    const s = computePromptCacheSummary(messages, T0 + 20_000)!
    expect(s.requests).toBe(2)
    expect(s.cacheReadTokens).toBe(50_000)
    expect(s.cacheCreationTokens).toBe(50_000)
    expect(s.cachingObserved).toBe(true)
    expect(s.hitRatio).toBeCloseTo(50_000 / (1_500 + 100_000), 6)
    expect(s.misses).toBe(0)
    expect(s.idleTtlMinutes).toEqual([5, 60])
    expect(s.cacheType).toBe('explicit-breakpoint')
  })

  test('a dropped cache read is a miss; a compaction boundary is not', () => {
    useProvider('anthropic')
    const messages = [
      assistant(
        {
          input_tokens: 0,
          output_tokens: 50,
          cache_read_input_tokens: 60_000,
          cache_creation_input_tokens: 0,
        },
        T0,
      ),
      assistant(
        {
          input_tokens: 0,
          output_tokens: 50,
          cache_read_input_tokens: 2_000,
          cache_creation_input_tokens: 58_000,
        },
        T0 + 5_000,
      ),
      compactBoundary(T0 + 6_000),
      assistant(
        {
          input_tokens: 0,
          output_tokens: 50,
          cache_read_input_tokens: 30_000,
          cache_creation_input_tokens: 0,
        },
        T0 + 7_000,
      ),
    ]
    const s = computePromptCacheSummary(messages, T0 + 8_000)!
    expect(s.misses).toBe(1)
    expect(s.lastMissAt).toBe(T0 + 5_000)
    expect(s.missRecacheTokens).toBe(58_000)
    expect(s.expectedRebuilds).toBe(1)
    // Baseline reset by the boundary: the rise to 30k is no second miss.
    expect(s.requests).toBe(3)
  })

  test('sidechain and zeroed post-compaction records are skipped', () => {
    useProvider('anthropic')
    const side = assistant(
      {
        input_tokens: 10_000,
        output_tokens: 10,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      T0,
    )
    ;(side as { isSidechain?: boolean }).isSidechain = true
    const zeroed = assistant(
      {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      T0 + 1_000,
    )
    const real = assistant(
      {
        input_tokens: 100,
        output_tokens: 10,
        cache_read_input_tokens: 5_000,
        cache_creation_input_tokens: 0,
      },
      T0 + 2_000,
    )
    const s = computePromptCacheSummary([side, zeroed, real], T0 + 3_000)!
    expect(s.requests).toBe(1)
    expect(s.inputTokens).toBe(100)
  })

  test('returns null without any counted request', () => {
    useProvider('anthropic')
    expect(computePromptCacheSummary([], T0)).toBeNull()
  })
})

describe('formatPromptCacheLine', () => {
  test('warm anthropic-family row with no misses', () => {
    useProvider('anthropic')
    const messages = [
      assistant(
        {
          input_tokens: 0,
          output_tokens: 10,
          cache_read_input_tokens: 50_000,
          cache_creation_input_tokens: 0,
        },
        T0,
      ),
    ]
    const s = computePromptCacheSummary(messages, T0 + 7_000)!
    const line = formatPromptCacheLine(s, T0 + 7_000)!
    expect(line).toContain('1 request')
    expect(line).toContain('100% of input tokens from cache')
    expect(line).toContain('no misses')
    expect(line).toContain('warm (5min TTL, last activity 7s ago)')
  })

  test('automatic-prefix provider without declared TTL gets no invented TTL', () => {
    useProvider('openai-chat-completions')
    const messages = [
      assistant(
        {
          input_tokens: 1_000,
          output_tokens: 10,
          cache_read_input_tokens: 2_000,
          cache_creation_input_tokens: 0,
        },
        T0,
      ),
    ]
    const s = computePromptCacheSummary(messages, T0 + 60_000)!
    const line = formatPromptCacheLine(s, T0 + 60_000)!
    expect(line).toContain('cache lifetime set by provider')
    expect(line).not.toContain('TTL')
  })

  test('provider reporting no cache telemetry degrades honestly', () => {
    useProvider('openai-chat-completions')
    const messages = [assistant({ input_tokens: 1_000, output_tokens: 10 }, T0)]
    const s = computePromptCacheSummary(messages, T0)!
    const line = formatPromptCacheLine(s, T0)!
    expect(line).toContain('no prompt caching reported by the API')
  })

  test('cacheType none renders no row', () => {
    useProvider('openai-chat-completions', { type: 'none' })
    const messages = [
      assistant(
        {
          input_tokens: 1_000,
          output_tokens: 10,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        T0,
      ),
    ]
    const s = computePromptCacheSummary(messages, T0)!
    expect(formatPromptCacheLine(s, T0)).toBeNull()
  })
})
