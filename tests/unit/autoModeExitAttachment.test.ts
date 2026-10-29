import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { ToolUseContext } from '../../src/Tool.js'
import type { Message } from '../../src/types/message.js'
import { getAutoModeExitAttachment } from '../../src/utils/attachments.js'
import {
  needsAutoModeExitAttachment,
  setNeedsAutoModeExitAttachment,
} from '../../src/bootstrap/state.js'
import {
  isAutoModeActive,
  setAutoModeActive,
} from '../../src/utils/permissions/autoModeState.js'

// Unit tests share one process — an auto-mode activation leaked from another
// file would suppress every exit here via the plan-with-auto branch.
beforeEach(() => {
  setAutoModeActive(false)
})

afterEach(() => {
  setAutoModeActive(false)
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

describe('auto_mode_exit attachment', () => {
  test('stays silent when the flag is unset', async () => {
    setNeedsAutoModeExitAttachment(false)

    expect(
      await getAutoModeExitAttachment(
        [attachment('auto_mode')],
        contextWithMode('default'),
      ),
    ).toEqual([])
  })

  // The defect: tab-cycling through auto mode without a request in between
  // sets the transition flag, but no auto_mode announcement ever reached
  // the transcript — the model never entered auto mode, so it must not hear
  // about leaving it.
  test('stays silent when no auto_mode announcement exists', async () => {
    setNeedsAutoModeExitAttachment(true)

    expect(
      await getAutoModeExitAttachment([], contextWithMode('default')),
    ).toEqual([])
  })

  test('a suppressed exit still clears the pending flag', async () => {
    setNeedsAutoModeExitAttachment(true)

    await getAutoModeExitAttachment([], contextWithMode('default'))

    expect(needsAutoModeExitAttachment()).toBe(false)
  })

  test('stays silent when still in auto mode', async () => {
    setNeedsAutoModeExitAttachment(true)

    expect(
      await getAutoModeExitAttachment(
        [attachment('auto_mode')],
        contextWithMode('auto'),
      ),
    ).toEqual([])
    expect(needsAutoModeExitAttachment()).toBe(false)
  })

  // Plan mode can host the auto-mode classifier (mode==='plan' but
  // isAutoModeActive()); the exit must stay suppressed there.
  test('stays silent while auto is active inside plan mode', async () => {
    setAutoModeActive(true)
    setNeedsAutoModeExitAttachment(true)

    expect(
      await getAutoModeExitAttachment(
        [attachment('auto_mode')],
        contextWithMode('plan'),
      ),
    ).toEqual([])
    expect(needsAutoModeExitAttachment()).toBe(false)
  })

  test('fires when an auto_mode announcement exists', async () => {
    setNeedsAutoModeExitAttachment(true)

    const result = await getAutoModeExitAttachment(
      [attachment('auto_mode')],
      contextWithMode('default'),
    )

    expect(result).toEqual([{ type: 'auto_mode_exit' }])
    expect(isAutoModeActive()).toBe(false)
  })

  test('stays silent when the last announcement was already exited', async () => {
    setNeedsAutoModeExitAttachment(true)

    const messages = [attachment('auto_mode'), attachment('auto_mode_exit')]

    expect(
      await getAutoModeExitAttachment(messages, contextWithMode('default')),
    ).toEqual([])
  })
})
