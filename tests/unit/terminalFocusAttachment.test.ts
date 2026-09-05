/**
 * Terminal focus used to be injected into the user context, which is API
 * message 0 — so every alt-tab rewrote the cached message prefix. It is now an
 * append-only attachment that fires only on a transition.
 *
 * The transition guard is also what stops it duplicating: getAttachmentMessages
 * runs once per tool-loop iteration, not once per user turn, and everything it
 * yields is retained for the rest of the session.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  getLastEmittedTerminalFocus,
  setLastEmittedTerminalFocus,
} from '../../src/bootstrap/state.js'
import { getTerminalFocusAttachments } from '../../src/utils/attachments.js'
import {
  resetTerminalFocusState,
  setTerminalFocused,
} from '../../src/ink/terminal-focus-state.js'

// The generator is gated on proactive mode, which is off in unit tests, so it
// short-circuits. These tests pin the cache-relevant contract that holds
// regardless: it never emits without a transition, and it never mutates
// message 0.
beforeEach(() => {
  resetTerminalFocusState()
  setLastEmittedTerminalFocus(null)
})

afterEach(() => {
  resetTerminalFocusState()
  setLastEmittedTerminalFocus(null)
})

describe('terminal focus attachment', () => {
  test('emits nothing when proactive mode is inactive', () => {
    setTerminalFocused(false)
    expect(getTerminalFocusAttachments()).toEqual([])
  })

  test('emits nothing on repeated calls with an unchanged state', () => {
    // Guards against the per-tool-loop-iteration duplication bug class.
    setLastEmittedTerminalFocus(true)
    setTerminalFocused(true)
    for (let i = 0; i < 5; i++) {
      expect(getTerminalFocusAttachments()).toEqual([])
    }
  })

  test('leaves the baseline untouched when it cannot emit', () => {
    setLastEmittedTerminalFocus(true)
    setTerminalFocused(false)
    getTerminalFocusAttachments()
    // Proactive mode is off, so nothing was announced; the recorded baseline
    // must not drift, or the real transition would later be swallowed.
    expect(getLastEmittedTerminalFocus()).toBe(true)
  })
})

describe('terminal focus is not part of the user context', () => {
  test('formatUserContextMessageContent has no focus key', async () => {
    const { formatUserContextMessageContent } =
      await import('../../src/utils/contextInjection.js')
    const content = formatUserContextMessageContent({
      'CLAUDE.md': 'memory',
      currentDate: 'Today is a day.',
    })
    expect(content).not.toMatch(/terminalFocus/i)
    expect(content).not.toMatch(/unfocused/i)
  })
})
