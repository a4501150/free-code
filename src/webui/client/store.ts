import { useCallback, useRef, useSyncExternalStore } from 'react'
import type {
  AttachEventBody,
  WebPermissionRequest,
  WebModelOption,
  WebSessionMeta,
  WebTodo,
} from '../protocol/attachSchemas.js'
import type { WebTranscriptItem } from '../protocol/transcriptWire.js'

export type SessionView = {
  meta: WebSessionMeta | null
  items: Map<string, WebTranscriptItem>
  order: string[]
  permissions: WebPermissionRequest[]
  todos: WebTodo[]
  models: WebModelOption[]
  lastSeq: number
}

export function emptyView(): SessionView {
  return {
    meta: null,
    items: new Map(),
    order: [],
    permissions: [],
    todos: [],
    models: [],
    lastSeq: 0,
  }
}

/**
 * Applies one attach event.
 *
 * Every operation is idempotent by sequence, item id and revision, so a replay
 * after a reconnect cannot duplicate or reorder anything.
 */
export function applyEvent(
  view: SessionView,
  seq: number,
  event: AttachEventBody,
): SessionView {
  if (seq <= view.lastSeq && event.kind !== 'snapshot') return view
  const next: SessionView = { ...view, lastSeq: Math.max(view.lastSeq, seq) }

  switch (event.kind) {
    case 'snapshot': {
      next.meta = event.meta
      next.items = new Map(event.transcript.items.map(item => [item.id, item]))
      next.order = [...event.transcript.order]
      next.permissions = event.permissions
      next.todos = event.todos
      next.models = event.models
      next.lastSeq = seq
      return next
    }

    case 'transcript': {
      const patch = event.patch
      if (patch.type === 'replace') {
        next.items = new Map(patch.snapshot.items.map(i => [i.id, i]))
        next.order = [...patch.snapshot.order]
        return next
      }
      const items = new Map(view.items)
      for (const id of patch.remove) items.delete(id)
      for (const item of patch.upsert) items.set(item.id, item)
      next.items = items
      if (patch.order) next.order = [...patch.order]
      else if (patch.orderAppend)
        next.order = [...view.order, ...patch.orderAppend]
      return next
    }

    case 'meta':
      next.meta = event.meta
      return next

    case 'permission_opened':
      next.permissions = [
        ...view.permissions.filter(
          p => p.requestId !== event.request.requestId,
        ),
        event.request,
      ]
      return next

    case 'permission_closed':
      next.permissions = view.permissions.filter(
        p => p.requestId !== event.requestId,
      )
      return next

    case 'todos':
      next.todos = event.todos
      return next

    case 'session_changed':
      // The process moved to another session. Everything below is stale; the
      // re-subscribe that follows delivers a fresh snapshot.
      next.items = new Map()
      next.order = []
      next.permissions = []
      if (next.meta) {
        next.meta = {
          ...next.meta,
          sessionId: event.sessionId,
          sessionEpoch: event.sessionEpoch,
        }
      }
      return next

    case 'resync_required':
      return next
  }
}

/** A tiny external store, so transcript churn does not re-render the shell. */
export function createViewStore() {
  let view = emptyView()
  const listeners = new Set<() => void>()

  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    snapshot(): SessionView {
      return view
    },
    apply(seq: number, event: AttachEventBody): void {
      const next = applyEvent(view, seq, event)
      if (next === view) return
      view = next
      for (const listener of listeners) listener()
    },
    reset(): void {
      view = emptyView()
      for (const listener of listeners) listener()
    },
  }
}

export type ViewStore = ReturnType<typeof createViewStore>

export function useViewStore(store: ViewStore): SessionView {
  return useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot)
}

/** Stable identity for callbacks that close over changing values. */
export function useEvent<T extends (...args: never[]) => unknown>(fn: T): T {
  const ref = useRef(fn)
  ref.current = fn
  return useCallback(((...args: never[]) => ref.current(...args)) as T, [])
}
