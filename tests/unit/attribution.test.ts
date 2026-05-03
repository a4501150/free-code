import { describe, expect, mock, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

type TestSettings = {
  attribution?: {
    commit?: string
    pr?: string
  }
  includeCoAuthoredBy?: boolean
}

let settings: TestSettings = {}
let currentModel = 'anthropic:claude-sonnet-4-6'

mock.module('../../src/utils/settings/settings.js', () => ({
  getInitialSettings: () => settings,
}))

mock.module('../../src/utils/model/model.js', () => ({
  getMainLoopModel: () => currentModel,
  getDefaultMainLoopModelSetting: () => 'anthropic:claude-sonnet-4-6',
  getPublicModelDisplayName: (model: string) =>
    model.startsWith('anthropic:') ? model : null,
  getPublicModelName: (model: string) =>
    model === 'internal:secret' ? 'Secret Internal' : 'Claude Sonnet 4.6',
}))

const { getAttributionTexts } = await import('../../src/utils/attribution.js')

function resetAttributionMocks() {
  settings = {}
  currentModel = 'anthropic:claude-sonnet-4-6'
}

describe('getAttributionTexts', () => {
  test('returns default commit and PR attribution', () => {
    resetAttributionMocks()

    expect(getAttributionTexts()).toEqual({
      commit: 'Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>',
      pr: expect.stringContaining('Generated with [Claude Code]('),
    })
  })

  test('uses custom commit attribution', () => {
    resetAttributionMocks()
    settings = {
      attribution: { commit: 'Reviewed-by: Human <human@example.com>' },
    }

    expect(getAttributionTexts()).toEqual({
      commit: 'Reviewed-by: Human <human@example.com>',
      pr: expect.stringContaining('Generated with [Claude Code]('),
    })
  })

  test('uses custom PR attribution', () => {
    resetAttributionMocks()
    settings = { attribution: { pr: 'Custom PR footer' } }

    expect(getAttributionTexts()).toEqual({
      commit: 'Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>',
      pr: 'Custom PR footer',
    })
  })

  test('respects empty string overrides', () => {
    resetAttributionMocks()
    settings = { attribution: { commit: '', pr: '' } }

    expect(getAttributionTexts()).toEqual({ commit: '', pr: '' })
  })

  test('deprecated includeCoAuthoredBy false disables both footers', () => {
    resetAttributionMocks()
    settings = { includeCoAuthoredBy: false }

    expect(getAttributionTexts()).toEqual({ commit: '', pr: '' })
  })

  test('falls back to the default public model name for unknown external models', () => {
    resetAttributionMocks()
    currentModel = 'internal:secret'

    expect(getAttributionTexts().commit).toBe(
      'Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>',
    )
  })
})

describe('Bash prompt attribution integration', () => {
  const repoRoot = process.cwd()

  test('keeps normal commit and PR footer guidance', () => {
    const source = readFileSync(
      join(repoRoot, 'src/tools/BashTool/prompt.ts'),
      'utf8',
    )

    expect(source).toContain('getAttributionTexts()')
    expect(source).toContain('commitFooter')
    expect(source).toContain('gh pr create')
    expect(source).toContain('prFooter')
  })
})
