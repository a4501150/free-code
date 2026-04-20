/**
 * Queue-operation records persisted to the session log so replays can
 * reconstruct what happened to the user's message queue. Shape derived
 * from logOperation / recordQueueOperation in src/utils/messageQueueManager.ts
 * and src/utils/sessionStorage.ts.
 */

export type QueueOperation = 'enqueue' | 'dequeue' | 'remove' | 'popAll'

export type QueueOperationMessage = {
  type: 'queue-operation'
  operation: QueueOperation
  timestamp: string
  sessionId: string
  /** Optional raw text of the command the operation affected. */
  content?: string
}
