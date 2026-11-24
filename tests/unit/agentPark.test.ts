import { describe, expect, test } from 'bun:test'
import {
  agentToolInterruptReason,
  implicitEndIsDeliberate,
  isAgentToolInterruptReason,
  MAX_TRUNCATED_END_NUDGES,
  parkedWithTasksReminderText,
  parkUntilOwnedTaskSignal,
  PARK_INITIAL_IDLE_MS,
  resolveFinishRunOwnedTasksGate,
  runNotEndedReminderText,
} from '../../src/tools/AgentTool/agentPark.js'
import type { Message } from '../../src/types/message.js'
import type { TaskState } from '../../src/tasks/types.js'
import {
  FINISH_RUN_REMINDER,
  FINISH_RUN_REMINDER_TAG,
  LEGACY_END_TURN_REMINDER,
} from '../../src/tools/FinishRunTool/constants.js'
import {
  clearCommandQueue,
  enqueuePendingNotification,
} from '../../src/utils/messageQueueManager.js'

const MY_AGENT = 'a1234567890abcdef' as const
const OTHER_AGENT = 'afedcba0987654321' as const

function park(
  opts: Partial<Parameters<typeof parkUntilOwnedTaskSignal>[0]> = {},
) {
  return parkUntilOwnedTaskSignal({
    agentId: MY_AGENT,
    idleMs: 5000,
    abortSignal: new AbortController().signal,
    getPendingMessageCount: () => 0,
    ...opts,
  })
}

/** Resolve to 'pending' if the promise is still unsettled after ms. */
async function settledAfter(
  p: Promise<string>,
  ms: number,
): Promise<string | 'pending'> {
  const result = await Promise.race([
    p.then(w => `resolved:${w}`),
    new Promise<'pending'>(r => setTimeout(() => r('pending'), ms)),
  ])
  return result
}

describe('agent tool-interrupt abort reason', () => {
  test('is agentId-addressed so only the viewed run adopts it', () => {
    const reason = agentToolInterruptReason(MY_AGENT)
    expect(reason).toBe(`tool-interrupt:${MY_AGENT}`)
    expect(isAgentToolInterruptReason(reason, MY_AGENT)).toBe(true)
    // A sync child shares its parent's controller: the parent's interrupt
    // must not read as the child's own.
    expect(isAgentToolInterruptReason(reason, OTHER_AGENT)).toBe(false)
    // Kills (default aborts) carry a DOMException, not a reason string.
    expect(isAgentToolInterruptReason(new Error('killed'), MY_AGENT)).toBe(
      false,
    )
    expect(isAgentToolInterruptReason(undefined, MY_AGENT)).toBe(false)
  })
})

describe('parkUntilOwnedTaskSignal', () => {
  test('idle timer is 10 minutes, not something degenerate', () => {
    expect(PARK_INITIAL_IDLE_MS).toBe(10 * 60 * 1000)
  })

  test('does not resolve with no signals', async () => {
    clearCommandQueue()
    const result = await settledAfter(park(), 300)
    expect(result).toBe('pending')
    clearCommandQueue()
  })

  test('resolves signal when a command addressed to this agent is enqueued', async () => {
    clearCommandQueue()
    const p = park()
    enqueuePendingNotification({
      value: 'notification for me',
      mode: 'task-notification',
      priority: 'next',
      agentId: MY_AGENT,
    })
    await expect(p).resolves.toBe('signal')
    clearCommandQueue()
  })

  test('does not resolve for a command addressed to another agent', async () => {
    clearCommandQueue()
    const p = park()
    enqueuePendingNotification({
      value: 'notification for someone else',
      mode: 'task-notification',
      priority: 'next',
      agentId: OTHER_AGENT,
    })
    const result = await settledAfter(p, 300)
    expect(result).toBe('pending')
    clearCommandQueue()
  })

  test('resolves idle after the backoff timer', async () => {
    const p = park({ idleMs: 50 })
    await expect(p).resolves.toBe('idle')
  })

  test('resolves abort on the run abort signal', async () => {
    const controller = new AbortController()
    const p = park({ abortSignal: controller.signal })
    controller.abort()
    await expect(p).resolves.toBe('abort')
  })

  test('resolves signal when pendingMessages grow', async () => {
    clearCommandQueue()
    let pending = 0
    const p = park({ getPendingMessageCount: () => pending })
    // queuePendingMessage pings notifyCommandQueueListeners; simulate the
    // state change without touching the agent registry.
    pending = 1
    const { notifyCommandQueueListeners } =
      await import('../../src/utils/messageQueueManager.js')
    notifyCommandQueueListeners()
    await expect(p).resolves.toBe('signal')
    clearCommandQueue()
  })
})

describe('resolveFinishRunOwnedTasksGate', () => {
  test('honors FinishRun with no owned tasks', () => {
    expect(
      resolveFinishRunOwnedTasksGate({
        ownedTaskCount: 0,
        strikes: 0,
        roundDidWork: false,
        overBudget: false,
      }),
    ).toBe('honor')
  })

  test('honors FinishRun when the turns budget is exhausted', () => {
    expect(
      resolveFinishRunOwnedTasksGate({
        ownedTaskCount: 3,
        strikes: 0,
        roundDidWork: false,
        overBudget: true,
      }),
    ).toBe('honor')
  })

  test('gates the first FinishRun with owned tasks', () => {
    expect(
      resolveFinishRunOwnedTasksGate({
        ownedTaskCount: 2,
        strikes: 0,
        roundDidWork: false,
        overBudget: false,
      }),
    ).toBe('gate')
  })

  test('honors the second consecutive no-work FinishRun (deliberate abandon)', () => {
    expect(
      resolveFinishRunOwnedTasksGate({
        ownedTaskCount: 2,
        strikes: 1,
        roundDidWork: false,
        overBudget: false,
      }),
    ).toBe('honor')
  })

  test('a round that did work answers the previous gate and gates again', () => {
    expect(
      resolveFinishRunOwnedTasksGate({
        ownedTaskCount: 2,
        strikes: 1,
        roundDidWork: true,
        overBudget: false,
      }),
    ).toBe('gate')
  })
})

describe('run-mechanics reminder texts', () => {
  const shellTask = {
    type: 'local_bash',
    id: 'bash1',
    kind: 'monitor',
    command: 'tail -f build.log',
    description: 'build watcher',
  } as unknown as TaskState
  const agentTask = {
    type: 'local_agent',
    id: 'agent1',
    description: 'port agent',
  } as unknown as TaskState

  test('runNotEndedReminderText states the two actions and wraps the tag', () => {
    // The plain variant is not produced by any call site: a textless end
    // is always truncated; a park-idle wake always had tasks finish.
    const text = runNotEndedReminderText('tasksFinished')
    expect(text.startsWith(`<${FINISH_RUN_REMINDER_TAG}>`)).toBe(true)
    expect(text).toContain('Your run has not ended')
    expect(text).toContain('no final report to your caller')
    expect(text).toContain('Continue whatever remains')
    expect(text).toContain('background tasks have finished')
    expect(text).not.toContain('cut off')
  })

  test('runNotEndedReminderText variants state their reason', () => {
    const truncated = runNotEndedReminderText('truncated')
    expect(truncated).toContain('cut off before it delivered anything')
    expect(truncated).not.toContain('no final report')
    expect(truncated).not.toContain('background tasks have finished')
  })

  test('runNotEndedReminderText is not the legacy ack-skip nudge', () => {
    // The post-nudge ack skip in finalizeAgentTool matches the two legacy
    // texts exactly; a reply to this reminder must stay deliverable as the
    // run's result.
    const variants = [
      runNotEndedReminderText('truncated'),
      runNotEndedReminderText('tasksFinished'),
    ]
    for (const text of variants) {
      expect(text).not.toBe(FINISH_RUN_REMINDER)
      expect(text).not.toBe(LEGACY_END_TURN_REMINDER)
    }
  })

  test('parkedWithTasksReminderText lists tasks, offers both options, wraps the tag', () => {
    const text = parkedWithTasksReminderText([shellTask, agentTask])
    expect(text.startsWith(`<${FINISH_RUN_REMINDER_TAG}>`)).toBe(true)
    expect(text).toContain('You own 2 running background task(s)')
    expect(text).toContain('- bash1 (monitor): tail -f build.log')
    expect(text).toContain('- agent1 (background): port agent')
    expect(text).toContain('no tool calls at all')
    expect(text).toContain('no-op commands (echo, true, sleep)')
    expect(text).toContain('call FinishRun in the same message')
    expect(text).toContain('will be killed')
    expect(text).not.toContain('was not carried out')
  })

  test('parkedWithTasksReminderText gated variant corrects the FinishRun', () => {
    const text = parkedWithTasksReminderText([shellTask], {
      finishRunGated: true,
    })
    expect(text).toContain('was not carried out')
    expect(text).toContain('still own 1 running background task')
    expect(text).toContain('- bash1 (monitor): tail -f build.log')
  })

  test('MAX_TRUNCATED_END_NUDGES grants exactly one recovery round', () => {
    expect(MAX_TRUNCATED_END_NUDGES).toBe(1)
  })
})

describe('implicitEndIsDeliberate', () => {
  const assistant = (blocks: Array<{ type: string }>): Message =>
    ({
      type: 'assistant',
      message: { role: 'assistant', content: blocks },
    }) as unknown as Message
  const user = (content: unknown): Message =>
    ({
      type: 'user',
      message: { role: 'user', content },
    }) as unknown as Message
  const progress = (): Message => ({ type: 'progress' }) as unknown as Message

  test('a text-carrying assistant tail is deliberate', () => {
    expect(
      implicitEndIsDeliberate(
        [],
        [
          user('task prompt'),
          assistant([{ type: 'reasoning' }, { type: 'text', text: 'report' }]),
        ],
      ),
    ).toBe(true)
  })

  test('a reasoning-only assistant tail is a truncated end', () => {
    expect(
      implicitEndIsDeliberate(
        [],
        [user('task prompt'), assistant([{ type: 'reasoning' }])],
      ),
    ).toBe(false)
  })

  test('a tool-use assistant tail is a truncated end', () => {
    expect(
      implicitEndIsDeliberate(
        [],
        [
          assistant([{ type: 'text', text: 'working' }]),
          assistant([{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }]),
        ],
      ),
    ).toBe(false)
  })

  test('a tool-result user tail is a truncated end (empty follow-up call)', () => {
    expect(
      implicitEndIsDeliberate(
        [],
        [
          assistant([{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }]),
          user([{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }]),
        ],
      ),
    ).toBe(false)
  })

  test('progress and attachment tails are skipped, not judged', () => {
    expect(
      implicitEndIsDeliberate(
        [],
        [
          assistant([{ type: 'text', text: 'report' }]),
          progress(),
          {
            type: 'attachment',
            attachment: { type: 'structured_output' },
          } as unknown as Message,
        ],
      ),
    ).toBe(true)
  })

  test('an empty round is not deliberate', () => {
    expect(implicitEndIsDeliberate([], [])).toBe(false)
  })

  test('a round that produced nothing substantive falls back to the seed tail', () => {
    // runMessages empty: the gate judges the seed's tail — an
    // assistant-with-text seed tail is deliberate, a user prompt tail is
    // not.
    expect(
      implicitEndIsDeliberate(
        [assistant([{ type: 'text', text: 'report' }])],
        [],
      ),
    ).toBe(true)
    expect(implicitEndIsDeliberate([user('resume prompt')], [])).toBe(false)
  })
})
