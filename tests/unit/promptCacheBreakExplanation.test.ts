import { describe, expect, test } from 'bun:test'
import type { PendingChanges } from '../../src/services/api/promptCacheBreakDetection.js'
import { explainCacheBreak } from '../../src/services/api/promptCacheBreakDetection.js'

const MIN = 60_000

function changes(over: Partial<PendingChanges> = {}): PendingChanges {
  return {
    systemPromptChanged: false,
    toolSchemasChanged: false,
    modelChanged: false,
    cacheControlChanged: false,
    effortChanged: false,
    extraBodyChanged: false,
    addedToolCount: 0,
    removedToolCount: 0,
    systemCharDelta: 0,
    addedTools: [],
    removedTools: [],
    changedToolSchemas: [],
    previousModel: 'a',
    newModel: 'b',
    changedFeatures: [],
    prevEffortValue: '',
    newEffortValue: '',
    buildPrevDiffableContent: () => '',
    ...over,
  }
}

describe('explainCacheBreak provider-aware attribution', () => {
  test('explicit-breakpoint providers attribute marker and TTL causes', () => {
    expect(
      explainCacheBreak({
        changes: changes({ cacheControlChanged: true }),
        gapMsSinceLastAssistant: null,
        cacheType: 'explicit-breakpoint',
        idleTtlMinutes: [5, 60],
      }),
    ).toContain('cache_control changed')
    expect(
      explainCacheBreak({
        changes: null,
        gapMsSinceLastAssistant: 10 * MIN,
        cacheType: 'explicit-breakpoint',
        idleTtlMinutes: [5, 60],
      }),
    ).toBe('possible 5min TTL expiry (prompt unchanged)')
    expect(
      explainCacheBreak({
        changes: null,
        gapMsSinceLastAssistant: 2 * 60 * MIN,
        cacheType: 'explicit-breakpoint',
        idleTtlMinutes: [5, 60],
      }),
    ).toBe('possible 1h TTL expiry (prompt unchanged)')
  })

  test('automatic-prefix providers do not blame Anthropic-wire markers', () => {
    // Automatic-prefix adapters declare no wire features, so a break there
    // has no Anthropic-wire attribution to offer — only the marker flip,
    // which their adapters strip, and the idle gap.
    const reason = explainCacheBreak({
      changes: changes({ cacheControlChanged: true }),
      gapMsSinceLastAssistant: 10 * MIN,
      cacheType: 'automatic-prefix',
      idleTtlMinutes: [],
    })
    expect(reason).toContain('automatic-prefix')
    expect(reason).not.toContain('cache_control')
    expect(reason).not.toContain('anthropic-beta')
    expect(reason).not.toContain('TTL')
    expect(reason).toContain('10min idle gap')
  })

  test('adapter-declared feature flips are named on explicit-breakpoint providers', () => {
    const reason = explainCacheBreak({
      changes: changes({
        changedFeatures: [
          { name: 'anthropic-beta', prev: 'a-beta', next: 'a-beta,b-beta' },
        ],
      }),
      gapMsSinceLastAssistant: 0,
      cacheType: 'explicit-breakpoint',
      idleTtlMinutes: [5, 60],
    })
    expect(reason).toContain('anthropic-beta changed (a-beta → a-beta,b-beta)')
  })

  test('declared idle TTL tiers attribute expiry on any provider', () => {
    expect(
      explainCacheBreak({
        changes: null,
        gapMsSinceLastAssistant: 15 * MIN,
        cacheType: 'automatic-prefix',
        idleTtlMinutes: [10],
      }),
    ).toBe('possible 10min TTL expiry (prompt unchanged)')
    // A gap under every declared tier does NOT claim expiry.
    expect(
      explainCacheBreak({
        changes: null,
        gapMsSinceLastAssistant: 5 * MIN,
        cacheType: 'automatic-prefix',
        idleTtlMinutes: [10],
      }),
    ).toContain('likely server-side')
  })

  test('generic causes survive on automatic-prefix providers', () => {
    const reason = explainCacheBreak({
      changes: changes({ systemPromptChanged: true, systemCharDelta: 40 }),
      gapMsSinceLastAssistant: 0,
      cacheType: 'automatic-prefix',
      idleTtlMinutes: [],
    })
    expect(reason).toContain('system prompt changed (+40 chars)')
  })
})
