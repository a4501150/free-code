/**
 * The provider-qualified model-string contract: every model reference in the
 * codebase is `provider:modelId`. Bare ids never resolve (they would silently
 * pick whichever provider registered the id first), qualified typos never
 * fall through to a different provider that owns the same bare id, and user
 * input plus settings fail fast with an actionable message.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import {
  getProviderRegistry,
  initProviderRegistry,
  resetProviderRegistry,
} from '../../src/utils/model/providerRegistry.js'
import { parseUserSpecifiedModel } from '../../src/utils/model/modelResolution.js'
import type { ProviderConfig } from '../../src/utils/settings/types.js'

const providers: Record<string, ProviderConfig> = {
  anthropic: {
    type: 'anthropic',
    auth: { active: 'apiKey', apiKey: { key: 'a' } },
    models: [{ id: 'claude-opus-5-5' }],
  },
  taskforce: {
    type: 'anthropic',
    auth: { active: 'apiKey', apiKey: { key: 'b' } },
    models: [{ id: 'glm-5-3' }],
  },
}

afterEach(() => {
  resetProviderRegistry()
})

function init(): void {
  initProviderRegistry(providers)
}

describe('provider-qualified model strings', () => {
  test('registry rejects bare model references in settings at construction', () => {
    expect(() =>
      initProviderRegistry(providers, { defaultModel: 'claude-opus-5-5' }),
    ).toThrow(/must be provider-qualified/)
    expect(() =>
      initProviderRegistry(providers, { defaultSubagentModel: 'glm-5-3' }),
    ).toThrow(/must be provider-qualified/)
    expect(() =>
      initProviderRegistry(providers, { utilityModel: 'nope:glm-5-3' }),
    ).toThrow(/unknown provider "nope"/)
    expect(() =>
      initProviderRegistry(providers, {
        defaultModel: 'taskforce:claude-opus-5-5',
      }),
    ).toThrow(/does not declare that model/)
  })

  test('registry accepts valid qualified settings references', () => {
    expect(() =>
      initProviderRegistry(providers, {
        defaultModel: 'anthropic:claude-opus-5-5',
        defaultSubagentModel: 'taskforce:glm-5-3',
        utilityModel: 'anthropic:claude-opus-5-5',
      }),
    ).not.toThrow()
  })

  test('getProviderForModel is strict: bare ids and cross-provider typos never resolve', () => {
    init()
    const registry = getProviderRegistry()
    // Bare id — would previously resolve to the first registered owner.
    expect(registry.getProviderForModel('claude-opus-5-5')).toBeNull()
    // Qualified typo — previously fell through the canonical index to
    // whichever provider owned the bare id.
    expect(registry.getProviderForModel('taskforce:claude-opus-5-5')).toBeNull()
    // Unknown provider.
    expect(registry.getProviderForModel('nope:claude-opus-5-5')).toBeNull()
    // Valid, and case-insensitive on both parts.
    expect(
      registry.getProviderForModel('anthropic:claude-opus-5-5')?.providerName,
    ).toBe('anthropic')
    expect(
      registry.getProviderForModel('ANTHROPIC:CLAUDE-OPUS-5-5')?.model.id,
    ).toBe('claude-opus-5-5')
  })

  test('parseUserSpecifiedModel fails fast on bare ids with a suggestion', () => {
    init()
    expect(() => parseUserSpecifiedModel('claude-opus-5-5')).toThrow(
      /Did you mean: anthropic:claude-opus-5-5/,
    )
    expect(() => parseUserSpecifiedModel('nonexistent-model')).toThrow(
      /provider-qualified/,
    )
    expect(() => parseUserSpecifiedModel('foo:claude-opus-5-5')).toThrow(
      /Unknown provider "foo"/,
    )
  })

  test('parseUserSpecifiedModel returns the canonical qualified form', () => {
    init()
    expect(parseUserSpecifiedModel('anthropic:claude-opus-5-5')).toBe(
      'anthropic:claude-opus-5-5',
    )
    expect(parseUserSpecifiedModel('ANTHROPIC:CLAUDE-OPUS-5-5')).toBe(
      'anthropic:claude-opus-5-5',
    )
  })

  test('parseUserSpecifiedModel keeps a known-provider undeclared model for request-time reporting', () => {
    init()
    expect(parseUserSpecifiedModel('anthropic:not-declared')).toBe(
      'anthropic:not-declared',
    )
  })
})
