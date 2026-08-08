/**
 * `getProviderCacheType` used to return 'explicit-breakpoint' for every
 * unconfigured provider, including ones whose adapters discard Anthropic
 * markers. The default is now keyed on the wire format.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import {
  getProviderRegistry,
  initProviderRegistry,
  resetProviderRegistry,
} from '../../src/utils/model/providerRegistry.js'
import type {
  ProviderConfig,
  ProviderType,
} from '../../src/utils/settings/types.js'

afterEach(() => {
  resetProviderRegistry()
})

function cacheTypeFor(
  type: ProviderType,
  cache?: ProviderConfig['cache'],
): string {
  resetProviderRegistry()
  const providers: Record<string, ProviderConfig> = {
    p: {
      type,
      ...(cache ? { cache } : {}),
      auth: { active: 'apiKey', apiKey: { key: 'k' } },
      models: [{ id: 'test-model' }],
    } as ProviderConfig,
  }
  initProviderRegistry(providers)
  return getProviderRegistry().getProviderCacheType('test-model')
}

describe('default cache type by provider', () => {
  test('anthropic-wire providers take explicit breakpoints', () => {
    // The prompt-caching docs list the Claude API, AWS, Google Cloud and
    // Microsoft Foundry as supporting cache_control.
    expect(cacheTypeFor('anthropic')).toBe('explicit-breakpoint')
    expect(cacheTypeFor('vertex')).toBe('explicit-breakpoint')
    expect(cacheTypeFor('foundry')).toBe('explicit-breakpoint')
  })

  test('bedrock takes explicit breakpoints, translated to cachePoint', () => {
    expect(cacheTypeFor('bedrock-converse')).toBe('explicit-breakpoint')
  })

  test('openai and gemini cache automatically, so emit no markers', () => {
    expect(cacheTypeFor('openai-chat-completions')).toBe('automatic-prefix')
    expect(cacheTypeFor('openai-responses')).toBe('automatic-prefix')
    expect(cacheTypeFor('gemini')).toBe('automatic-prefix')
  })

  test('an explicit config always wins over the default', () => {
    expect(cacheTypeFor('anthropic', { type: 'none' })).toBe('none')
    expect(cacheTypeFor('gemini', { type: 'explicit-breakpoint' })).toBe(
      'explicit-breakpoint',
    )
  })
})
