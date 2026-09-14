import { describe, expect, test } from 'bun:test'
import type { PendingChanges } from '../../src/services/api/promptCacheBreakDetection.js'
import { explainCacheBreak } from '../../src/services/api/promptCacheBreakDetection.js'

const MIN = 60_000

function changes(over: Partial<PendingChanges> = {}): PendingChanges {
  return {
    systemPromptChanged: false,
    toolSchemasChanged: false,
    modelChanged: false,
    fastModeChanged: false,
    cacheControlChanged: false,
    betasChanged: false,
    autoModeChanged: false,
    overageChanged: false,
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
    addedBetas: [],
    removedBetas: [],
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
      }),
    ).toContain('cache_control changed')
    expect(
      explainCacheBreak({
        changes: null,
        gapMsSinceLastAssistant: 10 * MIN,
        cacheType: 'explicit-breakpoint',
      }),
    ).toBe('possible 5min TTL expiry (prompt unchanged)')
    expect(
      explainCacheBreak({
        changes: null,
        gapMsSinceLastAssistant: 2 * 60 * MIN,
        cacheType: 'explicit-breakpoint',
      }),
    ).toBe('possible 1h TTL expiry (prompt unchanged)')
  })

  test('automatic-prefix providers do not blame Anthropic-wire markers', () => {
    const reason = explainCacheBreak({
      changes: changes({ cacheControlChanged: true, betasChanged: true }),
      gapMsSinceLastAssistant: 10 * MIN,
      cacheType: 'automatic-prefix',
    })
    expect(reason).toContain('automatic-prefix')
    expect(reason).not.toContain('cache_control')
    expect(reason).not.toContain('betas')
    expect(reason).not.toContain('TTL')
    expect(reason).toContain('10min idle gap')
  })

  test('generic causes survive on automatic-prefix providers', () => {
    const reason = explainCacheBreak({
      changes: changes({ systemPromptChanged: true, systemCharDelta: 40 }),
      gapMsSinceLastAssistant: 0,
      cacheType: 'automatic-prefix',
    })
    expect(reason).toContain('system prompt changed (+40 chars)')
  })
})
