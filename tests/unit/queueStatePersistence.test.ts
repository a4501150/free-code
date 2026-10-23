import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, rmSync } from 'fs'
import { getSessionId, regenerateSessionId } from '../../src/bootstrap/state.js'
import { asAgentId } from '../../src/types/ids.js'
import type { QueuedCommand } from '../../src/types/textInputTypes.js'
import {
  clearCommandQueue,
  dequeue,
  enqueue,
  flushQueueStatePersistence,
  restoreQueue,
} from '../../src/utils/messageQueueManager.js'
import {
  flushSessionStorage,
  getPersistedQueueState,
  getTranscriptPath,
  resetSessionFilePointer,
} from '../../src/utils/sessionStorage.js'

/**
 * Queue-state persistence round-trip: every queue mutation appends a
 * latest-wins snapshot of the user-typed commands; resume reads the last
 * snapshot and replays it into the live queue. These tests cover the
 * write-then-read cycle against the real session JSONL, mirroring
 * sessionStorage.writeThrough.test.ts.
 */

const created: string[] = []
process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'

afterAll(() => {
  delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
  for (const file of created) rmSync(file, { force: true })
})

function freshSession(): string {
  resetSessionFilePointer()
  regenerateSessionId()
  return getTranscriptPath()
}

async function flushAndTrack(path: string): Promise<void> {
  // The snapshot writes are serialized on a chain in messageQueueManager;
  // storage's flush only drains writes that have already been handed to it,
  // so wait for the chain first.
  await flushQueueStatePersistence()
  await flushSessionStorage()
  if (!created.includes(path)) created.push(path)
}

function queueStateLineCount(path: string): number {
  if (!existsSync(path)) return 0
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(line => line.includes('"type":"queue-state"')).length
}

const cmd = (
  value: string,
  extra: Partial<QueuedCommand> = {},
): QueuedCommand => ({
  value,
  mode: 'prompt',
  ...extra,
})

describe('queue-state persistence', () => {
  beforeEach(() => {
    clearCommandQueue()
  })

  test('mutations persist only user-typed commands in FIFO order', async () => {
    const path = freshSession()
    enqueue(cmd('first'))
    enqueue(cmd('notification', { mode: 'task-notification' }))
    enqueue(cmd('meta', { isMeta: true }))
    enqueue(cmd('agent-scoped', { agentId: asAgentId('agent-1') }))
    enqueue(cmd('second'))
    await flushAndTrack(path)

    const persisted = await getPersistedQueueState(getSessionId())
    expect(persisted?.map(c => c.value)).toEqual(['first', 'second'])
  })

  test('read returns the latest snapshot (drained queue wins over older ones)', async () => {
    const path = freshSession()
    enqueue(cmd('queued'))
    await flushAndTrack(path)
    enqueue(cmd('queued too'))
    await flushAndTrack(path)
    // Two snapshots on disk; the read must return the last one.
    expect(queueStateLineCount(path)).toBeGreaterThanOrEqual(2)

    dequeue()
    dequeue()
    await flushAndTrack(path)

    const drained = await getPersistedQueueState(getSessionId())
    expect(drained).toEqual([])
  })

  test('snapshot round-trips through a simulated process restart', async () => {
    const path = freshSession()
    enqueue(cmd('survives the restart'))
    await flushAndTrack(path)

    // Simulate a restart: the in-memory queue is empty (restoreQueue
    // suppresses the persist write, so the on-disk snapshot is untouched).
    const before = queueStateLineCount(path)
    restoreQueue([])
    await flushAndTrack(path)
    expect(queueStateLineCount(path)).toBe(before)

    const persisted = await getPersistedQueueState(getSessionId())
    expect(persisted?.map(c => c.value)).toEqual(['survives the restart'])

    restoreQueue(persisted ?? [])
    expect(dequeue()?.value).toBe('survives the restart')
    expect(dequeue()).toBeUndefined()
  })

  test('restoreQueue does not append a new snapshot', async () => {
    const path = freshSession()
    enqueue(cmd('already persisted'))
    await flushAndTrack(path)

    const before = queueStateLineCount(path)
    restoreQueue([cmd('restored')])
    await flushAndTrack(path)
    expect(queueStateLineCount(path)).toBe(before)

    // The on-disk snapshot still reflects the pre-restore state.
    const persisted = await getPersistedQueueState(getSessionId())
    expect(persisted?.map(c => c.value)).toEqual(['already persisted'])
  })
})
