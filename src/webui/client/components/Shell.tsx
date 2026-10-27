import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SessionListEntry } from '../../../sessiond/sessionList.js'
import type {
  WireCommand,
  WirePermissionDecision,
  WireRequest,
  WireRequestResponse,
} from '../../../session/wire.js'
import { fetchAgentTranscript, fetchTaskOutput } from '../api.js'
import { useGateway } from '../hooks/useGateway.js'
import { useSessions } from '../hooks/useSessions.js'
import { createViewStore, useViewStore } from '../store.js'
import { AgentPanel, type AgentPanelState } from './AgentPanel.js'
import { Composer } from './Composer.js'
import { InstrumentSheet } from './InstrumentSheet.js'
import { Instruments } from './Instruments.js'
import { PermissionTray } from './PermissionTray.js'
import { approvalInput, PlanTray } from './PlanTray.js'
import { QuestionTray } from './QuestionTray.js'
import { HookPromptTray } from './HookPromptTray.js'
import { ElicitationTray } from './ElicitationTray.js'
import { MenuDrawer } from './MenuDrawer.js'
import { TaskPanel } from './TaskPanel.js'
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
 * it still advertises a process that has already ended, and opening a stream on
 * that key answers non-ok and delivers no snapshot.
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

  // Process keys that are known dead. The session list is a poll behind, so
  // without this the follow below re-opens a stream on the very process that
  // just ended and lands on a refusal with no snapshot to show for it.
  const goneKeys = useRef(new Set<string>())

  // Declared before the gateway, because the offline handler refreshes the
  // list to find whoever serves the session now.
  const sessions = useSessions(csrf)

  const gateway = useGateway({
    csrf,
    onEvent: (seq, event) => store.apply(seq, event),
    onStreamOffline: processKey => {
      goneKeys.current.add(processKey)
      // A stream closing for a process the user already left must not disturb
      // the one they are watching now.
      if (processKey !== activeKey) return
      setActiveKey(null)
      store.reset()
      setAgent(null)
      closeOutput()
      void sessions.refresh()
    },
    onRestartReady: info => {
      setRestartInfo(info)
      redirectAfterRestart(info, window.location)
    },
  })

  // The sidechain drill-down: one agent transcript fetched on demand and
  // rendered over the main view. One panel at a time; switching sessions
  // closes it, because a sidechain belongs to the session it ran in.
  const [agent, setAgent] = useState<AgentPanelState | null>(null)
  const openAgent = useCallback(
    async (agentId: string) => {
      if (!activeKey) return
      setAgent({ agentId, state: 'loading' })
      const snapshot = await fetchAgentTranscript(activeKey, agentId)
      setAgent(current => {
        // A late answer for an agent the reader already closed (or swapped)
        // must not resurrect the panel.
        if (
          !current ||
          current.agentId !== agentId ||
          current.state !== 'loading'
        )
          return current
        return snapshot
          ? { agentId, state: 'ready', snapshot }
          : { agentId, state: 'failed', error: 'No transcript for that agent.' }
      })
    },
    [activeKey],
  )

  // The open panel follows a running agent: the sidechain JSONL grows as the
  // agent works, and a full re-read per tick replaces the snapshot whole, so
  // a poll can never duplicate or reorder rows. The clock stops when the
  // task owning the shown chain goes terminal — nothing more will arrive.
  useEffect(() => {
    if (!agent || !activeKey) return
    const task = view.tasks.find(
      candidate => candidate.agentId === agent.agentId,
    )
    const live =
      !!task &&
      task.status !== 'completed' &&
      task.status !== 'failed' &&
      task.status !== 'killed'
    if (!live) return
    const timer = setInterval(() => {
      void fetchAgentTranscript(activeKey, agent.agentId).then(snapshot => {
        if (!snapshot) return
        setAgent(current =>
          current && current.agentId === agent.agentId
            ? { agentId: agent.agentId, state: 'ready', snapshot }
            : current,
        )
      })
    }, 2000)
    return () => clearInterval(timer)
  }, [agent?.agentId, agent?.state, activeKey, view.tasks])

  // The output viewer for a shell or monitor: read the tail once, then poll
  // while the task runs. Each poll replaces the text whole — a tail is a
  // snapshot of the file's end, so a poll can neither duplicate nor reorder
  // lines — and the clock stops when the task goes terminal.
  const [viewedOutputId, setViewedOutputId] = useState<string | null>(null)
  const viewedOutputIdRef = useRef<string | null>(null)
  const [shellView, setShellView] = useState<ShellOutputState | null>(null)
  const closeOutput = useCallback(() => {
    viewedOutputIdRef.current = null
    setViewedOutputId(null)
    setShellView(null)
  }, [])
  const openOutput = useCallback(
    async (taskId: string) => {
      if (!activeKey) return
      setAgent(null)
      viewedOutputIdRef.current = taskId
      setViewedOutputId(taskId)
      setShellView({ text: '', done: false, gone: false, loading: true })
      const seed = await fetchTaskOutput(activeKey, taskId)
      // The reader may have left (or switched) while the read was in flight.
      if (viewedOutputIdRef.current !== taskId) return
      setShellView(
        seed
          ? { text: seed.content, done: seed.done, gone: false, loading: false }
          : // Gone from the session between list and read — say so plainly.
            { text: '', done: true, gone: true, loading: false },
      )
    },
    [activeKey],
  )
  useEffect(() => {
    if (!viewedOutputId || !activeKey) return
    const task = view.tasks.find(candidate => candidate.id === viewedOutputId)
    const live =
      !!task &&
      task.status !== 'completed' &&
      task.status !== 'failed' &&
      task.status !== 'killed'
    if (!live) return
    const timer = setInterval(() => {
      void fetchTaskOutput(activeKey, viewedOutputId).then(output => {
        if (!output || viewedOutputIdRef.current !== viewedOutputId) return
        setShellView({
          text: output.content,
          done: output.done,
          gone: false,
          loading: false,
        })
      })
    }, 1000)
    return () => clearInterval(timer)
  }, [viewedOutputId, activeKey, view.tasks])

  // Shells and monitors open their output; agents resolve through the agent
  // id: the card and the panel row both know the task, only the sidechain
  // knows the agent.
  const openTask = useCallback(
    (taskId: string) => {
      const task = view.tasks.find(candidate => candidate.id === taskId)
      if (!task) return
      if (task.kind === 'local_bash' || task.kind === 'monitor_mcp') {
        void openOutput(taskId)
        return
      }
      if (task.agentId) void openAgent(task.agentId)
    },
    [view.tasks, openAgent, openOutput],
  )

  const killTask = useCallback(
    (taskId: string) => {
      void gateway.command('kill_task', { kind: 'kill_task', taskId })
    },
    [gateway],
  )

  // The gateway's assistant chat is the main chat: open it on first load,
  // before the user has picked anything. The ref makes it a one-shot — after
  // the user navigates anywhere, later polls must not steal the view back. A
  // remembered session outranks it, so the ref starts armed when there is one;
  // it is also declared early because clearing a gone session may re-arm it.
  const autoSelected = useRef(rememberedSessionId !== null)

  const attachTo = useCallback(
    (processKey: string, sessionId: string) => {
      store.reset()
      setAgent(null)
      closeOutput()
      setActiveKey(processKey)
      setActiveSessionId(sessionId)
      // Whatever produced the key — a click, a create, a resumed selection —
      // this is now the session the browser is looking at.
      writeActiveSessionId(sessionId)
      resumePending.current = false
      gateway.attachSession(processKey)
    },
    [gateway, store],
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
    (itemId: string) => gateway.fetchImage(itemId),
    [gateway],
  )

  const meta = view.meta
  const busy = meta?.state === 'running'
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
  const hasPending = view.requests.length > 0
  useEffect(() => {
    if (hasPending) setSheetOpen(false)
  }, [hasPending])

  function decide(requestId: string, response: WireRequestResponse): void {
    void gateway.command('request_respond', {
      kind: 'request_respond',
      requestId,
      response,
    })
  }

  function permission(
    decision: WirePermissionDecision,
  ): Extract<WireRequestResponse, { kind: 'permission' }> {
    return { kind: 'permission', decision }
  }

  /** Lifecycle and queue rpcs; the bodies come from composerViews. */
  function sendRpc(body: unknown): void {
    void gateway.command('rpc', body as WireCommand)
  }

  /**
   * Two request shapes cannot be answered yes or no. Both always ask, and the
   * terminal answers them by allowing with enriched input, so each needs a
   * surface that can produce that input. The wire marks them with `ui`.
   */
  function renderTray(request: WireRequest): React.ReactElement {
    const queued = view.requests.length

    if (request.kind === 'hook_prompt') {
      return (
        <HookPromptTray
          key={request.requestId}
          request={request}
          queued={queued}
          onSelect={selected =>
            decide(request.requestId, { kind: 'hook_prompt', selected })
          }
        />
      )
    }

    if (request.kind === 'elicitation') {
      return (
        <ElicitationTray
          key={request.requestId}
          request={request}
          queued={queued}
          onRespond={response =>
            decide(request.requestId, { kind: 'elicitation', ...response })
          }
        />
      )
    }

    if (request.ui?.kind === 'question') {
      return (
        <QuestionTray
          key={request.requestId}
          request={request}
          questions={request.ui.questions}
          queued={queued}
          onAnswer={updatedInput =>
            decide(
              request.requestId,
              permission({ behavior: 'allow', updatedInput }),
            )
          }
          onCancel={() =>
            decide(
              request.requestId,
              permission({
                behavior: 'deny',
                message: 'User declined to answer questions',
              }),
            )
          }
        />
      )
    }

    if (request.ui?.kind === 'plan') {
      return (
        <PlanTray
          key={request.requestId}
          request={request}
          planContent={request.ui.planContent}
          queued={queued}
          onApprove={mode => {
            // One round trip: `setMode` is in place by the time the tool runs,
            // which is the ordering the terminal gets from sending the mode
            // before the allow.
            decide(
              request.requestId,
              permission({
                behavior: 'allow',
                updatedInput: approvalInput(request.input),
                setMode: mode,
              }),
            )
          }}
          onKeepPlanning={feedback =>
            decide(
              request.requestId,
              permission({
                behavior: 'deny',
                message: feedback || 'Keep planning',
              }),
            )
          }
        />
      )
    }

    return (
      <PermissionTray
        key={request.requestId}
        request={request}
        queued={queued}
        onAllow={controls => decide(request.requestId, permission(controls))}
        onDeny={message =>
          decide(
            request.requestId,
            permission({ behavior: 'deny', message: message || undefined }),
          )
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
        onRpc={sendRpc}
      />

      <MenuDrawer
        sessions={sessions.entries}
        activeKey={activeKey}
        activeState={meta?.state}
        defaultCwd={defaultCwd}
        csrf={csrf}
        restartInfo={restartInfo}
        search={sessions.query}
        onSearch={sessions.setQuery}
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
        {activeKey && viewedOutputId ? (
          <div className="viewer__banner">
            <button
              type="button"
              className="viewer__back"
              onClick={closeOutput}
            >
              ← session
            </button>
            <span className="viewer__label">
              task:{' '}
              {view.tasks.find(task => task.id === viewedOutputId)
                ?.description ?? viewedOutputId}
            </span>
          </div>
        ) : null}
        {activeKey ? (
          viewedOutputId ? (
            <TaskOutputView
              taskId={viewedOutputId}
              task={view.tasks.find(task => task.id === viewedOutputId)}
              state={
                shellView ?? {
                  text: '',
                  done: false,
                  gone: false,
                  loading: false,
                }
              }
              onKillTask={killTask}
            />
          ) : (
            <Transcript
              items={view.items}
              order={view.order}
              inProgressToolUseIds={view.meta?.inProgressToolUseIds}
              activity={view.meta?.activity}
              followSignal={followSignal}
              onFetchImage={fetchImage}
              onOpenAgent={id => void openAgent(id)}
              tasks={view.tasks}
              onOpenTask={openTask}
            />
          )
        ) : (
          <div className="transcript transcript--empty">
            {following
              ? 'Reconnecting to the session…'
              : 'Pick a session to attach.'}
          </div>
        )}

        {agent ? (
          <AgentPanel panel={agent} onClose={() => setAgent(null)} />
        ) : null}

        {view.requests.length > 0 ? (
          <div
            className="trays"
            role="group"
            aria-label="Requests awaiting answers"
          >
            {view.requests.map(renderTray)}
          </div>
        ) : null}

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
            <>
              <Instruments
                meta={meta}
                todos={view.todos}
                catalog={view.catalog}
                onSetMode={mode =>
                  void gateway.command('mode', { kind: 'mode_set', mode })
                }
                onSetModel={model =>
                  void gateway.command('model', { kind: 'model_set', model })
                }
              />
              <TaskPanel
                tasks={view.tasks}
                viewedTaskId={
                  viewedOutputId ??
                  (agent
                    ? view.tasks.find(task => task.agentId === agent.agentId)
                        ?.id
                    : undefined)
                }
                onOpenTask={openTask}
                onKillTask={killTask}
              />
            </>
          </InstrumentSheet>
        ) : null}

        {activeKey ? (
          <Composer
            busy={busy}
            knownPaths={knownPaths}
            commands={view.catalog.commands}
            queued={view.queue}
            onRpc={sendRpc}
            onSubmit={(text, delivery, images) => {
              void gateway.command('prompt', {
                kind: 'prompt',
                commandId: crypto.randomUUID(),
                content: text,
                ...(images.length ? { images } : {}),
                delivery,
                sessionEpoch: meta?.sessionEpoch ?? 0,
              })
              setFollowSignal(n => n + 1)
            }}
            onInterrupt={() => {
              void gateway.command('cancel', { kind: 'cancel' })
            }}
          />
        ) : null}
      </main>
    </div>
  )
}
