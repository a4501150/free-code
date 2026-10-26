import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SessionListEntry } from '../../../sessiond/sessionList.js'
import {
  DEFAULT_TASK_OUTPUT_TAIL_BYTES,
  type WebPermissionDecision,
  type WebPermissionRequest,
  type WebTaskOutput,
  type WebTaskTranscript,
} from '../../protocol/attachSchemas.js'
import { useGateway } from '../hooks/useGateway.js'
import { useSessions } from '../hooks/useSessions.js'
import { createViewStore, useViewStore } from '../store.js'
import { Composer } from './Composer.js'
import { InstrumentSheet } from './InstrumentSheet.js'
import { Instruments } from './Instruments.js'
import { PermissionTray } from './PermissionTray.js'
import { approvalInput, PlanTray } from './PlanTray.js'
import { QuestionTray } from './QuestionTray.js'
import { MenuDrawer } from './MenuDrawer.js'
import { TopBar } from './TopBar.js'
import { TaskOutputView, type ShellOutputState } from './TaskOutputView.js'
import { Transcript } from './Transcript.js'

/**
 * What to do when the browser holds a session ID but no live process for it.
 *
 * `wait` matters as much as the other two: after a holder ends there is a gap in
 * which the poll reports no row at all, and treating that as `give-up` would
 * drop the session a moment before its replacement appears.
 */
export type FollowChoice =
  | { kind: 'attach'; processKey: string; sessionId: string }
  | { kind: 'give-up' }
  | { kind: 'wait' }

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

export function redirectAfterRestart(
  info: { publicUrl: string | null; localUrl: string | null },
  loc: { hostname: string; origin: string; replace(url: string): void },
): void {
  const target = LOOPBACK_HOSTS.has(loc.hostname)
    ? info.localUrl
    : info.publicUrl
  if (!target) return
  if (new URL(target).origin === loc.origin) return
  loc.replace(target)
}

/**
 * Picks the process that serves `sessionId` now.
 *
 * `goneKeys` is not optional bookkeeping. The session list is a poll behind, so
 * it still advertises a process that has already ended, and attaching to that
 * key answers `attach_failed` and delivers no snapshot.
 */
export function chooseFollowTarget(
  entries: readonly SessionListEntry[],
  sessionId: string,
  goneKeys: ReadonlySet<string>,
): FollowChoice {
  const rows = entries.filter(
    entry =>
      entry.sessionId === sessionId &&
      !(entry.processKey && goneKeys.has(entry.processKey)),
  )
  const next = rows.find(entry => entry.live && entry.processKey)
  if (next?.processKey) {
    return {
      kind: 'attach',
      processKey: next.processKey,
      sessionId: next.sessionId,
    }
  }
  return rows.some(entry => !entry.live)
    ? { kind: 'give-up' }
    : { kind: 'wait' }
}

/**
 * The session the browser was last looking at, kept across a refresh so the
 * page lands back where the user left it. Only the session id is remembered:
 * a process key goes stale the moment that process ends, while the follow
 * machinery below can find whoever serves the session now.
 */
const ACTIVE_SESSION_KEY = 'webui.activeSessionId'

function readActiveSessionId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_SESSION_KEY)
  } catch {
    return null
  }
}

function writeActiveSessionId(sessionId: string | null): void {
  try {
    if (sessionId) localStorage.setItem(ACTIVE_SESSION_KEY, sessionId)
    else localStorage.removeItem(ACTIVE_SESSION_KEY)
  } catch {
    // A browser with storage disabled simply loses the memory.
  }
}

export function Shell({ csrf }: { csrf: string }): React.ReactElement {
  const [activeKey, setActiveKey] = useState<string | null>(null)
  // Read once, before any poll can move the list under it, so the mount and
  // every later render start from the same memory.
  const [rememberedSessionId] = useState(() => readActiveSessionId())
  // Held beside the process key, because the browser follows the session and a
  // session outlives the process that happens to serve it. Seeding it with the
  // remembered id puts the follow effect to work on the first render.
  const [activeSessionId, setActiveSessionId] = useState<string | null>(
    rememberedSessionId,
  )
  // True while the only claim on the selection is the remembered id. The
  // assistant auto-select stands down until it either materialises or gives
  // up, and the follow effect stops waiting once a loaded list rules it out.
  const resumePending = useRef(rememberedSessionId !== null)
  const [railOpen, setRailOpen] = useState(false)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [followSignal, setFollowSignal] = useState(0)
  const [restartInfo, setRestartInfo] = useState<{
    publicUrl: string | null
    localUrl: string | null
  } | null>(null)

  const store = useMemo(() => createViewStore(), [])
  const view = useViewStore(store)

  // Subagent transcripts are watched through the same socket but land in their
  // own store, so the main transcript keeps accumulating underneath a viewer.
  const viewerStore = useMemo(() => createViewStore(), [])
  const viewerView = useViewStore(viewerStore)
  const [viewedTaskId, setViewedTaskId] = useState<string | null>(null)
  const viewedTaskIdRef = useRef<string | null>(null)
  viewedTaskIdRef.current = viewedTaskId
  // Which viewer is open: an agent's transcript or a shell/monitor's output.
  const [viewedTaskKind, setViewedTaskKind] = useState<
    'agent' | 'output' | null
  >(null)
  const [shellView, setShellView] = useState<ShellOutputState | null>(null)
  // The task list as of the last render, so `openTask` can classify the task
  // without re-subscribing to the store on every callback rebuild.
  const tasksRef = useRef<{ id: string; taskType: string }[]>([])
  tasksRef.current = view.tasks
  // Highest event seq seen, so a seeded viewer compares against the same
  // watermark as the store it mirrors.
  const seqRef = useRef(0)

  // Process keys that are known dead. The session list is a poll behind, so
  // without this the follow below re-attaches to the very process that just
  // ended and lands on an `attach_failed` with no snapshot to show for it.
  const goneKeys = useRef(new Set<string>())

  // Declared before the socket, because the process-gone handler refreshes the
  // list to find whoever serves the session now.
  const sessions = useSessions(csrf)

  const gateway = useGateway({
    csrf,
    onEvent: (seq, event) => {
      seqRef.current = seq
      // A task's transcript patch goes only to the viewer watching it; the
      // main store would otherwise mix a subagent into the main stream.
      if (event.kind === 'task_transcript') {
        if (event.taskId === viewedTaskIdRef.current) {
          viewerStore.apply(seq, { kind: 'transcript', patch: event.patch })
        }
        return
      }
      if (event.kind === 'task_output') {
        // Output appends go to the shell viewer's own state; the main store
        // only needs the watermark, which `seqRef` already carries.
        if (event.taskId === viewedTaskIdRef.current) {
          setShellView(prev =>
            prev
              ? {
                  text: prev.text + event.append,
                  done: prev.done || event.done,
                  gone: prev.gone,
                  loading: false,
                }
              : prev,
          )
        }
        return
      }
      store.apply(seq, event)
    },
    onProcessGone: info => {
      goneKeys.current.add(info.processKey)
      // A close for a process the user already left must not disturb the one
      // they are watching now.
      if (info.processKey !== activeKey) return
      gateway.detach()
      setActiveKey(null)
      setActiveSessionId(info.sessionId)
      store.reset()
      setViewedTaskId(null)
      viewerStore.reset()
      void sessions.refresh()
    },
    onAttachFailed: () => {
      // No snapshot is coming, so leaving the key set would strand the view on
      // an empty transcript with a composer that cannot send.
      if (!activeKey) return
      goneKeys.current.add(activeKey)
      gateway.detach()
      setActiveKey(null)
      store.reset()
      setViewedTaskId(null)
      viewerStore.reset()
      void sessions.refresh()
    },
    onRestartReady: info => {
      setRestartInfo(info)
      redirectAfterRestart(info, window.location)
    },
  })

  /**
   * Open a task in the main pane. Agents seed a transcript snapshot; shells
   * and monitors seed the tail of their output file. Either way the seed is
   * a request answered before the `subscribe_task` goes out, so no delta can
   * arrive against an unseeded view, and the subscribe carries the seed's
   * end offset so live appends continue exactly where the seed left off.
   */
  const openTask = useCallback(
    async (taskId: string) => {
      if (viewedTaskIdRef.current === taskId) return
      if (viewedTaskIdRef.current) {
        gateway.send({
          kind: 'unsubscribe_task',
          taskId: viewedTaskIdRef.current,
        })
      }
      viewerStore.reset()
      const summary = tasksRef.current.find(task => task.id === taskId)
      const kind: 'agent' | 'output' =
        summary?.taskType === 'local_bash' ||
        summary?.taskType === 'monitor_mcp'
          ? 'output'
          : 'agent'
      setViewedTaskId(taskId)
      setViewedTaskKind(kind)
      if (kind === 'output') {
        setShellView({ text: '', done: false, gone: false, loading: true })
        const answer = await gateway.request({
          kind: 'get_task_output',
          taskId,
          tailBytes: DEFAULT_TASK_OUTPUT_TAIL_BYTES,
        })
        // The user may have left (or switched) while the read was in flight.
        if (viewedTaskIdRef.current !== taskId) return
        if (answer.ok) {
          const seed = answer.result as WebTaskOutput
          setShellView({
            text: seed.content,
            done: seed.done,
            gone: false,
            loading: false,
          })
          // A terminal task's file is complete: no stream to open. Resume
          // from the end of the seed, so appends carry only new bytes.
          if (!seed.done)
            gateway.send({
              kind: 'subscribe_task',
              taskId,
              fromOffset: seed.bytesTotal,
            })
        } else {
          // Gone from the session between list and read — say so plainly.
          setShellView({ text: '', done: true, gone: true, loading: false })
        }
        return
      }
      setShellView(null)
      const answer = await gateway.request({
        kind: 'get_task_transcript',
        taskId,
      })
      // The user may have left (or switched) while the read was in flight.
      if (viewedTaskIdRef.current !== taskId) return
      if (answer.ok) {
        const { items } = answer.result as WebTaskTranscript
        viewerStore.apply(seqRef.current, {
          kind: 'transcript',
          patch: {
            type: 'replace',
            snapshot: { items, order: items.map(item => item.id) },
          },
        })
      }
      gateway.send({ kind: 'subscribe_task', taskId })
    },
    [gateway, viewerStore],
  )

  const closeTask = useCallback(() => {
    const taskId = viewedTaskIdRef.current
    if (taskId) gateway.send({ kind: 'unsubscribe_task', taskId })
    setViewedTaskId(null)
    setViewedTaskKind(null)
    setShellView(null)
    viewerStore.reset()
  }, [gateway, viewerStore])

  // The gateway's assistant chat is the main chat: open it on first load,
  // before the user has picked anything. The ref makes it a one-shot — after
  // the user navigates anywhere, later polls must not steal the view back. A
  // remembered session outranks it, so the ref starts armed when there is one;
  // it is also declared early because clearing a gone session may re-arm it.
  const autoSelected = useRef(rememberedSessionId !== null)

  const attachTo = useCallback(
    (processKey: string, sessionId: string) => {
      store.reset()
      closeTask()
      setActiveKey(processKey)
      setActiveSessionId(sessionId)
      // Whatever produced the key — a click, a create, a resumed selection —
      // this is now the session the browser is looking at.
      writeActiveSessionId(sessionId)
      resumePending.current = false
      gateway.attach(processKey)
    },
    [gateway, store, closeTask],
  )

  /**
   * Drop the selection and forget it, so a refresh does not retry a session
   * that has gone. If the thing being dropped was the remembered one, the
   * assistant auto-select is unblocked and gets the view as if no memory had
   * existed.
   */
  const clearActiveSession = useCallback(() => {
    writeActiveSessionId(null)
    if (resumePending.current) {
      resumePending.current = false
      autoSelected.current = false
    }
    setActiveSessionId(null)
  }, [])

  /** Attaching is always the same steps, whatever produced the key. */
  const adopt = useCallback(
    (processKey: string, sessionId: string) => {
      attachTo(processKey, sessionId)
      setRailOpen(false)
    },
    [attachTo],
  )

  const select = useCallback(
    (entry: SessionListEntry) => {
      if (!entry.processKey) return
      adopt(entry.processKey, entry.sessionId)
      autoSelected.current = true
    },
    [adopt],
  )

  useEffect(() => {
    if (autoSelected.current) return
    if (activeKey !== null || activeSessionId !== null) return
    const assistant = sessions.entries.find(
      entry =>
        entry.role === 'assistant' &&
        entry.live &&
        entry.attachable &&
        entry.processKey,
    )
    if (!assistant?.processKey) return
    autoSelected.current = true
    adopt(assistant.processKey, assistant.sessionId)
  }, [sessions.entries, activeKey, activeSessionId, adopt])

  const create = useCallback(
    async (cwd: string): Promise<string | null> => {
      const result = await sessions.create(cwd)
      if (!result.ok) return result.error
      // Attach straight away: the user asked for a session, not a list entry.
      adopt(result.processKey, result.sessionId)
      return null
    },
    [adopt, sessions],
  )

  const resume = useCallback(
    async (sessionId: string): Promise<string | null> => {
      const result = await sessions.resume(sessionId)
      if (!result.ok) return result.error
      adopt(result.processKey, result.sessionId)
      return null
    },
    [adopt, sessions],
  )

  const stop = useCallback(
    async (pid: number): Promise<string | null> => {
      const result = await sessions.stop(pid)
      return result.ok ? null : result.error
    },
    [sessions],
  )

  // The session is known but no process serves it yet, which is what a takeover
  // or a restart looks like from here. Attach to whoever picks it up.
  const following = activeSessionId !== null && activeKey === null
  useEffect(() => {
    if (!following || activeSessionId === null) return
    const choice = chooseFollowTarget(
      sessions.entries,
      activeSessionId,
      goneKeys.current,
    )
    if (choice.kind === 'attach') attachTo(choice.processKey, choice.sessionId)
    else if (choice.kind === 'give-up') clearActiveSession()
    else if (resumePending.current && sessions.entries.length > 0) {
      // Woken from memory, but a loaded list has no row for it at all: the
      // session is gone, not merely between processes. Stop waiting and hand
      // the view to the assistant auto-select.
      clearActiveSession()
    }
  }, [
    following,
    sessions.entries,
    activeSessionId,
    attachTo,
    clearActiveSession,
  ])

  // Escape closes the drawer, which is the only way out on a phone that has no
  // keyboard showing and no room for a backdrop tap.
  useEffect(() => {
    if (!railOpen) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setRailOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [railOpen])

  // Escape also steps out of a subagent transcript, back to the session.
  useEffect(() => {
    if (!viewedTaskId) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') closeTask()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [viewedTaskId, closeTask])

  // Paths the session has touched, which is what @ mentions can offer without
  // giving the browser filesystem access.
  const knownPaths = useMemo(() => {
    const paths = new Set<string>()
    for (const item of view.items.values()) {
      const input = item.toolInput as { file_path?: unknown; path?: unknown }
      const value = input?.file_path ?? input?.path
      if (typeof value === 'string') paths.add(value)
    }
    return [...paths]
  }, [view.items])

  // Image bytes never ride the transcript, so a reader who wants to see one
  // asks the session for it.
  const fetchImage = useCallback(
    async (itemId: string) => {
      const answer = await gateway.request({ kind: 'get_image', itemId })
      if (!answer.ok) {
        throw new Error(answer.error?.message ?? 'the session refused')
      }
      return answer.result as { mediaType: string; data: string }
    },
    [gateway],
  )

  const meta = view.meta
  const viewedTask = viewedTaskId
    ? view.tasks.find(task => task.id === viewedTaskId)
    : undefined
  const viewedTaskLabel = viewedTask
    ? viewedTask.name
      ? `${viewedTask.name} — ${viewedTask.description}`
      : viewedTask.description
    : (viewedTaskId ?? '')
  const busy = meta?.state === 'running'
  const pending = view.permissions[0]
  // The gateway names its host's home for exactly this: the browser cannot
  // browse the filesystem, and home is where a new session should start. The
  // old fallbacks remain for a gateway that does not report it.
  const defaultCwd =
    sessions.home ||
    (meta?.cwd ?? sessions.entries.find(s => s.live && s.cwd)?.cwd ?? '')

  // An attached process can switch session on its own, through `/resume` or
  // `/clear`. Follow the session it serves now, not the one that was clicked.
  const metaSessionId = meta?.sessionId
  useEffect(() => {
    if (!metaSessionId) return
    setActiveSessionId(metaSessionId)
    // The memory tracks the session actually being served, not the one that
    // was clicked, so a `/clear` followed by a refresh lands on the new id.
    writeActiveSessionId(metaSessionId)
  }, [metaSessionId])

  // A permission request is the one thing that must not be missed on a phone,
  // and the sheet sits between it and the composer.
  const hasPending = Boolean(pending)
  useEffect(() => {
    if (hasPending) setSheetOpen(false)
  }, [hasPending])

  function decide(requestId: string, decision: WebPermissionDecision): void {
    gateway.send({ kind: 'permission_decision', requestId, decision })
  }

  /**
   * Two tools cannot be answered yes or no. Both always ask, and the terminal
   * answers them by allowing with an enriched input, so each needs a surface
   * that can produce that input.
   */
  function renderTray(request: WebPermissionRequest): React.ReactElement {
    const queued = view.permissions.length

    if (request.toolName === 'AskUserQuestion') {
      return (
        <QuestionTray
          request={request}
          queued={queued}
          onAnswer={updatedInput =>
            decide(request.requestId, { behavior: 'allow', updatedInput })
          }
          onCancel={() =>
            decide(request.requestId, {
              behavior: 'deny',
              message: 'User declined to answer questions',
            })
          }
        />
      )
    }

    if (request.toolName === 'ExitPlanMode') {
      return (
        <PlanTray
          request={request}
          queued={queued}
          onApprove={mode => {
            // Ordered, not raced: one socket delivers these in sequence, so
            // the mode is in place before the tool runs. An allow cannot
            // carry a permission update, which is how the terminal does it.
            gateway.send({ kind: 'set_permission_mode', mode })
            decide(request.requestId, {
              behavior: 'allow',
              updatedInput: approvalInput(request.input),
            })
          }}
          onKeepPlanning={feedback =>
            decide(request.requestId, {
              behavior: 'deny',
              message: feedback || 'Keep planning',
            })
          }
        />
      )
    }

    return (
      <PermissionTray
        request={request}
        queued={queued}
        onAllow={persist =>
          decide(request.requestId, { behavior: 'allow', persist })
        }
        onDeny={message =>
          decide(request.requestId, {
            behavior: 'deny',
            message: message || undefined,
          })
        }
      />
    )
  }

  return (
    <div className={`shell ${railOpen ? 'is-rail-open' : ''}`}>
      <TopBar
        meta={meta}
        connected={gateway.connected}
        railOpen={railOpen}
        onToggleRail={() => setRailOpen(open => !open)}
      />

      <MenuDrawer
        sessions={sessions.entries}
        activeKey={activeKey}
        activeState={meta?.state}
        defaultCwd={defaultCwd}
        csrf={csrf}
        restartInfo={restartInfo}
        onSelect={select}
        onCreate={create}
        onResume={resume}
        onStop={stop}
        onClose={() => setRailOpen(false)}
      />

      {/* Only rendered when open, so it can never swallow a tap on the desktop
          layout where the rail is pinned. */}
      {railOpen ? (
        <button
          type="button"
          className="scrim"
          aria-label="Close menu"
          tabIndex={-1}
          onClick={() => setRailOpen(false)}
        />
      ) : null}

      <main className="main">
        {activeKey && viewedTaskId ? (
          <div className="viewer__banner">
            <button type="button" className="viewer__back" onClick={closeTask}>
              ← session
            </button>
            <span className="viewer__label">
              {viewedTaskKind === 'output' ? 'task' : 'subagent'}:{' '}
              {viewedTaskLabel}
            </span>
          </div>
        ) : null}
        {activeKey ? (
          viewedTaskId ? (
            viewedTaskKind === 'output' ? (
              <TaskOutputView
                taskId={viewedTaskId}
                task={viewedTask}
                state={
                  shellView ?? {
                    text: '',
                    done: false,
                    gone: false,
                    loading: false,
                  }
                }
                onKillTask={taskId =>
                  gateway.send({ kind: 'kill_task', taskId })
                }
              />
            ) : (
              <Transcript
                items={viewerView.items}
                order={viewerView.order}
                pendingCommands={[]}
                followSignal={followSignal}
                onFetchImage={fetchImage}
                tasks={view.tasks}
                onOpenTask={taskId => void openTask(taskId)}
              />
            )
          ) : (
            <Transcript
              items={view.items}
              order={view.order}
              pendingCommands={view.pendingCommands}
              inProgressToolUseIds={view.meta?.inProgressToolUseIds}
              activity={view.meta?.activity}
              followSignal={followSignal}
              onFetchImage={fetchImage}
              tasks={view.tasks}
              onOpenTask={taskId => void openTask(taskId)}
            />
          )
        ) : (
          <div className="transcript transcript--empty">
            {following
              ? 'Reconnecting to the session…'
              : 'Pick a session to attach.'}
          </div>
        )}

        {pending ? renderTray(pending) : null}

        {/* Only while attached: with no session behind it the sheet is a
            handle over an empty panel. Before the composer in the DOM as well
            as above it on screen, so the tab order matches what the eye sees.
            Inside `main`, so nothing has to track the composer's changing
            height. */}
        {activeKey ? (
          <InstrumentSheet
            meta={meta}
            todos={view.todos}
            open={sheetOpen}
            onToggle={setSheetOpen}
          >
            <Instruments
              meta={meta}
              todos={view.todos}
              tasks={view.tasks}
              models={view.models}
              viewedTaskId={viewedTaskId ?? undefined}
              onSetMode={mode =>
                gateway.send({ kind: 'set_permission_mode', mode })
              }
              onSetModel={model => gateway.send({ kind: 'set_model', model })}
              onViewTask={taskId => void openTask(taskId)}
              onKillTask={taskId => gateway.send({ kind: 'kill_task', taskId })}
            />
          </InstrumentSheet>
        ) : null}

        {activeKey ? (
          <Composer
            busy={busy}
            knownPaths={knownPaths}
            commands={view.commands}
            onSubmit={(text, delivery, images) => {
              gateway.send({
                kind: 'submit',
                commandId: crypto.randomUUID(),
                content: text,
                ...(images.length ? { images } : {}),
                delivery,
                sessionEpoch: meta?.sessionEpoch ?? 0,
              })
              setFollowSignal(n => n + 1)
            }}
            onInterrupt={() => gateway.send({ kind: 'interrupt' })}
          />
        ) : null}
      </main>
    </div>
  )
}
