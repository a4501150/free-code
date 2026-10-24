import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import * as modelModule from '../../src/utils/model/model.js'
import * as settingsModule from '../../src/utils/settings/settings.js'

type TestSettings = {
  attribution?: {
    commit?: string
    pr?: string
    email?: string
  }
  includeCoAuthoredBy?: boolean
}

let settings: TestSettings = {}
let currentModel = 'anthropic:claude-sonnet-4-6'

// Unit tests share one process, and mock.module patches are permanent —
// mocking settings.js/model.js wholesale here froze getMainLoopModel for
// every later test file. Spy on the namespaces instead and restore after
// each test; attribution.js and gitSettings.js read these through the
// module namespace at call time, so the spies intercept them.
let restores: Array<{ mockRestore(): void }> = []

beforeEach(() => {
  restores = [
    spyOn(settingsModule, 'getInitialSettings').mockImplementation(
      () => settings as never,
    ),
    spyOn(modelModule, 'getMainLoopModel').mockImplementation(
      () => currentModel as never,
    ),
    spyOn(modelModule, 'getDefaultMainLoopModelSetting').mockImplementation(
      () => 'anthropic:claude-sonnet-4-6' as never,
    ),
    spyOn(modelModule, 'getPublicModelDisplayName').mockImplementation(
      (model: string) =>
        (model.startsWith('anthropic:') ? model : null) as never,
    ),
    spyOn(modelModule, 'getPublicModelName').mockImplementation(
      (model: string) =>
        (model === 'internal:secret'
          ? 'Secret Internal'
          : 'Claude Sonnet 4.6') as never,
    ),
  ]
})

afterEach(() => {
  for (const restore of restores) restore.mockRestore()
  restores = []
})

const { getAttributionTexts } = await import('../../src/utils/attribution.js')
const { getCommitAndPRInstructions } =
  await import('../../src/tools/shared/gitInstructions.js')

const HEREDOC_SYNTAX = { commit: 'a HEREDOC', pr: 'a HEREDOC' }

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

  test('attribution.email replaces the default co-author email', () => {
    resetAttributionMocks()
    settings = { attribution: { email: 'bot@example.com' } }

    expect(getAttributionTexts().commit).toBe(
      'Co-Authored-By: Claude Sonnet 4.6 <bot@example.com>',
    )
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

describe('shared git instructions', () => {
  const repoRoot = process.cwd()

  test('git guidance rides the git_instructions attachment, not tool prompts or the agent prompt', () => {
    const carrierSource = readFileSync(
      join(repoRoot, 'src/utils/attachments.ts'),
      'utf8',
    )
    expect(carrierSource).toContain('getCommitAndPRInstructions')
    expect(carrierSource).toContain("type: 'git_instructions'")
    for (const file of [
      'src/context.ts',
      'src/constants/prompts.ts',
      'src/tools/BashTool/prompt.ts',
      'src/tools/PowerShellTool/prompt.ts',
    ]) {
      const source = readFileSync(join(repoRoot, file), 'utf8')
      expect(source).not.toContain('getCommitAndPRInstructions')
    }
  })

  test('keeps normal commit and PR footer guidance', () => {
    resetAttributionMocks()

    const section = getCommitAndPRInstructions(HEREDOC_SYNTAX)

    expect(section).toContain('conventional commit format')
    expect(section).toContain(
      'Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>',
    )
    expect(section).toContain('gh pr create')
    expect(section).toContain('Generated with [Claude Code](')
  })

  test('drops both footers when attribution is disabled', () => {
    resetAttributionMocks()
    settings = { includeCoAuthoredBy: false }

    const section = getCommitAndPRInstructions(HEREDOC_SYNTAX)

    expect(section).toContain('conventional commit format')
    expect(section).not.toContain('Co-Authored-By')
    expect(section).not.toContain('Generated with [Claude Code](')
  })

  test('emits nothing when git instructions are disabled', () => {
    resetAttributionMocks()
    settings = { includeGitInstructions: false }

    expect(getCommitAndPRInstructions(HEREDOC_SYNTAX)).toBe('')
  })
})
