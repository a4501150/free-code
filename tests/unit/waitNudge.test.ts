import { describe, expect, test } from 'bun:test'

import { BashTool } from '../../src/tools/BashTool/BashTool.js'
import type { Message } from '../../src/types/message.js'
import {
  decideWaitNudge,
  scanPriorWaitNudges,
  type WaitNudgeKind,
} from '../../src/utils/task/waitNudge.js'

function nudgeMessage(kind: WaitNudgeKind): Message {
  return {
    type: 'user',
    uuid: 'test-uuid',
    timestamp: '2026-11-23T00:00:00.000Z',
    message: { role: 'user', content: 'result' },
    toolUseResult: { waitNudge: kind, waitNudgeText: 'nudged' },
  } as unknown as Message
}

describe('decideWaitNudge', () => {
  const base = {
    output: '',
    exitCode: 0,
    timeoutMs: 120_000,
    ownRunningTaskIds: [] as string[],
    monitorAvailable: true,
    priorKinds: () => new Set<WaitNudgeKind>(),
  }

  test('unflagged command gets no nudge', () => {
    expect(decideWaitNudge({ ...base, command: 'cargo build' })).toBeNull()
    expect(decideWaitNudge({ ...base, command: 'sleep 20' })).toBeNull()
  })

  test('own running background tasks -> end-turn advice naming them', () => {
    const d = decideWaitNudge({
      ...base,
      command: 'sleep 45 && tail -3 out.log',
      ownRunningTaskIds: ['b5lwbahs3'],
    })
    expect(d?.kind).toBe('end-turn')
    expect(d?.text).toContain('task b5lwbahs3')
    expect(d?.text).toContain('End your turn')
  })

  test('no own tasks -> Monitor advice', () => {
    const d = decideWaitNudge({ ...base, command: 'sleep 90; tail out.log' })
    expect(d?.kind).toBe('monitor')
    expect(d?.text).toContain('Monitor tool')
  })

  test('Monitor disabled -> bounded-wait fallback text', () => {
    const d = decideWaitNudge({
      ...base,
      command: 'sleep 90',
      monitorAvailable: false,
    })
    expect(d?.kind).toBe('monitor')
    expect(d?.text).not.toContain('Monitor tool')
    expect(d?.text).toContain('`timeout`')
  })

  test('timeout kill is its own kind and fires with a how-to-wait tail', () => {
    const d = decideWaitNudge({
      ...base,
      command: 'sleep 240',
      exitCode: 143,
      output: 'Command timed out after 2m\n(remainder)',
    })
    expect(d?.kind).toBe('timeout-killed')
    expect(d?.text).toContain('killed by the Bash timeout')
    expect(d?.text).toContain('Monitor tool')
  })

  test('exit 143 without the timeout marker is not treated as a timeout kill', () => {
    // killTask also SIGTERMs; only the harness timeout prepends the marker.
    const d = decideWaitNudge({
      ...base,
      command: 'sleep 240',
      exitCode: 143,
      output: 'killed by user',
      ownRunningTaskIds: ['b1'],
    })
    expect(d?.kind).toBe('end-turn')
  })

  test('timeout-killed fires even when both other kinds are already spent', () => {
    const prior = new Set<WaitNudgeKind>(['end-turn', 'monitor'])
    expect(
      decideWaitNudge({
        ...base,
        command: 'while :; do sleep 0.1; done',
        exitCode: 143,
        output: 'Command timed out after 2m',
        priorKinds: () => prior,
      })?.kind,
    ).toBe('timeout-killed')
  })

  test('once per kind: prior nudges of the same kind suppress', () => {
    const prior = new Set<WaitNudgeKind>(['monitor'])
    expect(
      decideWaitNudge({
        ...base,
        command: 'sleep 90',
        priorKinds: () => prior,
      }),
    ).toBeNull()
    // ...but a different kind still fires.
    expect(
      decideWaitNudge({
        ...base,
        command: 'sleep 90',
        ownRunningTaskIds: ['b1'],
        priorKinds: () => prior,
      })?.kind,
    ).toBe('end-turn')
  })

  test('loop wait is described as a polling loop', () => {
    const d = decideWaitNudge({
      ...base,
      command: 'while ! grep -q DONE log; do sleep 5; done',
    })
    expect(d?.text).toContain('polling loop')
  })
})

describe('BashTool.validateInput guaranteed-timeout rejection', () => {
  const validate = (input: {
    command: string
    timeout?: number
    run_in_background?: boolean
  }) =>
    BashTool.validateInput!(
      input as Parameters<typeof BashTool.validateInput>[0],
      {} as Parameters<typeof BashTool.validateInput>[1],
    )

  test('a sleep that outlasts the timeout is rejected with how-to-wait text', async () => {
    const res = await validate({ command: 'sleep 240' })
    expect(res.result).toBe(false)
    if (!res.result) {
      expect(res.message).toContain('cannot finish under this command')
      expect(res.message).toContain('Monitor tool')
    }
  })

  test('a sleep covered by an explicit timeout passes', async () => {
    const res = await validate({ command: 'sleep 240', timeout: 300_000 })
    expect(res.result).toBe(true)
  })

  test('backgrounded sleeps are exempt — long timers as self-wake tasks are legitimate', async () => {
    const res = await validate({
      command: 'sleep 1200',
      run_in_background: true,
    })
    expect(res.result).toBe(true)
  })

  test('sub-threshold sleeps pass', async () => {
    expect((await validate({ command: 'sleep 20' })).result).toBe(true)
    expect((await validate({ command: 'sleep $N' })).result).toBe(true)
    expect((await validate({ command: 'cargo build' })).result).toBe(true)
  })
})

describe('scanPriorWaitNudges', () => {
  test('reads structured waitNudge fields off user messages only', () => {
    const msgs = [
      nudgeMessage('end-turn'),
      {
        type: 'assistant',
        uuid: 'a',
        timestamp: '',
        message: { role: 'assistant', content: [] },
        // A toolUseResult-bearing assistant message must be ignored.
        toolUseResult: { waitNudge: 'monitor' },
      } as unknown as Message,
      nudgeMessage('timeout-killed'),
      {
        type: 'user',
        uuid: 'b',
        timestamp: '',
        message: { role: 'user', content: 'plain' },
        toolUseResult: 'Error: not a nudge',
      } as unknown as Message,
    ]
    const kinds = scanPriorWaitNudges(msgs)
    expect(kinds.has('end-turn')).toBe(true)
    expect(kinds.has('timeout-killed')).toBe(true)
    expect(kinds.has('monitor')).toBe(false)
  })

  test('unknown waitNudge strings are ignored (forward-compat)', () => {
    const msgs = [
      {
        type: 'user',
        uuid: 'a',
        timestamp: '',
        message: { role: 'user', content: 'x' },
        toolUseResult: { waitNudge: 'some-future-kind' },
      } as unknown as Message,
    ]
    expect(scanPriorWaitNudges(msgs).size).toBe(0)
  })
})
