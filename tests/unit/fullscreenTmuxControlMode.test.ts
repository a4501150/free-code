import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  _resetForTesting,
  _resetTmuxControlModeProbeForTesting,
  isTmuxControlMode,
  maybeGetTmuxControlModeWarning,
} from '../../src/utils/fullscreen'
import { setIsInteractive } from '../../src/bootstrap/state'

const ENV_KEYS = ['TMUX', 'TERM_PROGRAM', 'TERM'] as const

describe('tmux control mode detection', () => {
  let saved: Record<string, string | undefined>

  beforeEach(() => {
    saved = {}
    for (const key of ENV_KEYS) saved[key] = process.env[key]
    _resetTmuxControlModeProbeForTesting()
    _resetForTesting()
    setIsInteractive(true)
  })

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
    _resetTmuxControlModeProbeForTesting()
    _resetForTesting()
  })

  test('iTerm2 + TMUX + non-screen TERM is detected as control mode', () => {
    process.env.TMUX = '/tmp/tmux-501/default,1234,0'
    process.env.TERM_PROGRAM = 'iTerm.app'
    process.env.TERM = 'xterm-256color'
    expect(isTmuxControlMode()).toBe(true)
  })

  test('regular tmux (screen TERM) is not control mode', () => {
    process.env.TMUX = '/tmp/tmux-501/default,1234,0'
    process.env.TERM_PROGRAM = 'iTerm.app'
    process.env.TERM = 'screen-256color'
    expect(isTmuxControlMode()).toBe(false)
  })

  test('no TMUX is not control mode', () => {
    delete process.env.TMUX
    process.env.TERM_PROGRAM = 'iTerm.app'
    process.env.TERM = 'xterm-256color'
    expect(isTmuxControlMode()).toBe(false)
  })

  test('warning fires once per session under control mode', () => {
    process.env.TMUX = '/tmp/tmux-501/default,1234,0'
    process.env.TERM_PROGRAM = 'iTerm.app'
    process.env.TERM = 'xterm-256color'

    const first = maybeGetTmuxControlModeWarning()
    expect(first).toContain('tmux -CC')
    expect(maybeGetTmuxControlModeWarning()).toBeNull()
  })

  test('no warning outside control mode', () => {
    delete process.env.TMUX
    expect(maybeGetTmuxControlModeWarning()).toBeNull()
  })

  test('no warning in non-interactive sessions', () => {
    process.env.TMUX = '/tmp/tmux-501/default,1234,0'
    process.env.TERM_PROGRAM = 'iTerm.app'
    process.env.TERM = 'xterm-256color'
    setIsInteractive(false)
    expect(maybeGetTmuxControlModeWarning()).toBeNull()
  })
})
