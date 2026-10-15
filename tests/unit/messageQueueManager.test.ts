import { beforeEach, describe, expect, test } from 'bun:test'
import type { QueuedCommand } from '../../src/types/textInputTypes.js'
import {
  clearCommandQueue,
  dequeue,
  dequeueAllMatching,
  enqueue,
  enqueuePendingNotification,
  getCommandQueueLength,
  getCommandQueueSnapshot,
  popAllEditable,
} from '../../src/utils/messageQueueManager.js'

const cmd = (
  value: string,
  extra: Partial<QueuedCommand> = {},
): QueuedCommand => ({
  value,
  mode: 'prompt',
  ...extra,
})

/**
 * Characterization for the queue that both the REPL drain loop and the
 * hosted core read: priority order, FIFO within a priority, snapshot
 * identity for useSyncExternalStore, and the editable-pop contract.
 */
describe('command queue', () => {
  beforeEach(() => {
    clearCommandQueue()
  })

  test('dequeue follows now > next > later', () => {
    enqueue(cmd('l', { priority: 'later' }))
    enqueue(cmd('n'))
    enqueue(cmd('w', { priority: 'now' }))
    expect(dequeue()?.value).toBe('w')
    expect(dequeue()?.value).toBe('n')
    expect(dequeue()?.value).toBe('l')
    expect(dequeue()).toBeUndefined()
  })

  test('same priority drains FIFO', () => {
    enqueue(cmd('first'))
    enqueue(cmd('second'))
    enqueue(cmd('third'))
    expect(dequeue()?.value).toBe('first')
    expect(dequeue()?.value).toBe('second')
  })

  test('pending notifications default to later', () => {
    enqueue(cmd('user'))
    enqueuePendingNotification(cmd('notification'))
    expect(dequeue()?.value).toBe('user')
    expect(dequeue()?.value).toBe('notification')
  })

  test('snapshot identity changes only on mutation and stays frozen', () => {
    const empty = getCommandQueueSnapshot()
    expect(getCommandQueueSnapshot()).toBe(empty)

    enqueue(cmd('a'))
    const afterEnqueue = getCommandQueueSnapshot()
    expect(afterEnqueue).not.toBe(empty)
    expect(Object.isFrozen(afterEnqueue)).toBe(true)
    expect(afterEnqueue).toHaveLength(1)

    // Reads alone must not churn the reference, or useSyncExternalStore loops.
    dequeue()
    const afterDequeue = getCommandQueueSnapshot()
    expect(Object.isFrozen(afterDequeue)).toBe(true)
    expect(afterDequeue).not.toBe(afterEnqueue)
    expect(getCommandQueueSnapshot()).toBe(afterDequeue)
  })

  test('dequeueAllMatching keeps non-matches untouched', () => {
    enqueue(cmd('keep', { mode: 'bash' as QueuedCommand['mode'] }))
    enqueue(cmd('drop-1', { priority: 'later' }))
    enqueue(cmd('drop-2', { priority: 'later' }))
    const removed = dequeueAllMatching(c => c.priority === 'later')
    expect(removed.map(c => c.value)).toEqual(['drop-1', 'drop-2'])
    expect(getCommandQueueLength()).toBe(1)
    expect(getCommandQueueSnapshot()[0]?.value).toBe('keep')
  })

  test('popAllEditable folds editable text and leaves the rest', () => {
    enqueue(cmd('one'))
    enqueue(cmd('meta', { isMeta: true }))
    const result = popAllEditable('typed', 2)
    expect(result?.text).toBe('one\ntyped')
    expect(result?.cursorOffset).toBe('one'.length + 1 + 2)
    expect(getCommandQueueLength()).toBe(1)
    expect(getCommandQueueSnapshot()[0]?.value).toBe('meta')
  })

  test('popAllEditable on an all-non-editable queue is undefined', () => {
    enqueue(cmd('meta', { isMeta: true }))
    expect(popAllEditable('typed', 0)).toBeUndefined()
    expect(getCommandQueueLength()).toBe(1)
  })
})
