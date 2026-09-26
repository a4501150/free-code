/**
 * Pin the stdin behavior of execCommandHook when the hook command exits
 * before consuming its stdin.
 *
 * The hook input is written to the child's stdin, but the write-completion
 * promise inside execCommandHook settles synchronously — an EPIPE surfacing
 * on the stdin stream afterwards rejects an already-settled promise and is
 * swallowed. The hook result therefore comes from the child's own exit, not
 * from the failed write. This matters because hook inputs can exceed the
 * 64KB kernel pipe buffer, making EPIPE guaranteed once the reader closes —
 * and it must never reject or hang the hook run.
 */
import { describe, expect, test } from 'bun:test'

import { execCommandHook } from '../../src/utils/hooks.js'

// Comfortably larger than the 64KB pipe buffer on Linux and macOS, so the
// write cannot fully land before an immediate-exit child closes the pipe.
function bigHookInput(bytes: number): string {
  return JSON.stringify({
    hook_event_name: 'SessionEnd',
    source: 'logout',
    blob: 'x'.repeat(bytes),
  })
}

describe('execCommandHook stdin handling', () => {
  test('1MB stdin to a command that exits without reading resolves with the child exit status', async () => {
    const result = await execCommandHook(
      { type: 'command', command: 'true' },
      'SessionEnd',
      'SessionEnd',
      bigHookInput(1024 * 1024),
      new AbortController().signal,
      'test-epipe-hook',
    )

    // The early exit is a normal completion: status comes from `true` (0),
    // not from a synthesized write error.
    expect(result.status).toBe(0)
    expect(result.aborted).toBeFalsy()
    expect(result.stderr).not.toContain('EPIPE')
  }, 15000)

  test('same command with a small payload behaves identically', async () => {
    const result = await execCommandHook(
      { type: 'command', command: 'true' },
      'SessionEnd',
      'SessionEnd',
      bigHookInput(64),
      new AbortController().signal,
      'test-small-stdin-hook',
    )

    expect(result.status).toBe(0)
    expect(result.aborted).toBeFalsy()
  }, 15000)
})
