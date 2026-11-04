import { describe, expect, test } from 'bun:test'
import {
  endTurnOwnedTasksReminderText,
  ownedTasksReminderText,
  parkUntilOwnedTaskSignal,
  PARK_INITIAL_IDLE_MS,
  resolveEndTurnOwnedTasksGate,
} from '../../src/tools/AgentTool/agentPark.js'
import type { TaskState } from '../../src/tasks/types.js'
import { END_TURN_REMINDER_TAG } from '../../src/tools/EndTurnTool/constants.js'
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

describe('resolveEndTurnOwnedTasksGate', () => {
  test('honors EndTurn with no owned tasks', () => {
    expect(
      resolveEndTurnOwnedTasksGate({
        ownedTaskCount: 0,
        strikes: 0,
        roundDidWork: false,
        overBudget: false,
      }),
    ).toBe('honor')
  })

  test('honors EndTurn when the turns budget is exhausted', () => {
    expect(
      resolveEndTurnOwnedTasksGate({
        ownedTaskCount: 3,
        strikes: 0,
        roundDidWork: false,
        overBudget: true,
      }),
    ).toBe('honor')
  })

  test('gates the first EndTurn with owned tasks', () => {
    expect(
      resolveEndTurnOwnedTasksGate({
        ownedTaskCount: 2,
        strikes: 0,
        roundDidWork: false,
        overBudget: false,
      }),
    ).toBe('gate')
  })

  test('honors the second consecutive no-work EndTurn (deliberate abandon)', () => {
    expect(
      resolveEndTurnOwnedTasksGate({
        ownedTaskCount: 2,
        strikes: 1,
        roundDidWork: false,
        overBudget: false,
      }),
    ).toBe('honor')
  })

  test('a round that did work answers the previous gate and gates again', () => {
    expect(
      resolveEndTurnOwnedTasksGate({
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
    expect(text.startsWith(`<${END_TURN_REMINDER_TAG}>`)).toBe(true)
    expect(text).toContain('ended your message while still owning 2')
    expect(text).toContain('- bash1 (monitor): tail -f build.log')
    expect(text).toContain('- agent1 (background): port agent')
  })

  test('ownedTasksReminderText idle variant says still waiting', () => {
    expect(ownedTasksReminderText([shellTask], true)).toContain(
      'Still waiting on 1 background task(s) you own',
    )
  })

  test('endTurnOwnedTasksReminderText corrects the EndTurn and states the second-strike contract', () => {
    const text = endTurnOwnedTasksReminderText([shellTask])
    expect(text.startsWith(`<${END_TURN_REMINDER_TAG}>`)).toBe(true)
    expect(text).toContain('was not carried out')
    expect(text).toContain('still own 1 running background task')
    expect(text).toContain('end your message WITHOUT calling EndTurn')
    expect(text).toContain('call EndTurn again to end your run now')
    expect(text).toContain('- bash1 (monitor): tail -f build.log')
  })
})
