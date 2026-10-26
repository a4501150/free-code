import { beforeEach, describe, expect, mock, test } from 'bun:test'

let settings: {
  autoCompactEnabled?: boolean
  autoCompactPercentage?: number
  autoCompactBuffer?: number
} = {}
let globalConfig = { autoCompactEnabled: true }

// Additive for the same reason as the config mock below: later files import
// other settings exports (e.g. getSettings_DEPRECATED via config's dep graph).
const actualSettings = await import('../../src/utils/settings/settings.js')
mock.module('../../src/utils/settings/settings.js', () => ({
  ...actualSettings,
  getInitialSettings: () => settings,
}))

// Load the real module before patching and spread it: when config.js has not
// loaded yet, mock.module replaces it wholesale from the factory, so a bare
// single-export factory would strip every other config export from files that
// import them after this one runs (bun's unit files share one process and the
// order is not fixed). The real getGlobalConfig is captured pre-patch —
// mock.module rewrites the live namespace in place, so calling through the
// namespace object afterwards would recurse. The patch layers this test's
// overrides over the real (test-mode) config so unrelated exports keep seeing
// a realistic object.
const actualConfig = await import('../../src/utils/config.js')
const realGetGlobalConfig = actualConfig.getGlobalConfig
mock.module('../../src/utils/config.js', () => ({
  ...actualConfig,
  getGlobalConfig: () => ({ ...realGetGlobalConfig(), ...globalConfig }),
}))

const {
  DEFAULT_AUTO_COMPACT_BUFFER,
  DEFAULT_AUTO_COMPACT_PERCENTAGE,
  getAutoCompactConfig,
  getAutoCompactThresholdForContextWindow,
  isAutoCompactEnabled,
} = await import('../../src/services/compact/autoCompactConfig.js')

beforeEach(() => {
  settings = {}
  globalConfig = { autoCompactEnabled: true }
  delete process.env.DISABLE_COMPACT
  delete process.env.DISABLE_AUTO_COMPACT
  delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
  delete process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE
})

describe('auto-compact threshold', () => {
  test('defaults to configured context window minus buffer', () => {
    expect(getAutoCompactConfig()).toEqual({
      percentage: DEFAULT_AUTO_COMPACT_PERCENTAGE,
      buffer: DEFAULT_AUTO_COMPACT_BUFFER,
    })
    expect(getAutoCompactThresholdForContextWindow(272_000)).toBe(252_000)
  })

  test('uses the configured context window for smaller models', () => {
    expect(getAutoCompactThresholdForContextWindow(200_000)).toBe(180_000)
  })

  test('percentage cap wins when lower than the buffer threshold', () => {
    settings = { autoCompactPercentage: 80 }

    expect(getAutoCompactThresholdForContextWindow(200_000)).toBe(160_000)
  })

  test('buffer cap wins when lower than the percentage threshold', () => {
    settings = { autoCompactPercentage: 95, autoCompactBuffer: 20_000 }

    expect(getAutoCompactThresholdForContextWindow(200_000)).toBe(180_000)
  })

  test('clamps percentage below 10 to 10 at runtime', () => {
    settings = { autoCompactPercentage: 5 }

    expect(getAutoCompactConfig().percentage).toBe(10)
    expect(getAutoCompactThresholdForContextWindow(200_000)).toBe(20_000)
  })

  test('falls back to default buffer for invalid runtime values', () => {
    settings = { autoCompactBuffer: -1 }

    expect(getAutoCompactConfig().buffer).toBe(DEFAULT_AUTO_COMPACT_BUFFER)
    expect(getAutoCompactThresholdForContextWindow(200_000)).toBe(180_000)
  })

  test('ignores old threshold tuning env vars', () => {
    process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '50'
    process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = '10'

    expect(getAutoCompactThresholdForContextWindow(200_000)).toBe(180_000)
  })
})

describe('auto-compact enabled resolution', () => {
  test('settings value wins over legacy global config', () => {
    settings = { autoCompactEnabled: true }
    globalConfig = { autoCompactEnabled: false }

    expect(isAutoCompactEnabled()).toBe(true)
  })

  test('defaults to true when settings are absent', () => {
    globalConfig = { autoCompactEnabled: false }

    expect(isAutoCompactEnabled()).toBe(true)
  })

  test('disable env vars still turn auto-compact off', () => {
    settings = { autoCompactEnabled: true }
    process.env.DISABLE_AUTO_COMPACT = '1'

    expect(isAutoCompactEnabled()).toBe(false)
  })
})
