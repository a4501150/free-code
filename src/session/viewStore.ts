/**
 * The session view: wire events in, renderable session state out.
 *
 * Framework-free on purpose — this is the projection BOTH clients share. The
 * web client wraps it in `useSyncExternalStore` (see `webui/client/store.ts`);
 * the TUI attaches through the same reducer. Keep it free of React, DOM and
 * terminal imports.
 *
 * The client follows sessions across processes: exclude known-dead process
 * keys despite the polling lag, and close the event stream rather than just
 * clearing state, or reconnect strands the view on an empty dead process.
 */
import type {
  WireCatalog,
  WireEvent,
  WireItem,
  WireNotification,
  WirePendingCommand,
  WireRequest,
  WireSessionMeta,
  WireStreamDraft,
  WireTask,
  WireTodo,
} from './wire.js'

export type SessionView = {
  meta: WireSessionMeta | null
  items: Map<string, WireItem>
  order: string[]
  requests: WireRequest[]
  todos: WireTodo[]
  queue: WirePendingCommand[]
  tasks: WireTask[]
  catalog: WireCatalog
  /**
   * In-flight preview for the running turn. Transient by contract: the text
   * preview is cleared by any `transcript` patch (those rows have landed);
   * a tool card retires when its `toolUseId` commits; everything goes on
   * `stream` null, `snapshot`/`session_changed`/`resync_required`.
   */
  streamDraft: WireStreamDraft | null
  /** Last notify per level — a toast rail, not a queue. */
  notifications: Partial<Record<WireNotification['level'], WireNotification>>
  lastSeq: number
}

/** A permission request, which is the kind the trays render. */
export type PermissionEntry = Extract<WireRequest, { kind: 'permission' }>

const EMPTY_CATALOG: WireCatalog = {
  models: [],
  commands: [],
  permissionModes: [],
}

export function emptyView(): SessionView {
  return {
    meta: null,
    items: new Map(),
    order: [],
    requests: [],
    todos: [],
    queue: [],
    tasks: [],
    catalog: EMPTY_CATALOG,
    streamDraft: null,
    notifications: {},
    lastSeq: 0,
  }
}

/**
 * Applies one wire event.
 *
 * Every operation is idempotent by sequence, item id and revision, so a replay
 * after a reconnect cannot duplicate or reorder anything. Unknown kinds are
 * ignored: the wire only adds members, and a client built against an older
 * union must still follow the stream.
 */
export function applyEvent(
  view: SessionView,
  seq: number,
  event: WireEvent,
): SessionView {
  if (seq <= view.lastSeq && event.kind !== 'snapshot') return view
  const next: SessionView = { ...view, lastSeq: Math.max(view.lastSeq, seq) }

  switch (event.kind) {
    case 'snapshot': {
      next.meta = event.meta
      next.items = new Map(event.transcript.items.map(item => [item.id, item]))
      next.order = [...event.transcript.order]
      next.requests = event.requests
      next.todos = event.todos
      next.queue = event.pendingCommands
      next.tasks = event.tasks
      next.catalog = event.catalog
      next.streamDraft = null
      next.lastSeq = seq
      return next
    }

    case 'transcript': {
      // The committed text rows land; that preview is over. Tool partials
      // SURVIVE the patch: the draft lists every block the turn has
      // streamed, and a patch commits only some of them — dropping the
      // whole draft here would unmount cards for blocks still streaming,
      // a bottom-edge shrink that clamps a pinned-to-bottom transcript up
      // and repaints the entire viewport (classic replaces only the
      // streaming row that committed). A card retires when its
      // `toolUseId` appears as a committed item (see transcriptBridge).
      next.streamDraft = view.streamDraft
        ? { ...view.streamDraft, text: undefined, thinking: undefined }
        : null
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

    case 'stream':
      next.streamDraft = event.draft
      return next

    case 'notify':
      next.notifications = {
        ...view.notifications,
        [event.notification.level]: event.notification,
      }
      return next

    case 'request_opened':
      next.requests = [
        ...view.requests.filter(r => r.requestId !== event.request.requestId),
        event.request,
      ]
      return next

    case 'request_closed':
      next.requests = view.requests.filter(r => r.requestId !== event.requestId)
      return next

    case 'todos':
      next.todos = event.todos
      return next

    case 'queue':
      next.queue = event.commands
      return next

    case 'tasks':
      next.tasks = event.tasks
      return next

    case 'catalog':
      next.catalog = event.catalog
      return next

    case 'session_changed':
      // The process moved to another session. Everything below is stale; the
      // re-subscribe that follows delivers a fresh snapshot.
      next.items = new Map()
      next.order = []
      next.requests = []
      next.streamDraft = null
      if (next.meta) {
        next.meta = {
          ...next.meta,
          sessionId: event.sessionId,
          sessionEpoch: event.sessionEpoch,
        }
      }
      return next

    case 'resync_required':
      // The journal expired. The snapshot that follows refills the
      // transcript, and the preview dies with the stream that held it.
      next.streamDraft = null
      return next
  }

  // An unknown kind is a newer server adding a member: keep the view and just
  // advance the sequence.
  return next
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
    apply(seq: number, event: WireEvent): void {
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
