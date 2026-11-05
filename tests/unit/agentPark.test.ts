import { describe, expect, test } from 'bun:test'
import {
  agentToolInterruptReason,
  finishRunOwnedTasksReminderText,
  isAgentToolInterruptReason,
  ownedTasksReminderText,
  parkUntilOwnedTaskSignal,
  PARK_INITIAL_IDLE_MS,
  resolveFinishRunOwnedTasksGate,
} from '../../src/tools/AgentTool/agentPark.js'
import type { TaskState } from '../../src/tasks/types.js'
import { FINISH_RUN_REMINDER_TAG } from '../../src/tools/FinishRunTool/constants.js'
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

describe('owned-task reminder texts', () => {
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

  test('ownedTasksReminderText lists tasks and wraps the reminder tag', () => {
    const text = ownedTasksReminderText([shellTask, agentTask])
    expect(text.startsWith(`<${FINISH_RUN_REMINDER_TAG}>`)).toBe(true)
    expect(text).toContain('ended your message while still owning 2')
    expect(text).toContain('- bash1 (monitor): tail -f build.log')
    expect(text).toContain('- agent1 (background): port agent')
  })

  test('ownedTasksReminderText idle variant says still waiting', () => {
    expect(ownedTasksReminderText([shellTask], true)).toContain(
      'Still waiting on 1 background task(s) you own',
    )
  })

  test('finishRunOwnedTasksReminderText corrects the FinishRun and states the second-strike contract', () => {
    const text = finishRunOwnedTasksReminderText([shellTask])
    expect(text.startsWith(`<${FINISH_RUN_REMINDER_TAG}>`)).toBe(true)
    expect(text).toContain('was not carried out')
    expect(text).toContain('still own 1 running background task')
    expect(text).toContain('end your message WITHOUT calling FinishRun')
    expect(text).toContain('call FinishRun again to end your run now')
    expect(text).toContain('- bash1 (monitor): tail -f build.log')
  })
})
