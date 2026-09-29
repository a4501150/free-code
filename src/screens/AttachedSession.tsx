import React, {
  useState,
  useEffect,
  useRef,
  useMemo,
  useCallback,
  useSyncExternalStore,
} from 'react'
import { randomUUID } from 'crypto'
import { Box, Text, useApp, useInput } from '../ink.js'
import ScrollBox, { type ScrollBoxHandle } from '../ink/components/ScrollBox.js'
import { ScrollKeybindingHandler } from '../components/ScrollKeybindingHandler.js'
import { useExitOnCtrlCDWithKeybindings } from '../hooks/useExitOnCtrlCDWithKeybindings.js'
import {
  connectSurfaceClient,
  type SurfaceClient,
  type SurfaceCommandPath,
} from '../webui/gateway/surfaceClient.js'
import type { WireSessionMeta } from '../session/wire.js'
import {
  createViewStore,
  type SessionView,
  type ViewStore,
} from '../session/viewStore.js'
import { bottomBarParts, draftView, modeLabel } from './attached/itemViews.js'
import { useStatusLine } from './attached/StatusLineRow.js'
import type { LocalDialog, LocalDialogStore } from '../session/localDialogs.js'
import {
  NewMessagesPill,
  isJumpToBottomVisible,
} from '../components/FullscreenLayout.js'
import { SpinnerWithVerb, type SpinnerMode } from '../components/Spinner.js'
import { LogoV2 } from '../components/LogoV2/LogoV2.js'
import { taskView } from '../webui/client/itemViews.js'
import { AttachedTranscript } from './attached/AttachedTranscript.js'
import { TaskPanelRows } from '../components/TaskLivePanel.js'
import { TaskListV2 } from '../components/TaskListV2.js'
import type { Task, TaskStatus } from '../utils/taskSchemas.js'
import { useAppState, useSetAppState } from '../state/AppState.js'
import { AssistantThinkingMessage } from '../components/messages/AssistantThinkingMessage.js'
import { AssistantTextMessage } from '../components/messages/AssistantTextMessage.js'
import { getAllBaseTools } from '../tools.js'
import type { Tools, ToolUseContext } from '../Tool.js'
import { BackgroundTasksDialog } from '../components/tasks/BackgroundTasksDialog.js'
import { ModalContext } from '../context/modalContext.js'
import {
  queueRows,
  queueEditBody,
  queueRemoveBody,
  rpcBody,
  slashSuggestions,
} from '../webui/client/composerViews.js'
import { AttachedTrays } from './attached/AttachedTrays.js'
import { Select } from '../components/CustomSelect/index.js'
import { KeybindingSetup } from '../keybindings/KeybindingProviderSetup.js'
import { getInitialSettings } from '../utils/settings/settings.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'

/** Rows of transcript kept visible above a local dialog's ▔ divider —
 *  mirrors FullscreenLayout's MODAL_TRANSCRIPT_PEEK. */
const MODAL_TRANSCRIPT_PEEK = 2

type ConnectionState =
  | { status: 'connecting' }
  | { status: 'connected'; client: SurfaceClient }
  | { status: 'disconnected'; reason: string }
  | { status: 'error'; message: string }

export type AttachedSessionProps = {
  /** The process whose attach descriptor carries the port and token. */
  pid: number
  /**
   * Attach a session other than the descriptor's primary (a hosted session
   * on a multi-session host). Also shown in the header.
   */
  sessionId?: string
  /** Reach the surface at this origin instead of the descriptor's port. */
  url?: string
  /** Header label; defaults to the PID. */
  label?: string
  /**
   * Submit this prompt once, right after the first connect — the hosted
   * launcher's seam for the CLI's positional initial prompt. Slash
   * commands ride the session's own input processing, as in the REPL.
   */
  initialPrompt?: string
  /**
   * Replace the viewer header with the classic welcome banner. Only the
   * hosted launcher sets it: that process IS the session's, so the banner
   * describes it; a remote attach shows the header instead.
   */
  showWelcomeBanner?: boolean
  /**
   * In-process handoff for local-jsx slash-command dialogs (/help, /model):
   * the session's input pipeline writes the dialog JSX here and this viewer
   * mounts it in its modal slot, exactly where the REPL's tool-JSX slot
   * lives. Only the hosting process has the session to hand; a remote
   * attach passes nothing and its dialog commands stay with the host (like
   * the /tasks mirror).
   */
  localDialogs?: LocalDialogStore
  onExit?: () => void
}

const NO_DIALOG_SUBSCRIBE =
  (_listener: () => void): (() => void) =>
  () => {}
const NO_DIALOG_SNAPSHOT = (): LocalDialog | null => null

// The transcript projection is the shared view store
// (`src/session/viewStore.ts`) — the same reducer the browser client runs,
// so one projection serves both UIs. `useSyncExternalStore` adapts it to
// this tree; transcript churn re-renders only what subscribes.

function useWireStore(store: ViewStore): SessionView {
  return useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot)
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export function AttachedSession({
  pid,
  sessionId,
  url,
  label,
  initialPrompt,
  showWelcomeBanner,
  localDialogs,
  onExit,
}: AttachedSessionProps): React.ReactNode {
  const store = useMemo(() => createViewStore(), [])
  const view = useWireStore(store)
  const [connection, setConnection] = useState<ConnectionState>({
    status: 'connecting',
  })
  const clientRef = useRef<SurfaceClient | null>(null)
  const scrollRef = useRef<ScrollBoxHandle>(null)
  const [inputText, setInputText] = useState('')
  const [submitError, setSubmitError] = useState<string | null>(null)
  const historyRef = useRef<string[]>([])
  const historyAtRef = useRef(-1)
  const [editingQueueId, setEditingQueueId] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [runningSince, setRunningSince] = useState<number | null>(null)
  const [, setTick] = useState(0)
  const { exit } = useApp()

  // The in-process host mounts classic local dialogs (the /tasks pane) in a
  // modal slot mirroring FullscreenLayout's: the dialog publishes its focused
  // ScrollBox on modalScrollRef and the viewer's pager keys drive it instead
  // of the transcript — the same merged-ref trick the REPL's
  // useReplTranscript uses for its own modal slot.
  const modalScrollRef = useRef<ScrollBoxHandle>(null)
  const scrollKeyTargetRef = useMemo(
    () => ({
      get current(): ScrollBoxHandle | null {
        return modalScrollRef.current ?? scrollRef.current
      },
    }),
    [],
  )
  const [tasksDialog, setTasksDialog] = useState(false)
  // The scroll-away divider snapshot the pill tests against — the viewer's
  // mirror of FullscreenLayout's `dividerYRef`/`useUnseenDivider` chrome:
  // scrollHeight at the first scroll-away, null once following resumes.
  const dividerYRef = useRef<number | null>(null)
  const onTranscriptScroll = useCallback(
    (sticky: boolean, handle: ScrollBoxHandle) => {
      // Only transcript scrolls drive the pill — a mounted modal publishes
      // scroll events against its OWN handle (the merged-ref target), and
      // snapshotting those would strand the pill on dialog close.
      if (handle !== scrollRef.current) return
      if (sticky) {
        dividerYRef.current = null
        return
      }
      const max = Math.max(
        0,
        handle.getScrollHeight() - handle.getViewportHeight(),
      )
      if (handle.getScrollTop() + handle.getPendingDelta() >= max) return
      if (dividerYRef.current === null) {
        dividerYRef.current = handle.getScrollHeight()
      }
    },
    [],
  )
  const subscribeScrollChrome = useCallback(
    (listener: () => void) =>
      scrollRef.current?.subscribe(listener) ?? (() => {}),
    [],
  )
  const pillVisible = useSyncExternalStore(subscribeScrollChrome, () =>
    isJumpToBottomVisible(scrollRef.current, dividerYRef.current),
  )
  // Optimistic in-flight marker: classic flips its footer to the running
  // hint in the same keystroke commit that submits the prompt; a hosted
  // submit round-trips through the wire, and without this flip the pane
  // keeps showing the idle hint (and `waitForPrompt`-style idle checks
  // keep matching it) for the whole command-latency window.
  const [turnStarting, setTurnStarting] = useState(false)
  const turnStartingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  )
  const markTurnStarting = useCallback(() => {
    setTurnStarting(true)
    if (turnStartingTimerRef.current) clearTimeout(turnStartingTimerRef.current)
    // A command that never starts a turn (a local-jsx slash dialog, a
    // rejected prompt) must not strand the hint — the real running state
    // takes over from the meta stream the moment it does start.
    turnStartingTimerRef.current = setTimeout(
      () => setTurnStarting(false),
      5000,
    )
    turnStartingTimerRef.current.unref?.()
  }, [])
  useEffect(() => {
    if (turnStarting && view.meta && view.meta.state !== 'idle') {
      if (turnStartingTimerRef.current)
        clearTimeout(turnStartingTimerRef.current)
      setTurnStarting(false)
    }
  }, [turnStarting, view.meta?.state])
  useEffect(
    () => () => {
      if (turnStartingTimerRef.current)
        clearTimeout(turnStartingTimerRef.current)
    },
    [],
  )
  // A local-jsx dialog the session's input pipeline just built (/help,
  // /model, …): the same slot the REPL's tool-JSX modal holds for them.
  const localDialog = useSyncExternalStore(
    localDialogs ? localDialogs.subscribe : NO_DIALOG_SUBSCRIBE,
    localDialogs ? localDialogs.snapshot : NO_DIALOG_SNAPSHOT,
    localDialogs ? localDialogs.snapshot : NO_DIALOG_SNAPSHOT,
  )
  // A remote attach cannot mount the session's local dialogs — only the
  // process that hosts the session can.
  const isLocalHost = pid === process.pid
  const showLocalDialog =
    isLocalHost && localDialog !== null && localDialog.jsx !== null

  const cancel = useCallback(() => {
    void clientRef.current?.command('cancel', { kind: 'cancel' })
  }, [])

  const doExit = useCallback(() => {
    clientRef.current?.close()
    if (onExit) onExit()
    else exit()
  }, [onExit, exit])

  const exitState = useExitOnCtrlCDWithKeybindings(doExit, () => {
    if (view.meta?.state === 'running' && clientRef.current) {
      cancel()
      return true
    }
    return false
  })

  useEffect(() => {
    let cancelled = false
    let client: SurfaceClient | null = null

    async function connect(): Promise<void> {
      try {
        // connectSurfaceClient reads and verifies the descriptor and the
        // surface delivers a full snapshot as the stream's first event, so
        // there is nothing to send after the handshake resolves.
        client = await connectSurfaceClient(
          pid,
          {
            onEvent(seq, event) {
              store.apply(seq, event)
            },
            onClose(reason) {
              if (!cancelled) {
                clientRef.current = null
                setConnection({ status: 'disconnected', reason })
              }
            },
          },
          { sessionId, url },
        )

        if (cancelled) {
          client.close()
          return
        }

        clientRef.current = client
        setConnection({ status: 'connected', client })
      } catch (err) {
        if (!cancelled) {
          setConnection({
            status: 'error',
            message: err instanceof Error ? err.message : String(err),
          })
        }
      }
    }

    void connect()

    return () => {
      cancelled = true
      client?.close()
      clientRef.current = null
    }
  }, [pid, sessionId, url, store])

  const send = useCallback(
    async (body: Record<string, unknown>): Promise<void> => {
      const client = clientRef.current
      if (!client || !view.meta) return
      const response = await client.command(
        String(body.kind) as SurfaceCommandPath,
        body,
      )
      // A stale epoch comes back as 409 {ok:false} with the reason attached.
      if (!response.ok) {
        setSubmitError(response.error?.message ?? 'Command failed')
        setTimeout(() => setSubmitError(null), 3000)
      }
    },
    [view.meta],
  )

  // One-shot initial prompt (the launcher's `initialPrompt`): fired once
  // the snapshot has landed, so it carries the stream's session epoch and
  // the transcript shows the user row in the right place.
  const initialPromptSentRef = useRef(false)
  useEffect(() => {
    if (
      !initialPrompt ||
      initialPromptSentRef.current ||
      connection.status !== 'connected' ||
      !view.meta
    )
      return
    initialPromptSentRef.current = true
    scrollRef.current?.scrollToBottom()
    dividerYRef.current = null
    markTurnStarting()
    void send({
      kind: 'prompt',
      content: initialPrompt,
      delivery: 'next',
      commandId: randomUUID(),
      sessionEpoch: view.meta.sessionEpoch ?? 0,
    } as Record<string, unknown>)
  }, [initialPrompt, connection.status, view.meta, send, markTurnStarting])

  const handleSubmit = useCallback(
    async (text: string) => {
      // /tasks is a local dialog, not a turn: when this process IS the
      // session's, the viewer mounts the classic BackgroundTasksDialog
      // itself — the session's task state and output files are right here,
      // no wire round-trip (and no dropped JSX) needed. A remote attach
      // falls through to the session, which replies as before.
      if (isLocalHost && text.trim() === '/tasks') {
        setEditingQueueId(null)
        setTasksDialog(true)
        return
      }
      // /compact and /clear render nothing when the host runs them, so the
      // viewer sends those two as rpc — the same buttons the browser has.
      const word = text.trim().split(/\s/)[0] ?? ''
      if (word === '/compact' || word === '/clear') {
        setEditingQueueId(null)
        await send(
          rpcBody(word === '/compact' ? 'compact' : 'clear') as Record<
            string,
            unknown
          >,
        )
        return
      }
      if (editingQueueId) {
        setEditingQueueId(null)
        await send(
          queueEditBody(editingQueueId, text) as Record<string, unknown>,
        )
        return
      }
      // The human-message backstop the classic REPL runs on submit:
      // re-pin the transcript and clear the unseen-divider snapshot.
      scrollRef.current?.scrollToBottom()
      dividerYRef.current = null
      markTurnStarting()
      await send({
        kind: 'prompt',
        content: text,
        delivery: 'next',
        commandId: randomUUID(),
        sessionEpoch: view.meta?.sessionEpoch ?? 0,
      } as Record<string, unknown>)
    },
    [send, editingQueueId, view.meta, isLocalHost, markTurnStarting],
  )

  // The classic tool registry: feeds the real tool cards. A tool the card
  // cannot resolve for (MCP on a remote attach, newer host build) renders
  // the viewer-native fallback row inside AttachedTranscript.
  const tools = useMemo<Tools>(() => getAllBaseTools(), [])
  const { columns, rows } = useTerminalSize()
  // Classic's default, not a viewer-local one: the setting drives the
  // classic pane and defaults to ON (`!== false`), and the pane here must
  // show what it shows. ctrl+O toggles within the session.
  const [showInjectedContext, setShowInjectedContext] = useState<boolean>(
    () => getInitialSettings().showInjectedContext !== false,
  )

  const isRunning = view.meta?.state === 'running'
  const isConnected = connection.status === 'connected'
  const pendingRequest = view.requests[0] ?? null
  // The composer stands down while a tray awaits an answer or a local
  // dialog holds the keys — keystrokes belong to the dialog, not the
  // prompt buffer.
  const composerActive =
    isConnected && !pendingRequest && !tasksDialog && !showLocalDialog

  // The prompt-suggestion ghost: the session's stop-hook fork writes
  // AppState.promptSuggestion.text into the shared store (the query loop
  // runs session-side), and this composer paints it where the classic
  // input paints its placeholder. Hidden while responding or typing, like
  // usePromptSuggestion gates it in the REPL.
  const setAppState = useSetAppState()
  const suggestionText = useAppState(s => s.promptSuggestion.text)
  const ghostText =
    suggestionText && inputText === '' && !isRunning && !turnStarting
      ? suggestionText
      : null
  useEffect(() => {
    if (!ghostText) return
    // The mirror of the hook's markShown — telemetry and accept tracking
    // both gate on shownAt.
    setAppState(prev =>
      prev.promptSuggestion.shownAt !== 0 || !prev.promptSuggestion.text
        ? prev
        : {
            ...prev,
            promptSuggestion: {
              ...prev.promptSuggestion,
              shownAt: Date.now(),
            },
          },
    )
  }, [ghostText, setAppState])
  const acceptSuggestion = useCallback(() => {
    setAppState(prev => ({
      ...prev,
      promptSuggestion: {
        text: null,
        promptId: null,
        shownAt: 0,
        acceptedAt: 0,
        generationRequestId: null,
      },
    }))
  }, [setAppState])

  // A running-turn clock: starts on the transition into running, and a 1s
  // tick keeps the elapsed time and task durations fresh. The refs back the
  // classic SpinnerWithVerb — the viewer shows the REPL's own spinner, not
  // a text mimic, so it carries the same loading-start/length/timer inputs.
  const loadingStartTimeRef = useRef<number>(Date.now())
  const totalPausedMsRef = useRef(0)
  const pauseStartTimeRef = useRef<number | null>(null)
  const responseLengthRef = useRef(0)
  useEffect(() => {
    if (isRunning && runningSince === null) {
      setRunningSince(Date.now())
      loadingStartTimeRef.current = Date.now()
      responseLengthRef.current = 0
    }
    if (!isRunning && runningSince !== null) setRunningSince(null)
  }, [isRunning, runningSince])
  useEffect(() => {
    const timer = setInterval(() => setTick(t => t + 1), 1000)
    timer.unref?.()
    return () => clearInterval(timer)
  }, [])

  // The classic spinner's token counter tracks the streamed response
  // length; the wire draft is this viewer's copy of that stream.
  useEffect(() => {
    const draft = view.streamDraft
    if (!draft || !isRunning) return
    responseLengthRef.current =
      (draft.text?.length ?? 0) +
      (draft.thinking?.length ?? 0) +
      draft.tools.reduce((n, t) => n + t.partialJson.length, 0)
  }, [view.streamDraft, isRunning])

  const verbose = useAppState(s => s.verbose)
  // The classic footer's statusline half (see attached/StatusLineRow.tsx).
  const statusLine = useStatusLine()

  // ── The task board, mirrored from the wire ───────────────────────────
  // The stream's todo rows ARE the session's task board (subject, status,
  // activeForm). The classic pane mounts the same TaskLivePanel machinery
  // from this data: while the turn runs the panel rides FLUSH under the
  // spinner without its header, and when the turn settles the standalone
  // headered panel takes the spinner's slot. The classic store auto-
  // expands on any board write and hides a board whose tasks are all
  // completed after a five-second window — mirrored here over wire state,
  // where the session's own store is not this tree's context.
  const boardTasks = useMemo<Task[]>(
    () =>
      view.todos.map((todo, at) => ({
        id: String(at + 1),
        subject: todo.content,
        description: '',
        ...(todo.activeForm ? { activeForm: todo.activeForm } : {}),
        status: todo.status as TaskStatus,
        blocks: [],
        blockedBy: [],
      })),
    [view.todos],
  )
  const [boardExpanded, setBoardExpanded] = useState(false)
  const boardSignatureRef = useRef<string | null>(null)
  useEffect(() => {
    const signature = JSON.stringify(view.todos)
    const first = boardSignatureRef.current === null
    boardSignatureRef.current = signature
    // A board write seen while watching expands the panel, like the task
    // tools do in the classic store; the attach-time snapshot alone does
    // not — the classic pane opens collapsed for a board it did not
    // watch grow.
    if (!first && view.todos.length > 0) setBoardExpanded(true)
    if (!view.todos.every(todo => todo.status === 'completed')) return
    const timer = setTimeout(() => setBoardExpanded(false), 5000)
    timer.unref?.()
    return () => clearTimeout(timer)
  }, [view.todos])
  const panelVisible = boardExpanded && boardTasks.length > 0

  // The newest host toast (settings errors, rate limits): shown briefly.
  const notification =
    view.notifications.error ??
    view.notifications.warn ??
    view.notifications.info
  const notificationKey = notification?.text
  useEffect(() => {
    if (!notificationKey) return
    setToast(notificationKey)
    const timer = setTimeout(() => setToast(null), 5000)
    return () => clearTimeout(timer)
  }, [notificationKey])

  const paletteToken = inputText.startsWith('/')
    ? inputText.split(/\s/)[0]!
    : ''
  const palette = useMemo(
    () =>
      paletteToken ? slashSuggestions(view.catalog.commands, paletteToken) : [],
    [paletteToken, view.catalog.commands],
  )
  const queued = queueRows(view.queue)

  useInput(
    (input, key) => {
      if (!composerActive) return

      if (key.return) {
        const trimmed = inputText.trim()
        if (key.shift && isRunning && !trimmed) {
          // Steer: an empty Shift+Enter is the browser's interrupt affordance.
          cancel()
          return
        }
        // An empty Enter accepts a visible suggestion — the mirror of the
        // REPL's input-matches-suggestion submit.
        const submitText = trimmed ? inputText : (ghostText ?? '')
        if (ghostText && !trimmed) acceptSuggestion()
        if (submitText.trim()) {
          historyRef.current.push(submitText.trim())
          if (historyRef.current.length > 50) historyRef.current.shift()
          historyAtRef.current = -1
          void handleSubmit(submitText)
          setInputText('')
        }
        return
      }

      if (key.backspace || key.delete) {
        setInputText(prev => prev.slice(0, -1))
        return
      }

      if (key.escape) {
        if (editingQueueId) {
          setEditingQueueId(null)
          setInputText('')
          return
        }
        if (isRunning) cancel()
        return
      }

      if (key.upArrow || key.downArrow) {
        // History ring, newest first; only while the line is single-line.
        const history = historyRef.current
        if (history.length === 0 || inputText.includes('\n')) return
        let at = historyAtRef.current
        at = key.upArrow
          ? at < 0
            ? history.length - 1
            : Math.max(0, at - 1)
          : at < 0
            ? at
            : Math.min(history.length - 1, at + 1)
        historyAtRef.current = at
        if (at >= 0) setInputText(history[at]!)
        return
      }

      // Queue row hotkeys on the first queued row, composer-empty only:
      // ctrl+x drops it, ctrl+e loads it back for editing (the submit then
      // rides rpc queue_edit). Ctrl so a prompt starting with e/x is never
      // swallowed by a hotkey.
      if (key.ctrl && inputText === '' && queued.length > 0) {
        const row = queued[0]!
        if (input === 'x') {
          void send(queueRemoveBody(row.id) as Record<string, unknown>)
          return
        }
        if (input === 'e') {
          setEditingQueueId(row.id)
          setInputText(row.text)
          return
        }
      }

      if (key.ctrl && (input === 'o' || input === 't')) {
        // Expand/collapse the injected-context rows — the classic
        // transcript toggle, and the exact key the collapsed rows name.
        setShowInjectedContext(value => !value)
        return
      }

      if (key.ctrl || key.meta) return
      if (key.leftArrow || key.rightArrow) return
      if (key.pageUp || key.pageDown) return
      if (key.tab) return

      if (input) setInputText(prev => prev + input)
    },
    { isActive: composerActive },
  )

  const draft = isRunning ? draftView(view.streamDraft) : null
  // The classic spinner row: same component, same modes, driven from what
  // the wire says the turn is doing. A compaction rides the spinner's
  // progress bar instead of a mode word.
  const spinnerMode: SpinnerMode =
    view.meta?.activity === 'compacting' ||
    view.meta?.activity === undefined ||
    view.meta?.activity === null
      ? 'responding'
      : (view.meta.activity as SpinnerMode)
  const showSpinner = isRunning && !pendingRequest

  // The screen brings its own keybinding provider: CustomSelect's
  // accept/next/previous (every tray keystroke) rides useKeybindings, which
  // silently no-ops without one — the `App` wrapper does not install it, so
  // joining from main.tsx or the hosted launcher needs it here, not at
  // every call site. Callers that already provide one nest a redundant but
  // harmless instance.
  return (
    <KeybindingSetup>
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        {/* The scroll-wrap FullscreenLayout gives the pill: the absolute
            bottom row of THIS box, floating over the ScrollBox's last
            content row (not the dock). */}
        <Box flexGrow={1} flexDirection="column" overflow="hidden">
          <ScrollBox
            ref={scrollRef}
            flexGrow={1}
            flexDirection="column"
            stickyScroll
          >
            {/* Hosted launches mount the classic welcome banner — the
              process owns the session, so the banner's model/cwd lines
              describe what the classic REPL would show. A remote attach
              gets the one-line header instead. */}
            {showWelcomeBanner ? (
              <LogoV2 />
            ) : (
              <Box paddingX={2} paddingY={1}>
                <Text dimColor>
                  ── Attached to {label ?? `PID ${pid}`}
                  {view.meta ? ` · ${view.meta.cwd}` : ''} ──
                </Text>
              </Box>
            )}

            {connection.status === 'connecting' && (
              <Box paddingX={2}>
                <Text dimColor>Connecting to session...</Text>
              </Box>
            )}

            {connection.status === 'error' && (
              <Box paddingX={2}>
                <Text color="error">
                  Connection failed: {connection.message}
                </Text>
              </Box>
            )}

            {/* Transcript: the classic message components, fed from the wire */}
            <AttachedTranscript
              view={view}
              tools={tools}
              showInjectedContext={showInjectedContext}
              verbose={verbose}
              // The classic `Session context` row is rebuilt from the local
              // getUserContext() — honest only when this process is the host.
              showSessionContextRow={pid === process.pid}
            />

            {/* Streaming preview at the transcript tail. A tool-only draft
              renders NOTHING here — the in-flight cards are painted by
              the transcript bridge at the transcript tail, and mounting
              this row's separator for a body it does not have would add
              and drop a blank row on every draft/commit boundary (the
              classic streaming preview grows from the same rows it will
              commit into, so no separator churn exists there). */}
            {draft && (draft.thinking || draft.text) ? (
              <StreamDraftRow draft={draft} />
            ) : null}

            {/* The classic spinner block lives INSIDE the scroll content,
              after a growing spacer: mounting it at a turn start appends
              at the block's bottom edge — the top edge never moves until
              the content outgrows the viewport, and then the log-update
              shift fast path scrolls instead of repainting the screen
              (what tests/e2e/edit-inflight-panel-repaint guards). A dock
              copy of the spinner would resize the scroll viewport and
              rewrite every visible row at each turn boundary. */}
            <Box flexGrow={1} />
            {showSpinner ? (
              <SpinnerWithVerb
                mode={spinnerMode}
                loadingStartTimeRef={loadingStartTimeRef}
                totalPausedMsRef={totalPausedMsRef}
                pauseStartTimeRef={pauseStartTimeRef}
                responseLengthRef={responseLengthRef}
                verbose={verbose}
                hasActiveTools={
                  (view.meta?.inProgressToolUseIds?.length ?? 0) > 0
                }
                compactingStartTime={
                  view.meta?.activity === 'compacting'
                    ? (runningSince ?? Date.now())
                    : null
                }
              />
            ) : (
              panelVisible && (
                // The classic's idle swap: the standalone headered panel
                // takes the spinner's bottom-anchored slot, so the panel
                // visibly replaces the spinner when the turn settles.
                <TaskListV2 tasks={boardTasks} isStandalone />
              )
            )}
            {showSpinner && panelVisible && (
              // Busy-time panel: FLUSH under the spinner row, no header —
              // the same TaskPanelRows the classic spinner hosts.
              <TaskPanelRows tasks={boardTasks} />
            )}
          </ScrollBox>
          {!tasksDialog && !showLocalDialog && pillVisible && (
            <NewMessagesPill
              count={0}
              // jumpToNew's behavior: scrollToBottom re-arms sticky, the
              // pill's own at-bottom check hides it, and the divider
              // snapshot stays alive so the unseen position is remembered.
              onClick={() => scrollRef.current?.scrollToBottom()}
            />
          )}
        </Box>

        <ScrollKeybindingHandler
          scrollRef={scrollKeyTargetRef}
          isActive
          onScroll={onTranscriptScroll}
        />

        {/* Disconnected banner */}
        {connection.status === 'disconnected' && (
          <Box flexShrink={0} flexDirection="column" paddingX={2} paddingY={1}>
            <Text color="warning" bold>
              Session engine exited
            </Text>
            <Text dimColor>{connection.reason}</Text>
            <Box marginTop={1}>
              <Select
                options={[{ label: 'Exit', value: 'exit' }]}
                onChange={doExit}
              />
            </Box>
          </Box>
        )}

        {/* Blocking request trays take the keys while anything is pending.
            No horizontal padding: the classic REPL mounts its permission
            dialogs directly in the scroll column with no wrapper inset, and
            the mirrored dialogs size themselves against the terminal — a
            paddingX here would steal columns they already budgeted for and
            wrap the pane. */}
        {pendingRequest && isConnected && (
          <Box flexShrink={0} paddingTop={1}>
            <AttachedTrays
              requests={view.requests}
              submit={(requestId, response) => {
                void send({
                  kind: 'request_respond',
                  requestId,
                  response,
                })
              }}
            />
          </Box>
        )}

        {/* Queued prompts and background tasks. The task board does not
            live here — it renders as the classic task panel, spinner-slot
            busy-time and standalone at idle, above. Hidden while a local
            dialog owns the bottom of the screen. */}
        {isConnected &&
          !tasksDialog &&
          !showLocalDialog &&
          (queued.length > 0 || view.tasks.length > 0) && (
            <Box flexShrink={0} flexDirection="column" paddingX={2}>
              {queued.length > 0 && (
                <Box>
                  <Text dimColor>
                    queued:{' '}
                    {queued
                      .map(row => row.text)
                      .join(' · ')
                      .slice(0, 120)}
                    {inputText === '' ? '  (^e edit · ^x drop)' : ''}
                  </Text>
                </Box>
              )}
              {view.tasks.length > 0 && (
                <Box>
                  <Text dimColor>
                    tasks:{' '}
                    {view.tasks
                      .map(task => {
                        const view0 = taskView(task, Date.now())
                        return `${view0.marker} ${view0.label}${view0.duration ? ` ${view0.duration}` : ''}`
                      })
                      .slice(0, 4)
                      .join(' · ')
                      .slice(0, 160)}
                  </Text>
                </Box>
              )}
            </Box>
          )}

        {/* Composer — the classic dock: full-width rule, the prompt line
            at column 0, full-width rule, footer. The spinner and the task
            panel live in the scroll content above, exactly where the
            classic REPL mounts them. Same rows, same order, same indent
            as the classic pane. Hidden while a local dialog owns the
            bottom of the screen, like PromptInput returning null behind
            the REPL's modal. */}
        {isConnected && !tasksDialog && !showLocalDialog && (
          <Box flexShrink={0} flexDirection="column" marginTop={1}>
            <Text color="promptBorder">{'─'.repeat(columns)}</Text>
            {pendingRequest ? (
              <Box marginLeft={2}>
                <Text dimColor>Waiting for permission…</Text>
              </Box>
            ) : (
              <Box flexDirection="row">
                <Text color="claude">{editingQueueId ? '✎ ' : '❯ '}</Text>
                {inputText ? (
                  <>
                    <Text>{inputText}</Text>
                    <Text inverse> </Text>
                  </>
                ) : ghostText ? (
                  // The suggestion ghost: cursor first, dim suggestion
                  // after it — the classic input row with a placeholder.
                  <>
                    <Text inverse> </Text>
                    <Text dimColor>
                      {ghostText.slice(0, Math.max(0, columns - 4))}
                    </Text>
                  </>
                ) : (
                  <Text inverse> </Text>
                )}
              </Box>
            )}
            <Text color="promptBorder">{'─'.repeat(columns)}</Text>
            {editingQueueId && (
              <Box paddingX={2}>
                <Text dimColor>
                  editing a queued command — Enter saves, Esc discards
                </Text>
              </Box>
            )}
            {palette.length > 0 && !editingQueueId && (
              <Box paddingX={2}>
                <Text dimColor>
                  {palette
                    .slice(0, 5)
                    .map(
                      item =>
                        `${item.value}${item.hint ? ` ${item.hint}` : ''}${item.detail ? ` — ${item.detail}` : ''}`,
                    )
                    .join('\n')}
                </Text>
              </Box>
            )}
            {(submitError || toast) && (
              <Box paddingX={2}>
                <Text
                  color={submitError ? 'error' : 'warning'}
                  dimColor={!submitError}
                >
                  {submitError ?? toast}
                </Text>
              </Box>
            )}
            {/* The statusline row above the mode line, like the classic
                footer mounts it — only when this process owns the session,
                since only then does the session's driver write the text. */}
            {isLocalHost && statusLine.node}
            {/* One bottom line, like the classic pane: the permission-mode
                label and the hint for the state, with the wire-derived
                metrics kept at the line's right end. The hint yields to a
                displayed statusline, as PromptInputFooter suppresses it. */}
            <AttachedBottomBar
              meta={view.meta}
              running={isRunning || turnStarting}
              hasTray={pendingRequest !== null}
              suppressHint={isLocalHost && statusLine.suppressHint}
              exitPending={
                exitState.pending
                  ? `Press ${exitState.keyName} again to exit`
                  : undefined
              }
            />
          </Box>
        )}

        {/* The local /tasks dialog, in the modal slot FullscreenLayout gives
            the classic dialogs in the REPL: bottom-anchored, ▔ divider,
            ModalContext so the dialog budgets its scroll viewports against
            the pane and publishes its focused panel on modalScrollRef.
            Last sibling so it paints over everything it covers. */}
        {isLocalHost && tasksDialog && (
          <ModalContext
            value={{
              rows: rows - MODAL_TRANSCRIPT_PEEK - 1,
              columns: columns - 4,
              scrollRef: modalScrollRef,
            }}
          >
            <Box
              position="absolute"
              bottom={0}
              left={0}
              right={0}
              maxHeight={rows - MODAL_TRANSCRIPT_PEEK}
              flexDirection="column"
              overflow="hidden"
              opaque
            >
              <Box flexShrink={0}>
                <Text color="permission">{'▔'.repeat(columns)}</Text>
              </Box>
              <Box
                flexDirection="column"
                paddingX={2}
                flexShrink={0}
                overflow="hidden"
              >
                <BackgroundTasksDialog
                  onDone={() => setTasksDialog(false)}
                  toolUseContext={undefined as unknown as ToolUseContext}
                />
              </Box>
            </Box>
          </ModalContext>
        )}

        {/* A local-jsx dialog the session built (/help, /model, …), in the
            same modal slot. The JSX arrived whole through the in-process
            handoff — its own components carry their keybindings, and the
            closing onDone runs inside the session's input pipeline, which
            appends the command's transcript rows from there. */}
        {showLocalDialog && localDialog && (
          <ModalContext
            value={{
              rows: rows - MODAL_TRANSCRIPT_PEEK - 1,
              columns: columns - 4,
              scrollRef: modalScrollRef,
            }}
          >
            <Box
              position="absolute"
              bottom={0}
              left={0}
              right={0}
              maxHeight={rows - MODAL_TRANSCRIPT_PEEK}
              flexDirection="column"
              overflow="hidden"
              opaque
            >
              <Box flexShrink={0}>
                <Text color="permission">{'▔'.repeat(columns)}</Text>
              </Box>
              <Box
                flexDirection="column"
                paddingX={2}
                flexShrink={0}
                overflow="hidden"
              >
                {localDialog.jsx}
              </Box>
            </Box>
          </ModalContext>
        )}
      </Box>
    </KeybindingSetup>
  )
}

/**
 * The in-flight preview: what the model is writing NOW, before any of it
 * is a committed transcript row. Cumulative by contract, so this render is
 * a whole take — no stale fragment can survive a frame.
 */
function StreamDraftRow({
  draft,
}: {
  draft: NonNullable<ReturnType<typeof draftView>>
}): React.ReactNode {
  return (
    <Box flexDirection="column" paddingTop={1}>
      {draft.thinking ? (
        <AssistantThinkingMessage
          param={{ type: 'thinking', thinking: draft.thinking }}
          addMargin={false}
          isTranscriptMode={false}
          verbose={false}
          isStreaming
        />
      ) : null}
      {draft.text ? (
        // The dot rides the preview too: the classic streaming row shows
        // the same ⏺ gutter as the committed row will. In-flight tool
        // blocks do NOT render here — the transcript bridge paints them
        // as the real tool cards the classic streaming partials become,
        // at the transcript's tail.
        <AssistantTextMessage
          param={{ type: 'text', text: draft.text }}
          addMargin={false}
          shouldShowDot={true}
          verbose={false}
        />
      ) : null}
    </Box>
  )
}

// ---------------------------------------------------------------------------
// Status bar
// ---------------------------------------------------------------------------

function AttachedBottomBar({
  meta,
  running,
  hasTray,
  suppressHint,
  exitPending,
}: {
  meta: WireSessionMeta | null
  running: boolean
  hasTray: boolean
  /** True when a displayed statusline owns the footer — classic footer
   *  behavior: the `? for shortcuts` hint yields to the user's line. */
  suppressHint?: boolean
  exitPending?: string
}): React.ReactNode {
  if (!meta) return null

  const mode = modeLabel(meta.permissionMode)
  const bar = bottomBarParts({ running, waitingForUser: hasTray })

  return (
    <Box paddingX={2}>
      {exitPending ? (
        <Text dimColor>{exitPending}</Text>
      ) : (
        <>
          <Text color={mode.color ?? undefined} dimColor={!mode.color}>
            {mode.text}
          </Text>
          {mode.hint ? <Text dimColor>{mode.hint}</Text> : null}
          {!suppressHint && <Text dimColor> · {bar.left}</Text>}
        </>
      )}
    </Box>
  )
}
