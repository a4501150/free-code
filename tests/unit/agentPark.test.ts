import { describe, expect, test } from 'bun:test'
import {
  parkUntilOwnedTaskSignal,
  PARK_INITIAL_IDLE_MS,
} from '../../src/tools/AgentTool/agentPark.js'
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
