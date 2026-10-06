import { describe, test, expect } from 'bun:test'
import { join } from 'path'
import type { ToolPermissionContext } from '../../src/Tool.js'
import { getPlanSlug, getPlansDirectory } from '../../src/utils/plans.js'
import { FileEditTool } from '../../src/tools/FileEditTool/FileEditTool.js'
import { checkWritePermissionForTool } from '../../src/utils/permissions/filesystem.js'
import * as autoModeState from '../../src/utils/permissions/autoModeState.js'
import { getCwd } from '../../src/utils/cwd.js'

function makeContext(
  overrides: Partial<ToolPermissionContext> = {},
): ToolPermissionContext {
  return {
    mode: 'default',
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: {},
    alwaysDenyRules: {},
    alwaysAskRules: {},
    isBypassPermissionsModeAvailable: false,
    ...overrides,
  } as unknown as ToolPermissionContext
}

const repoPath = `${getCwd()}/src/some-file.ts`

function decide(ctx: ToolPermissionContext) {
  return checkWritePermissionForTool(FileEditTool, { file_path: repoPath }, ctx)
}

describe('plan mode write gate', () => {
  test('plan mode denies edits to regular repo files', () => {
    const result = decide(makeContext({ mode: 'plan' }))
    expect(result.behavior).toBe('deny')
    expect(result.decisionReason).toEqual({ type: 'mode', mode: 'plan' })
    expect(result.message).toContain('plan mode')
  })

  test('plan mode denies even when an allow rule matches', () => {
    const result = decide(
      makeContext({
        mode: 'plan',
        alwaysAllowRules: { session: ['Edit(/src/**)'] },
      }),
    )
    expect(result.behavior).toBe('deny')
    expect(result.decisionReason?.type).toBe('mode')
  })

  test('default mode keeps the pre-existing ask behavior', () => {
    const result = decide(makeContext())
    expect(result.behavior).toBe('ask')
  })

  test('acceptEdits mode keeps the pre-existing allow behavior', () => {
    const result = decide(makeContext({ mode: 'acceptEdits' }))
    expect(result.behavior).toBe('allow')
  })

  test('plan mode entered from bypass keeps edits allowed past the gate', () => {
    // The gate defers: permissions.ts step 2a allows everything for
    // bypass-origin plan mode anyway. Here that means the pre-gate flow.
    const result = decide(
      makeContext({
        mode: 'plan',
        isBypassPermissionsModeAvailable: true,
      }),
    )
    expect(result.behavior).not.toBe('deny')
  })

  test('plan mode with auto active defers to the classifier', () => {
    autoModeState.setAutoModeActive(true)
    try {
      const result = decide(makeContext({ mode: 'plan' }))
      expect(result.behavior).not.toBe('deny')
    } finally {
      autoModeState.setAutoModeActive(false)
    }
  })

  test('the session plan file stays editable in plan mode', () => {
    const planPath = join(getPlansDirectory(), `${getPlanSlug()}.md`)
    const result = checkWritePermissionForTool(
      FileEditTool,
      { file_path: planPath },
      makeContext({ mode: 'plan' }),
    )
    expect(result.behavior).toBe('allow')
  })

  test('deny rules still win', () => {
    const result = decide(
      makeContext({
        mode: 'plan',
        alwaysDenyRules: { session: ['Edit(/src/**)'] },
      }),
    )
    expect(result.behavior).toBe('deny')
    expect(result.decisionReason?.type).toBe('rule')
  })
})
