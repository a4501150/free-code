import type { UUID } from 'crypto'
import type { QueuedCommand } from './textInputTypes.js'

/**
 * Queue-operation records persisted to the session log so replays can
 * reconstruct what happened to the user's message queue. Shape derived
 * from logOperation / recordQueueOperation in src/utils/messageQueueManager.ts
 * and src/utils/sessionStorage.ts.
 */

export type QueueOperation =
  | 'enqueue'
  | 'dequeue'
  | 'remove'
  | 'popAll'
  | 'edit'

export type QueueOperationMessage = {
  type: 'queue-operation'
  operation: QueueOperation
  timestamp: string
  sessionId: string
  /** Optional raw text of the command the operation affected. */
  content?: string
}

/**
 * Latest-wins snapshot of the user-typed commands still in the queue,
 * rewritten on every queue mutation. Read on resume to restore the queue
 * (queue-operation records are lossy — dequeue/remove carry no ID — so
 * they can't reconstruct state; this snapshot can).
 */
export type QueueStateMessage = {
  type: 'queue-state'
  timestamp: string
  sessionId: UUID
  /** User-typed commands ('prompt'/'bash') in FIFO order. May be empty —
   * an empty snapshot overwrites older state on the latest-wins read. */
  commands: QueuedCommand[]
}
