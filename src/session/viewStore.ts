/**
 * The client follows sessions across processes: exclude known-dead process
 * keys despite the polling lag, and call gateway `detach()` rather than
 * clearing React state, or reconnect strands the view on an empty dead
 * process.
 */
import type {
  AttachEventBody,
  WebPendingCommand,
  WebPermissionRequest,
  WebModelOption,
  WebSessionMeta,
  WebTaskSummary,
  WebTodo,
} from '../webui/protocol/attachSchemas.js'
import type { WebTranscriptItem } from '../webui/protocol/transcriptWire.js'

export type SessionView = {
  meta: WebSessionMeta | null
  items: Map<string, WebTranscriptItem>
  order: string[]
  permissions: WebPermissionRequest[]
  todos: WebTodo[]
  pendingCommands: WebPendingCommand[]
  models: WebModelOption[]
  commands: string[]
  /** Background tasks (subagents, shells, monitors). Newest first. */
  tasks: WebTaskSummary[]
  lastSeq: number
}

export function emptyView(): SessionView {
  return {
    meta: null,
    items: new Map(),
    order: [],
    permissions: [],
    todos: [],
    pendingCommands: [],
    models: [],
    commands: [],
    tasks: [],
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
      next.pendingCommands = event.pendingCommands ?? []
      next.models = event.models
      next.commands = event.commands ?? []
      next.tasks = event.tasks ?? []
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
      else if (patch.orderAppend) {
        // A well-formed append only ever carries ids the order does not have
        // yet. Skip the rest rather than trust it: a duplicated id in the
        // order renders the same row twice and React keys collide on it.
        const known = new Set(view.order)
        next.order = [
          ...view.order,
          ...patch.orderAppend.filter(id => !known.has(id)),
        ]
      }
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

    case 'pending_commands':
      next.pendingCommands = event.commands
      return next

    case 'tasks':
      next.tasks = event.tasks
      return next

    case 'task_transcript':
      // Task patches belong to the per-task viewer store, which the shell
      // feeds directly. Here they only advance the sequence watermark.
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
