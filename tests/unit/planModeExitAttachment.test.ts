import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ToolUseContext } from '../../src/Tool.js'
import type { Message } from '../../src/types/message.js'
import { getPlanModeExitAttachment } from '../../src/utils/attachments.js'
import {
  needsPlanModeExitAttachment,
  setNeedsPlanModeExitAttachment,
} from '../../src/bootstrap/state.js'

let configDir: string

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'plan-mode-exit-'))
  process.env.FREECODE_CONFIG_DIR = configDir
})

afterEach(async () => {
  delete process.env.FREECODE_CONFIG_DIR
  await rm(configDir, { recursive: true, force: true })
})

function contextWithMode(mode: string): ToolUseContext {
  return {
    getAppState: () => ({ toolPermissionContext: { mode } }),
  } as ToolUseContext
}

function attachment(type: string): Message {
  return {
    type: 'attachment',
    uuid: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    attachment: { type },
  } as unknown as Message
}

describe('plan_mode_exit attachment', () => {
  test('stays silent when the flag is unset', async () => {
    setNeedsPlanModeExitAttachment(false)

    expect(
      await getPlanModeExitAttachment(
        [attachment('plan_mode')],
        contextWithMode('default'),
      ),
    ).toEqual([])
  })

  // The defect: tab-cycling through plan mode without a request in between
  // sets the transition flag, but no plan_mode announcement ever reached
  // the transcript — the model never entered plan mode, so it must not hear
  // about leaving it.
  test('stays silent when no plan_mode announcement exists', async () => {
    setNeedsPlanModeExitAttachment(true)

    expect(
      await getPlanModeExitAttachment([], contextWithMode('default')),
    ).toEqual([])
  })

  test('a suppressed exit still clears the pending flag', async () => {
    setNeedsPlanModeExitAttachment(true)

    await getPlanModeExitAttachment([], contextWithMode('default'))

    expect(needsPlanModeExitAttachment()).toBe(false)
  })

  test('stays silent when still in plan mode', async () => {
    setNeedsPlanModeExitAttachment(true)

    expect(
      await getPlanModeExitAttachment(
        [attachment('plan_mode')],
        contextWithMode('plan'),
      ),
    ).toEqual([])
    expect(needsPlanModeExitAttachment()).toBe(false)
  })

  test('fires when a plan_mode announcement exists', async () => {
    setNeedsPlanModeExitAttachment(true)

    const result = await getPlanModeExitAttachment(
      [attachment('plan_mode')],
      contextWithMode('default'),
    )

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      type: 'plan_mode_exit',
      planExists: false,
    })
  })

  test('fires after a re-entry announcement', async () => {
    setNeedsPlanModeExitAttachment(true)

    const messages = [
      attachment('plan_mode'),
      attachment('plan_mode_exit'),
      attachment('plan_mode_reentry'),
      attachment('plan_mode'),
    ]

    expect(
      await getPlanModeExitAttachment(messages, contextWithMode('default')),
    ).toHaveLength(1)
  })

  test('stays silent when the last announcement was already exited', async () => {
    setNeedsPlanModeExitAttachment(true)

    const messages = [attachment('plan_mode'), attachment('plan_mode_exit')]

    expect(
      await getPlanModeExitAttachment(messages, contextWithMode('default')),
    ).toEqual([])
  })
})
