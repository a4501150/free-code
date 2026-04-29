// Shared subscribe-keyed-by-taskId poller for live task-output tails.
//
// Used by BackgroundTaskOutput's in-progress UI (TaskOutputTool) so multiple
// rows watching the same (or different) task don't each spin up their own
// 1Hz file-read interval. Module-level state — a single timer fans out to
// every active subscriber. When the last listener for a task unsubscribes,
// that task's entry is dropped; when no tasks remain, the timer is cleared.

import { logError } from '../log.js'
import { getTaskOutput } from './diskOutput.js'

type Listener = (content: string) => void

const POLL_INTERVAL_MS = 1000
const DEFAULT_MAX_BYTES = 1_048_576

type Entry = {
  listeners: Set<Listener>
  maxBytes: number
  lastContent: string
}

const subscribers = new Map<string, Entry>()
let timerId: ReturnType<typeof setInterval> | null = null

function ensureTimer(): void {
  if (timerId !== null) return
  timerId = setInterval(tick, POLL_INTERVAL_MS)
  // Don't keep the event loop alive solely for a UI poller.
  if (typeof timerId === 'object' && timerId !== null && 'unref' in timerId) {
    ;(timerId as unknown as { unref: () => void }).unref()
  }
}

function maybeStopTimer(): void {
  if (timerId === null) return
  if (subscribers.size > 0) return
  clearInterval(timerId)
  timerId = null
}

function tick(): void {
  // Snapshot keys to avoid re-entrancy issues if a listener triggers
  // (un)subscribe synchronously.
  const taskIds = Array.from(subscribers.keys())
  for (const taskId of taskIds) {
    const entry = subscribers.get(taskId)
    if (!entry || entry.listeners.size === 0) continue
    void getTaskOutput(taskId, entry.maxBytes).then(
      content => {
        const e = subscribers.get(taskId)
        if (!e) return
        if (e.lastContent === content) return
        e.lastContent = content
        for (const listener of e.listeners) {
          try {
            listener(content)
          } catch (err) {
            logError(err)
          }
        }
      },
      err => {
        logError(err)
      },
    )
  }
}

/**
 * Subscribe to live updates of `taskId`'s output tail. The listener is
 * invoked with the latest content on initial poll and again whenever the
 * polled content changes. Returns an unsubscribe function.
 */
export function subscribeTaskOutput(
  taskId: string,
  listener: Listener,
  maxBytes: number = DEFAULT_MAX_BYTES,
): () => void {
  let entry = subscribers.get(taskId)
  if (!entry) {
    entry = { listeners: new Set(), maxBytes, lastContent: '' }
    subscribers.set(taskId, entry)
  } else if (maxBytes > entry.maxBytes) {
    // Bump the byte cap to the largest requested by any subscriber so all
    // listeners see content covering their requested window.
    entry.maxBytes = maxBytes
  }
  entry.listeners.add(listener)
  ensureTimer()

  // Eager first read — don't make the caller wait up to a full poll
  // interval to render anything.
  void getTaskOutput(taskId, entry.maxBytes).then(
    content => {
      const e = subscribers.get(taskId)
      if (!e || !e.listeners.has(listener)) return
      e.lastContent = content
      try {
        listener(content)
      } catch (err) {
        logError(err)
      }
    },
    err => {
      logError(err)
    },
  )

  return () => {
    const e = subscribers.get(taskId)
    if (!e) return
    e.listeners.delete(listener)
    if (e.listeners.size === 0) {
      subscribers.delete(taskId)
    }
    maybeStopTimer()
  }
}
