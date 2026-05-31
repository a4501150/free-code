import { describe, expect, test } from 'bun:test'
import {
  getAutoCompactThreshold,
  getConfiguredContextWindowSize,
  getEffectiveContextWindowSize,
} from '../../src/services/compact/autoCompact.js'
import { getAutoCompactThresholdForContextWindow } from '../../src/services/compact/autoCompactConfig.js'

describe('model-level auto-compact threshold', () => {
  test('reserves compact-summary output before applying configured threshold buffer', () => {
    const model = 'unknown-test-model'

    expect(getConfiguredContextWindowSize(model)).toBe(200_000)
    expect(getEffectiveContextWindowSize(model)).toBe(180_000)
    expect(getAutoCompactThresholdForContextWindow(200_000)).toBe(180_000)
    expect(getAutoCompactThreshold(model)).toBe(160_000)
  })
})
