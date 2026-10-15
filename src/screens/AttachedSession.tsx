import React, {
  useState,
  useEffect,
  useRef,
  useMemo,
  useCallback,
  useSyncExternalStore,
} from 'react'
import { randomUUID } from 'crypto'
import { Box, Text, Ansi, useApp, useInput } from '../ink.js'
import { stringWidth } from '../ink/stringWidth.js'
import { Message } from '../components/Message.js'
import ScrollBox, { type ScrollBoxHandle } from '../ink/components/ScrollBox.js'
import { ScrollKeybindingHandler } from '../components/ScrollKeybindingHandler.js'
import { useExitOnCtrlCDWithKeybindings } from '../hooks/useExitOnCtrlCDWithKeybindings.js'
import {
  connectSurfaceClient,
  type SurfaceClient,
  type SurfaceCommandPath,
} from '../webui/gateway/surfaceClient.js'
import type {
  WirePendingCommand,
  WireSessionMeta,
  WireTranscriptSnapshot,
} from '../session/wire.js'
import {
  createViewStore,
  type SessionView,
  type ViewStore,
} from '../session/viewStore.js'
import { toWireItems } from '../session/toWire.js'
import { draftView } from './attached/itemViews.js'
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
import { TaskIdlePanel, TaskPanelRows } from '../components/TaskLivePanel.js'
import { TaskList } from '../components/panels/TaskPanel/TaskList.js'
import type { Task, TaskStatus } from '../utils/taskSchemas.js'
import {
  useAppState,
  useAppStateStore,
  useSetAppState,
} from '../state/AppState.js'
import type { FooterItem } from '../state/AppStateStore.js'
import { AssistantThinkingMessage } from '../components/messages/AssistantThinkingMessage.js'
import { AssistantTextMessage } from '../components/messages/AssistantTextMessage.js'
import { getAllBaseTools } from '../tools.js'
import type { ToolPermissionContext, Tools } from '../Tool.js'
import { PromptInputFooterLeftSide } from '../components/PromptInput/PromptInputFooterLeftSide.js'
import { PromptInputFooterSuggestions } from '../components/PromptInput/PromptInputFooterSuggestions.js'
import type { SuggestionItem } from '../components/PromptInput/PromptInputFooterSuggestions.js'
import { isVimModeEnabled } from '../components/PromptInput/utils.js'
import { useKeybindings } from '../keybindings/useKeybinding.js'
import { renderPlaceholder } from '../hooks/renderPlaceholder.js'
import VimTextInput from '../components/VimTextInput.js'
import type { VimMode } from '../types/textInputTypes.js'
import {
  CoordinatorTaskPanel,
  useCoordinatorTaskCount,
  getVisibleAgentTasks,
} from '../components/CoordinatorAgentStatus.js'
import { useAgentBanner } from '../components/PromptInput/useAgentBanner.js'
import {
  enterAgentView,
  exitAgentView,
  stopOrDismissAgent,
} from '../state/agentViewHelpers.js'
import { isBackgroundTask } from '../tasks/types.js'
import {
  isLocalAgentTask,
  isPanelAgentTask,
} from '../tasks/LocalAgentTask/LocalAgentTask.js'
import { isCoordinatorMode } from '../coordinator/coordinatorMode.js'
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
import { ViewerErrorBoundary } from '../components/ViewerErrorBoundary.js'
import { Select } from '../components/CustomSelect/index.js'
import { KeybindingSetup } from '../keybindings/KeybindingProviderSetup.js'
import { getInitialSettings } from '../utils/settings/settings.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { PromptInputHelpMenu } from '../components/PromptInput/PromptInputHelpMenu.js'
import { QueuedMessageProvider } from '../context/QueuedMessageContext.js'
import {
  createUserMessage,
  EMPTY_LOOKUPS,
  normalizeMessages,
  type StreamApiMetrics,
} from '../utils/messages.js'
import {
  isBuddyTeaserWindow,
  RainbowTeaser,
} from '../buddy/useBuddyNotification.js'
import { CompanionFloatingBubble } from '../buddy/CompanionSprite.js'
import { getGlobalConfig } from '../utils/config.js'

/** Rows of transcript kept visible above a local dialog's ▔ divider —
 *  mirrors FullscreenLayout's MODAL_TRANSCRIPT_PEEK. */
const MODAL_TRANSCRIPT_PEEK = 2

const EMPTY_SET = new Set<string>()

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
  // Live store reads (an Enter that flips the agent view in the same
  // keystroke must steer from the store, not this render's closure).
  const appStateStore = useAppStateStore()
  const [connection, setConnection] = useState<ConnectionState>({
    status: 'connecting',
  })
  const clientRef = useRef<SurfaceClient | null>(null)
  const scrollRef = useRef<ScrollBoxHandle>(null)
  // Click-to-expand grows the transcript mid-list; without this the sticky
  // bottom-follow scrolls the view by the growth (the classic holds too —
  // Messages.onItemClick).
  const holdScrollOnExpand = useCallback(() => {
    scrollRef.current?.holdNextGrowth()
  }, [])
  const [inputText, setInputText] = useState('')
  const [submitError, setSubmitError] = useState<string | null>(null)
  const historyRef = useRef<string[]>([])
  const historyAtRef = useRef(-1)
  const [editingQueueId, setEditingQueueId] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  // The double-Esc clear arming timestamp (useTextInput's handleEscape
  // useDoublePress, mirrored in the bespoke composer's escape branch).
  const escClearArmedRef = useRef<number | null>(null)
  // The shortcuts help menu, toggled by '?' typed as the whole input —
  // the classic input's own affordance (PromptInput's onChange check).
  const [helpOpen, setHelpOpen] = useState(false)
  // The /buddy rainbow teaser: classic queues it through the notifications
  // context on REPL mount; the viewer has no such channel, so it runs the
  // same gate (no companion hatched, teaser window) and timeout directly.
  const [buddyTeaser, setBuddyTeaser] = useState(
    () => !getGlobalConfig().companion && isBuddyTeaserWindow(),
  )
  useEffect(() => {
    if (!buddyTeaser) return
    const timer = setTimeout(() => setBuddyTeaser(false), 15_000)
    timer.unref?.()
    return () => clearTimeout(timer)
  }, [buddyTeaser])
  const [runningSince, setRunningSince] = useState<number | null>(null)
  const [, setTick] = useState(0)
  const { exit } = useApp()
  // The vim input engine's mode, seeded INSERT like the REPL's useReplInput
  // fold; when editorMode is vim the composer below mounts the classic's
  // own VimTextInput and this drives the footer's `-- INSERT --` row.
  const [vimMode, setVimMode] = useState<VimMode>('INSERT')
  // The engine's cursor placement (mandatory TextInput plumbing; the
  // bespoke non-vim composer has none).
  const [cursorOffset, setCursorOffset] = useState(0)
  // The engine's ctrl+c/ctrl+d double-press exit message — the same bytes
  // the exit keybinding hook tracks for the bespoke composer, fed by the
  // engine's onExitMessage instead.
  const [engineExit, setEngineExit] = useState<{
    pending: boolean
    keyName: string | null
  }>({ pending: false, keyName: null })

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
  // A fast local command (/vim, a declined prompt) can run its whole
  // dispatch between two channel publishes, so the state-based clear
  // above never observes the transient 'running' and the hint would
  // strand for the full 5s timeout. The command's output row is the
  // observable that survives: it lands with the state already back to
  // idle, so a transcript that grew while the marker is on and no turn
  // is running means the input settled — clear then.
  const prevOrderLenRef = useRef(-1)
  useEffect(() => {
    const len = view.order.length
    const grew = prevOrderLenRef.current >= 0 && len > prevOrderLenRef.current
    prevOrderLenRef.current = len
    if (grew && turnStarting && view.meta?.state !== 'running') {
      if (turnStartingTimerRef.current)
        clearTimeout(turnStartingTimerRef.current)
      setTurnStarting(false)
    }
  }, [view.order.length, view.meta?.state, turnStarting])
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
      // The classic routes input to the viewed background agent before
      // anything else (PromptInput's getActiveAgentForInput branch): while
      // a drill-down is on screen the prompt steers over the wire, and
      // even slash commands ride it — onAgentSubmit receives the raw input.
      // Live store read: an Enter that just flipped the view in this same
      // keystroke must steer there — the render closure still holds the
      // pre-view state.
      const liveViewingAgentTaskId = appStateStore.getState().viewingAgentTaskId
      if (liveViewingAgentTaskId) {
        setEditingQueueId(null)
        scrollRef.current?.scrollToBottom()
        dividerYRef.current = null
        await send({
          kind: 'prompt',
          content: text,
          delivery: 'next',
          commandId: randomUUID(),
          sessionEpoch: view.meta?.sessionEpoch ?? 0,
          agentId: liveViewingAgentTaskId,
        })
        return
      }
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
    [
      send,
      editingQueueId,
      view.meta,
      isLocalHost,
      markTurnStarting,
      appStateStore,
    ],
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

  // editorMode is a live settings read: /vim flips it and the next render
  // swaps the composer between the bespoke readline row and the classic's
  // own vim engine — the same swap PromptInput makes between TextInput and
  // VimTextInput.
  const vimEnabled = isVimModeEnabled()

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

  // ─── Footer pill navigation (the classic's footer:up/down context) ────
  // The selection lives in the shared store, so the tasks pill
  // (PromptInputFooterLeftSide), the agent panel rows (CoordinatorTaskPanel)
  // and this composer all read the same focus — the same triple PromptInput
  // wires in the REPL. The bespoke useInput below plays the Footer context:
  // this component sits above its own KeybindingSetup provider, so
  // useKeybindings would silently no-op here.
  const tasks = useAppState(s => s.tasks)
  const footerSelection = useAppState(s => s.footerSelection)
  const coordinatorTaskIndex = useAppState(s => s.coordinatorTaskIndex)
  const viewingAgentTaskId = useAppState(s => s.viewingAgentTaskId)
  const coordinatorTaskCount = useCoordinatorTaskCount()
  // The classic's viewed-agent derivation (REPL.tsx): the local_agent whose
  // transcript is on screen, if any.
  const viewedTask = viewingAgentTaskId ? tasks[viewingAgentTaskId] : undefined
  const viewedAgentTask =
    viewedTask && isLocalAgentTask(viewedTask) ? viewedTask : undefined
  const viewedAgentRunning = viewedAgentTask?.status === 'running'
  const agentBanner = useAgentBanner()
  const tasksFooterVisible =
    Object.values(tasks).some(t => t.status === 'running') ||
    coordinatorTaskCount > 0
  // The pill (BackgroundTaskStatus) only renders for non-panel-agent bg
  // tasks; with only agent rows visible the -1 sentinel is skipped.
  const hasBgTaskPill = useMemo(
    () =>
      Object.values(tasks).some(
        t =>
          isBackgroundTask(t) &&
          !(isCoordinatorMode() ? isPanelAgentTask(t) : false),
      ),
    [tasks],
  )
  const minCoordinatorIndex = hasBgTaskPill ? -1 : 0
  const footerItems = useMemo<readonly FooterItem[]>(
    () => (tasksFooterVisible ? ['tasks'] : []),
    [tasksFooterVisible],
  )
  const footerItemSelected =
    footerSelection && footerItems.includes(footerSelection)
      ? footerSelection
      : null
  // The classic's TextInput focus gate (PromptInput's baseProps.focus):
  // a selected footer pill takes the caret out of the input, and an
  // unfocused input paints no cursor.
  const inputFocused = !footerItemSelected
  const tasksSelected = footerItemSelected === 'tasks'
  const selectFooterItem = useCallback(
    (item: FooterItem | null) => {
      setAppState(prev => {
        const nextSelection =
          prev.footerSelection === item ? prev.footerSelection : item
        const nextIndex =
          item === 'tasks' ? minCoordinatorIndex : prev.coordinatorTaskIndex
        if (
          nextSelection === prev.footerSelection &&
          nextIndex === prev.coordinatorTaskIndex
        ) {
          return prev
        }
        return {
          ...prev,
          footerSelection: nextSelection,
          coordinatorTaskIndex: nextIndex,
        }
      })
    },
    [setAppState, minCoordinatorIndex],
  )
  // delta: +1 = down, -1 = up. Returns true when nav happened (including
  // the deselect at the start), false at a boundary — the classic's
  // navigateFooter contract.
  const navigateFooter = useCallback(
    (delta: 1 | -1, exitAtStart = false): boolean => {
      const idx = footerItemSelected
        ? footerItems.indexOf(footerItemSelected)
        : -1
      const next = footerItems[idx + delta]
      if (next) {
        selectFooterItem(next)
        return true
      }
      if (delta < 0 && exitAtStart) {
        selectFooterItem(null)
        return true
      }
      return false
    },
    [footerItemSelected, footerItems, selectFooterItem],
  )
  // The agent row the footer's coordinator index points at: -1/0 is the
  // main line, 1..N the visible agent rows (the classic's openSelected map).
  const selectedAgentTaskId =
    coordinatorTaskIndex >= 1
      ? getVisibleAgentTasks(tasks)[coordinatorTaskIndex - 1]?.id
      : undefined

  // The classic's clamp effect: tasks completing shrink the list under the
  // cursor, and a resurrected index must not steal focus on the next start.
  useEffect(() => {
    if (coordinatorTaskIndex >= coordinatorTaskCount) {
      const clamped = Math.max(minCoordinatorIndex, coordinatorTaskCount - 1)
      setAppState(prev =>
        prev.coordinatorTaskIndex === clamped
          ? prev
          : { ...prev, coordinatorTaskIndex: clamped },
      )
    } else if (coordinatorTaskIndex < minCoordinatorIndex) {
      setAppState(prev =>
        prev.coordinatorTaskIndex === minCoordinatorIndex
          ? prev
          : { ...prev, coordinatorTaskIndex: minCoordinatorIndex },
      )
    }
  }, [
    coordinatorTaskCount,
    coordinatorTaskIndex,
    minCoordinatorIndex,
    setAppState,
  ])
  // A selection whose pill stopped rendering clears itself (the classic's
  // derivation + effect, PromptInput lines ~540).
  useEffect(() => {
    if (footerSelection && !footerItemSelected) {
      setAppState(prev =>
        prev.footerSelection === null
          ? prev
          : { ...prev, footerSelection: null },
      )
    }
  }, [footerSelection, footerItemSelected, setAppState])

  // ─── Agent drill-down: the viewed agent's transcript over the wire ────
  // The hosted viewer shares the session's store, so the task's live
  // message count drives the refetch cadence: every message the agent
  // commits lands on disk before the UI sees it (disk-write-before-yield),
  // so a refetch per task update is a whole take — streaming included.
  // The fetch itself rides the wire (the loader runs in the session's
  // scope, where the sidechain JSONL lives), the same route a remote
  // attach would take.
  const [agentSnapshot, setAgentSnapshot] =
    useState<WireTranscriptSnapshot | null>(null)
  const viewedMessageCount = viewedAgentTask?.messages?.length ?? 0
  const viewedAgentStatus = viewedAgentTask?.status
  const lastAgentViewIdRef = useRef<string | null>(null)
  useEffect(() => {
    if (!viewingAgentTaskId) {
      lastAgentViewIdRef.current = null
      setAgentSnapshot(null)
      return
    }
    // Switching agents never shows the old one's rows while the new
    // snapshot loads.
    if (lastAgentViewIdRef.current !== viewingAgentTaskId) {
      lastAgentViewIdRef.current = viewingAgentTaskId
      setAgentSnapshot(null)
    }
    const client = clientRef.current
    if (!client) return
    let cancelled = false
    void client.agentTranscript(viewingAgentTaskId).then(snapshot => {
      if (!cancelled) setAgentSnapshot(snapshot)
    })
    return () => {
      cancelled = true
    }
  }, [viewingAgentTaskId, viewedMessageCount, viewedAgentStatus])
  // The agent transcript in the SessionView shape AttachedTranscript
  // renders — the classic's display source, item-space: the disk snapshot
  // (the pre-entry prefix, fetched over the wire) UUID-merged under the
  // task's live messages, which is exactly the merge the REPL's bootstrap
  // runs (diskOnly before live; disk-write-before-yield keeps live a
  // suffix). The live half matters for steering: a queued user row
  // appears in task.messages the moment it is sent but reaches the
  // sidechain JSONL only when the agent's run loop drains it.
  const agentTranscriptItems = useMemo(() => {
    const live = toWireItems(viewedAgentTask?.messages ?? [])
    if (!agentSnapshot) {
      return live.length > 0 ? live : null
    }
    const liveIds = new Set(live.map(item => item.id))
    const diskOnly = agentSnapshot.items.filter(item => !liveIds.has(item.id))
    return [...diskOnly, ...live]
  }, [viewedAgentTask?.messages, agentSnapshot])
  const agentView = useMemo<SessionView | null>(() => {
    if (!viewingAgentTaskId || !agentTranscriptItems) return null
    const items = new Map(agentTranscriptItems.map(item => [item.id, item]))
    return {
      ...view,
      items,
      order: agentTranscriptItems.map(item => item.id),
      streamDraft: null,
      meta: view.meta
        ? {
            ...view.meta,
            state: viewedAgentRunning ? 'running' : 'idle',
            inProgressToolUseIds: [],
          }
        : view.meta,
    }
  }, [view, viewingAgentTaskId, agentTranscriptItems, viewedAgentRunning])
  // The classic repins the transcript when the viewed agent changes
  // (useReplTranscript's repinScroll): enter and exit both land on the
  // tail, so the other transcript's scroll offset never bleeds through.
  useEffect(() => {
    scrollRef.current?.scrollToBottom()
  }, [viewingAgentTaskId])

  const paletteToken = inputText.startsWith('/')
    ? inputText.split(/\s/)[0]!
    : ''
  // The classic's showArgumentHint: a bare slash command (no arguments
  // typed yet) with an argumentHint renders the hint dim after the input.
  const argumentHint = useMemo(() => {
    if (!inputText.startsWith('/') || inputText.trim().length === 0) {
      return undefined
    }
    const commandWithoutArgs =
      inputText.trim().indexOf(' ') === -1 || inputText.endsWith(' ')
    if (!commandWithoutArgs) return undefined
    const name = inputText.split(/\s/)[0]!
    const command = view.catalog.commands.find(
      candidate =>
        (candidate.name.startsWith('/')
          ? candidate.name
          : `/${candidate.name}`) === name,
    )
    return command?.argHint
  }, [inputText, view.catalog.commands])
  // The classic's hasCommandArgs gate: arguments typed after the command
  // close the palette entirely — a bare trailing space still shows it.
  const palette = useMemo(
    () => slashSuggestions(view.catalog.commands, inputText),
    [inputText, view.catalog.commands],
  )
  // The classic palette's selection and dismissal fold (useTypeahead): the
  // selection resets as the filtered list regenerates, and Esc/accept
  // remember the token so the panel stays hidden until the input changes.
  const [selectedSuggestion, setSelectedSuggestion] = useState(0)
  const [dismissedForToken, setDismissedForToken] = useState<string | null>(
    null,
  )
  const paletteOpen =
    palette.length > 0 &&
    !editingQueueId &&
    !pendingRequest &&
    paletteToken !== dismissedForToken
  const selectedSuggestionIndex = Math.min(
    selectedSuggestion,
    palette.length - 1,
  )
  useEffect(() => {
    setSelectedSuggestion(0)
  }, [paletteToken])
  const suggestionItems = useMemo<SuggestionItem[]>(
    () =>
      palette.map(item => ({
        id: `command-${item.value}`,
        // The classic's createCommandSuggestionItem: the matched alias
        // rides the display text in parentheses, never the insert.
        displayText: item.matchedAlias
          ? `${item.value} (${item.matchedAlias})`
          : item.value,
        description: item.detail,
      })),
    [palette],
  )
  // The classic's stable width from all commands (prevents layout shift
  // while filtering): longest command name + "/" + padding.
  const paletteMaxWidth = useMemo(() => {
    const names = view.catalog.commands.map(command =>
      command.name.replace(/^\//, ''),
    )
    return names.length === 0
      ? undefined
      : Math.max(...names.map(name => name.length)) + 6
  }, [view.catalog.commands])

  const acceptPalette = useCallback(() => {
    const item = palette[selectedSuggestionIndex]
    if (!item) return
    // applyCommandSuggestion's fill half: the command with a trailing
    // space, no execution — Tab only fills. The caret lands after the
    // space, ready for arguments.
    setInputText(`${item.value} `)
    setCursorOffset(item.value.length + 1)
    setDismissedForToken(paletteToken)
  }, [palette, selectedSuggestionIndex, paletteToken])

  const dismissPalette = useCallback(() => {
    setDismissedForToken(paletteToken)
  }, [paletteToken])

  // The classic's Enter-on-suggestion: apply, and execute in place when
  // the command runs without arguments (the catalog's runsDirectly —
  // everything but a prompt command with named arguments; the classic
  // reads type/argNames off the registry, the wire carries the verdict).
  const executePalette = useCallback(() => {
    const item = palette[selectedSuggestionIndex]
    if (!item) return
    setDismissedForToken(paletteToken)
    if (item.hint && item.runsDirectly === false) {
      setInputText(`${item.value} `)
      setCursorOffset(item.value.length + 1)
      return
    }
    historyRef.current.push(item.value)
    if (historyRef.current.length > 50) historyRef.current.shift()
    historyAtRef.current = -1
    void handleSubmit(item.value)
    setInputText('')
    setCursorOffset(0)
  }, [palette, selectedSuggestionIndex, paletteToken, handleSubmit])

  // NOTE: the classic routes the palette's up/down/tab/escape through the
  // keybinding system's Autocomplete context, but this component sits ABOVE
  // its own KeybindingSetup provider — useKeybindings in this body reads a
  // null context and silently no-ops (the trays work because they render
  // below it). The bespoke useInput handler below owns the palette keys
  // instead; in vim mode the engine owns the keys and Enter reaches the
  // selection through submitFromInput.

  // The history ring both composers share: the bespoke handler's arrows
  // and the vim engine's onHistoryUp/Down callbacks. Returns true when a
  // 'down' press found the cursor already at the live bottom — the classic's
  // onHistoryDown contract, whose true result enters the footer.
  const historyNav = useCallback(
    (direction: 'up' | 'down'): boolean => {
      const history = historyRef.current
      if (history.length === 0 || inputText.includes('\n')) {
        return direction === 'down'
      }
      let at = historyAtRef.current
      at =
        direction === 'up'
          ? at < 0
            ? history.length - 1
            : Math.max(0, at - 1)
          : at < 0
            ? at
            : Math.min(history.length - 1, at + 1)
      historyAtRef.current = at
      if (at >= 0) {
        setInputText(history[at]!)
        setCursorOffset(history[at]!.length)
      }
      return direction === 'down' && at < 0
    },
    [inputText],
  )

  // The vim engine's onChange — the classic PromptInput contract: '?' as
  // the whole value toggles the shortcuts help, every other change closes
  // it.
  const changeFromInput = useCallback((value: string) => {
    if (value === '?') {
      setHelpOpen(v => !v)
      return
    }
    setHelpOpen(false)
    setInputText(value)
  }, [])

  // The vim engine's submit — the bespoke handler's return branch minus
  // the key dispatch, which the engine owns.
  const submitFromInput = useCallback(
    (value: string) => {
      setHelpOpen(false)
      // The classic's Enter-on-suggestion: the palette routes the engine's
      // return through the selection too — the raw partial never submits.
      if (paletteOpen) {
        executePalette()
        return
      }
      const trimmed = value.trim()
      const submitText = trimmed ? value : (ghostText ?? '')
      if (ghostText && !trimmed) acceptSuggestion()
      if (submitText.trim()) {
        historyRef.current.push(submitText.trim())
        if (historyRef.current.length > 50) historyRef.current.shift()
        historyAtRef.current = -1
        void handleSubmit(submitText)
        setInputText('')
        setCursorOffset(0)
      }
    },
    [ghostText, acceptSuggestion, handleSubmit, paletteOpen, executePalette],
  )

  // A running-turn clock: starts on the transition into running, and a 1s
  // tick keeps the elapsed time and task durations fresh. The refs back the
  // classic SpinnerWithVerb — the viewer shows the REPL's own spinner, not
  // a text mimic, so it carries the same loading-start/length/timer inputs.
  const loadingStartTimeRef = useRef<number>(Date.now())
  const totalPausedMsRef = useRef(0)
  const pauseStartTimeRef = useRef<number | null>(null)
  const responseLengthRef = useRef(0)
  // The decode-window bounds (tok/s) are a per-request fact of the stream
  // itself, which runs session-side; the viewer's feed is the folded
  // response-length deltas, so the ref stays at its zeroed initial value
  // and the spinner simply withholds the rate line.
  const apiMetricsRef = useRef<StreamApiMetrics>({ seq: 0, baseline: 0 })
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

  // ── The task board, mirrored from the wire (remote attach only) ──────
  // The stream's todo rows ARE the session's task board (subject, status,
  // activeForm), and this mirror is what feeds a panel for a REMOTE
  // attach: that viewer has its own fresh AppState store, so the classic
  // spinner-hosted panel (SpinnerWithVerb renders one from `tasks` +
  // `expandedView`) sees an empty board and renders nothing. The host
  // viewer must NOT mount this mirror as well — the launcher shares the
  // session's store with it, so the spinner's internal store-driven panel
  // is live, and a second wire-fed copy grows a second row per task write
  // on its own schedule (store push vs wire todo event, ~40ms apart): the
  // pinned block shifts twice per write and the spinner title gets
  // rewritten twice per write — the blink this slot's classic single
  // mount avoids (tests/e2e/task-update-title-repaint guards it). When
  // this process hosts the session, the panel renders ONLY through the
  // spinner (busy) and TaskIdlePanel (idle), exactly like the classic REPL.
  // The mirror keeps its own auto-expand/all-completed-hide rules here
  // because a remote store never receives the session's store writes.
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

  const queued = queueRows(view.queue)
  // The classic input's queue hint, over the wire's pending commands (the
  // queue store is session-scoped — an attached UI consumes it over the
  // wire, never from the module). The wire lists prompt-mode commands only,
  // so editable = every non-meta row.
  const inputPlaceholder =
    inputText === '' && view.queue.some(command => !command.isMeta)
      ? 'Press up to edit queued messages'
      : undefined

  // Cursor-aware editing for the hand-rolled (non-vim) composer: the
  // classic engine (useTextInput's cursor) keeps the caret between
  // characters; these are that cursor's insert/delete/move halves over
  // the same state the vim engine drives.
  const cursorAt = Math.min(cursorOffset, inputText.length)
  const moveCursor = (offset: number) => {
    setCursorOffset(Math.max(0, Math.min(inputText.length, offset)))
  }
  const typeAtCursor = (chars: string) => {
    setInputText(
      inputText.slice(0, cursorAt) + chars + inputText.slice(cursorAt),
    )
    setCursorOffset(cursorAt + chars.length)
  }
  const backspaceAtCursor = () => {
    if (cursorAt === 0) return
    setInputText(inputText.slice(0, cursorAt - 1) + inputText.slice(cursorAt))
    setCursorOffset(cursorAt - 1)
  }
  // The engine's kill semantics (isKillKey): ctrl+w / meta+backspace cut
  // the word before the caret, ctrl+u the line before it, ctrl+k the rest
  // of the line; meta+delete kills the word ahead.
  const killWordBefore = () => {
    const lineStart = inputText.lastIndexOf('\n', cursorAt - 1) + 1
    const kept = inputText.slice(lineStart, cursorAt).replace(/[^\s]+\s*$/, '')
    setInputText(
      inputText.slice(0, lineStart) + kept + inputText.slice(cursorAt),
    )
    setCursorOffset(lineStart + kept.length)
  }
  const killWordAfter = () => {
    const rest = inputText.slice(cursorAt)
    const word = rest.replace(/^\s+/, '').match(/^\S+/)?.[0] ?? ''
    if (!word) return
    setInputText(inputText.slice(0, cursorAt) + rest.replace(word, ''))
  }
  const jumpWord = (direction: -1 | 1) => {
    if (direction === -1) {
      const skipped = inputText.slice(0, cursorAt).replace(/\s+$/, '')
      moveCursor(skipped.replace(/[^\s]+\s*$/, '').length)
    } else {
      const rest = inputText.slice(cursorAt)
      const lead = rest.length - rest.replace(/^\s+/, '').length
      const word = rest.slice(lead).match(/^\S+/)?.[0].length ?? 0
      moveCursor(cursorAt + lead + word)
    }
  }

  useInput(
    (input, key) => {
      if (!composerActive) return

      // The vim engine owns the editing keys (insert, return, escape,
      // arrows, ctrl combos) through its own useInput; only the
      // viewer-local hotkeys no engine mapping covers stay here. The
      // queue pair is empty-input-only so the engine's ctrl+e
      // (end-of-line) never races it.
      if (vimEnabled) {
        if (key.ctrl && inputText === '' && queued.length > 0) {
          const row = queued[0]!
          if (input === 'x') {
            void send(queueRemoveBody(row.id) as Record<string, unknown>)
            return
          }
          if (input === 'e') {
            setEditingQueueId(row.id)
            setInputText(row.text)
            setCursorOffset(row.text.length)
            return
          }
        }
        if (key.ctrl && (input === 'o' || input === 't')) {
          setShowInjectedContext(value => !value)
          return
        }
        return
      }

      // The classic input's '?' affordance: '?' as the whole value toggles
      // the shortcuts help; any other keypress, submit or backspace on the
      // empty line closes it (the classic closes on every value change).
      if (input === '?' && inputText === '') {
        setHelpOpen(v => !v)
        return
      }
      if (helpOpen) {
        if (key.return || key.backspace || key.delete) {
          setHelpOpen(false)
          if (key.return) return
        } else if (input.length > 0) {
          setHelpOpen(false)
        }
      }

      if (key.return) {
        // The classic's Enter-on-suggestion: while the palette is open the
        // partial input never submits raw — the selection applies instead.
        if (paletteOpen) {
          executePalette()
          return
        }
        // The classic's footer:openSelected — Enter on the tasks pill opens
        // the dialog (or the agent view the index points at). The binding
        // does not consume the key: TextInput's Enter fires in the same
        // keystroke, so the buffer still submits below — with the store
        // already flipped, an Enter that enters a view submits INTO it.
        if (footerItemSelected) {
          if (coordinatorTaskIndex === 0 && coordinatorTaskCount > 0) {
            exitAgentView(setAppState)
          } else if (selectedAgentTaskId) {
            enterAgentView(selectedAgentTaskId, setAppState)
          } else {
            setTasksDialog(true)
            selectFooterItem(null)
          }
        }
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
          setCursorOffset(0)
        }
        return
      }

      if (key.ctrl && (input === 'u' || input === 'k' || input === 'w')) {
        // The engine's kill keys, at the caret rather than the line end.
        if (input === 'w') killWordBefore()
        if (input === 'u') {
          const lineStart = inputText.lastIndexOf('\n', cursorAt - 1) + 1
          setInputText(
            inputText.slice(0, lineStart) + inputText.slice(cursorAt),
          )
          setCursorOffset(lineStart)
        }
        if (input === 'k') {
          const nextNewline = inputText.indexOf('\n', cursorAt)
          setInputText(
            nextNewline === -1
              ? inputText.slice(0, cursorAt)
              : inputText.slice(0, cursorAt) + inputText.slice(nextNewline),
          )
        }
        return
      }
      if (key.backspace || key.delete) {
        if (key.meta) {
          // The engine's Meta+Backspace/Delete: kill the adjacent word.
          if (key.backspace) killWordBefore()
          else killWordAfter()
        } else if (key.delete) {
          // Delete erases the character AT the caret; backspace cuts
          // the one before it. (The old handler only knew the line end.)
          if (cursorAt < inputText.length) {
            setInputText(
              inputText.slice(0, cursorAt) + inputText.slice(cursorAt + 1),
            )
          }
        } else {
          backspaceAtCursor()
        }
        return
      }

      if (key.escape) {
        // The classic's autocomplete:dismiss — the palette yields Esc to
        // the dismissal before anything else owns the key.
        if (paletteOpen) {
          dismissPalette()
          return
        }
        // The classic's agent-view Esc (useBackgroundTaskNavigation): a
        // running agent aborts its own work — the leader's turn is never
        // cancelled from a drill-down; a settled agent releases the view.
        // The pill focus clears in the same keystroke too: the classic's
        // keybindings never consume, so footer:clearSelection rides the
        // same Esc (the selection survives entering a view).
        if (viewingAgentTaskId) {
          const task = tasks[viewingAgentTaskId]
          if (
            task &&
            task.type === 'local_agent' &&
            task.status === 'running'
          ) {
            task.abortController?.abort()
          } else {
            exitAgentView(setAppState)
          }
          if (footerItemSelected) selectFooterItem(null)
          return
        }
        // The classic's footer:clearSelection — Esc drops the pill focus.
        if (footerItemSelected) {
          selectFooterItem(null)
          return
        }
        if (editingQueueId) {
          setEditingQueueId(null)
          setInputText('')
          setCursorOffset(0)
          return
        }
        if (isRunning) {
          cancel()
          return
        }
        // The classic's text-level double-Esc (useTextInput's
        // handleEscape): the first press arms the clear — "Esc again to
        // clear" for 1s — the second saves the line to history and clears.
        if (inputText !== '') {
          const now = Date.now()
          if (
            escClearArmedRef.current !== null &&
            now - escClearArmedRef.current <= 1000
          ) {
            escClearArmedRef.current = null
            setToast(null)
            if (inputText.trim() !== '') {
              historyRef.current.push(inputText.trim())
              if (historyRef.current.length > 50) historyRef.current.shift()
            }
            historyAtRef.current = -1
            setInputText('')
            setCursorOffset(0)
          } else {
            escClearArmedRef.current = now
            setToast('Esc again to clear')
            setTimeout(() => {
              if (escClearArmedRef.current === now) {
                escClearArmedRef.current = null
                setToast(null)
              }
            }, 1000)
          }
          return
        }
      }

      if (key.upArrow || key.downArrow) {
        // With the palette open, arrows move the selection (the classic's
        // Autocomplete context); the classic's handleHistoryUp gate falls
        // back to history when the list has 0 or 1 items.
        if (paletteOpen && palette.length > 1) {
          const direction = key.upArrow ? 'up' : 'down'
          setSelectedSuggestion(at =>
            direction === 'up'
              ? at <= 0
                ? palette.length - 1
                : at - 1
              : at >= palette.length - 1
                ? 0
                : at + 1,
          )
          return
        }
        // The classic's Footer context owns the arrows once a pill is
        // selected (its TextInput is inactive then): ↑ walks back through
        // the agent rows before leaving the pill, ↓ walks forward and
        // never leaves it — a ↓ past the last row opens the tasks dialog.
        if (footerItemSelected) {
          if (key.upArrow) {
            if (
              tasksSelected &&
              coordinatorTaskCount > 0 &&
              coordinatorTaskIndex > minCoordinatorIndex
            ) {
              setAppState(prev => ({
                ...prev,
                coordinatorTaskIndex: prev.coordinatorTaskIndex - 1,
              }))
            } else {
              navigateFooter(-1, true)
            }
          } else if (tasksSelected && coordinatorTaskCount > 0) {
            if (coordinatorTaskIndex < coordinatorTaskCount - 1) {
              setAppState(prev => ({
                ...prev,
                coordinatorTaskIndex: prev.coordinatorTaskIndex + 1,
              }))
            }
          } else if (tasksSelected) {
            setTasksDialog(true)
            selectFooterItem(null)
          } else {
            navigateFooter(1)
          }
          return
        }
        // History ring, newest first; only while the line is single-line.
        // At the live bottom a ↓ enters the footer (the classic's
        // handleHistoryDown → selectFooterItem(first)).
        if (key.downArrow && historyNav('down') && footerItems.length > 0) {
          selectFooterItem(footerItems[0]!)
          return
        }
        historyNav(key.upArrow ? 'up' : 'down')
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
          setCursorOffset(row.text.length)
          return
        }
      }

      if (key.ctrl && (input === 'o' || input === 't')) {
        // Expand/collapse the injected-context rows — the classic
        // transcript toggle, and the exact key the collapsed rows name.
        setShowInjectedContext(value => !value)
        return
      }

      if ((key.ctrl && input === 'a') || key.home) {
        // The engine's line-start (emacs ctrl+a); the queue-edit ctrl+e
        // above claims ctrl+e on an empty line first.
        moveCursor(0)
        return
      }
      if ((key.ctrl && input === 'e') || key.end) {
        moveCursor(inputText.length)
        return
      }
      if (key.leftArrow || key.rightArrow) {
        // The engine's cursor: arrows walk characters, Meta+arrows words.
        if (key.meta) jumpWord(key.leftArrow ? -1 : 1)
        else moveCursor(cursorAt + (key.leftArrow ? -1 : 1))
        return
      }
      if (key.ctrl || key.meta) return
      if (key.pageUp || key.pageDown) return
      if (key.tab) {
        // The classic's autocomplete:accept — Tab fills the selection.
        if (paletteOpen) {
          acceptPalette()
          return
        }
        return
      }

      // The classic's footer:close — with a pill selected the TextInput
      // still types (useInput has no focus gate), so the Footer context
      // only adds nav keys on top: 'x' stops/dismisses the selected agent
      // row — except when the row IS the viewed agent, where it types into
      // the steering input — and any other character lands in the buffer.
      if (footerItemSelected) {
        if (input === 'x' && tasksSelected && coordinatorTaskIndex >= 1) {
          const task = getVisibleAgentTasks(tasks)[coordinatorTaskIndex - 1]
          if (viewingAgentTaskId && task?.id === viewingAgentTaskId) {
            typeAtCursor('x')
            return
          }
          if (task) {
            stopOrDismissAgent(task.id, setAppState)
            if (task.status !== 'running') {
              setAppState(prev => ({
                ...prev,
                coordinatorTaskIndex: Math.max(
                  minCoordinatorIndex,
                  prev.coordinatorTaskIndex - 1,
                ),
              }))
            }
            return
          }
        }
        if (input) typeAtCursor(input)
        return
      }

      if (input) typeAtCursor(input)
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
  // The classic's spinnerActive includes viewedSubagentRunning: a running
  // agent on screen keeps the spinner up (SpinnerWithVerb reads the viewed
  // agent off the shared store itself), while the leader's own turn covers
  // the not-viewing case.
  const showSpinner = (isRunning || viewedAgentRunning) && !pendingRequest

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
            // The classic pane's one blank row above the banner:
            // FullscreenLayout's ScrollBox paddingTop={1}. The classic
            // collapses it once the user scrolls away (padCollapsed); the
            // viewer has no sticky-prompt header, so it stays pinned.
            paddingTop={1}
            stickyScroll
          >
            {/* Hosted launches mount the classic welcome banner — the
              process owns the session, so the banner's model/cwd lines
              describe what the classic REPL would show. A remote attach
              gets the one-line header instead. Hidden while an agent
              drill-down is on screen, the classic's hideLogo gate.
              The gap=1 wrapper matches MessagesBanner: LogoV2 returns a
              fragment, so without it the banner's children flatten into
              the ScrollBox directly and the classic's blank row between
              the banner and the debug notice (the wrapper's gap) is
              missing — one row short, the tray sits one row higher and
              the edit dialog's hint row lands where the classic's is
              clipped below the pane. */}
            {viewingAgentTaskId ? null : showWelcomeBanner ? (
              <Box flexDirection="column" gap={1}>
                <LogoV2 />
              </Box>
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

            {/* Transcript: the classic message components, fed from the wire.
              While an agent drill-down is on screen the transcript swaps to
              the agent's wire snapshot (keyed per agent, like the classic
              remounts Messages) and the rebuilt Session context row —
              main-session context — stays hidden. */}
            <AttachedTranscript
              key={viewingAgentTaskId ?? 'leader'}
              view={agentView ?? view}
              tools={tools}
              showInjectedContext={showInjectedContext}
              verbose={verbose}
              // The classic `Session context` row is rebuilt from the local
              // getUserContext() — honest only when this process is the host.
              showSessionContextRow={pid === process.pid && !viewingAgentTaskId}
              // The classic Messages.onItemClick hold: expanding a row keeps
              // the view instead of following the growth off the top.
              onBeforeExpand={holdScrollOnExpand}
            />

            {/* Streaming preview at the transcript tail. A tool-only draft
              renders NOTHING here — the in-flight cards are painted by
              the transcript bridge at the transcript tail, and mounting
              this row's separator for a body it does not have would add
              and drop a blank row on every draft/commit boundary (the
              classic streaming preview grows from the same rows it will
              commit into, so no separator churn exists there). Hidden in an
              agent drill-down — the classic's streamingText gate. */}
            {draft && !viewingAgentTaskId && (draft.thinking || draft.text) ? (
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
            {/* A blocking tray is up: the turn is still running, so the
              classic shows neither the spinner nor the idle panel in
              this slot — the overlay owns the bottom of the scroll
              content and the pane keeps its blank rows. */}
            {showSpinner ? (
              <SpinnerWithVerb
                mode={spinnerMode}
                loadingStartTimeRef={loadingStartTimeRef}
                totalPausedMsRef={totalPausedMsRef}
                pauseStartTimeRef={pauseStartTimeRef}
                responseLengthRef={responseLengthRef}
                apiMetricsRef={apiMetricsRef}
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
            ) : pendingRequest ? null : isLocalHost ? (
              // The classic's idle swap, via the classic component: the
              // standalone headered panel takes the spinner's
              // bottom-anchored slot when the spinner unmounts, reading
              // the session's (shared) store — same store, same frame the
              // REPL's TaskIdlePanel decision happens on.
              <TaskIdlePanel />
            ) : (
              panelVisible && (
                // Remote attach: the wire mirror stands in for the store
                // the viewer does not share (see the board comment).
                <TaskList tasks={boardTasks} isStandalone />
              )
            )}
            {!isLocalHost && showSpinner && panelVisible && (
              // Remote attach busy-time panel: FLUSH under the spinner
              // row, no header. The host's busy-time panel is mounted
              // INSIDE SpinnerWithVerb from the shared store — the
              // classic single mount; a second wire-fed copy here
              // would grow the block twice per task write.
              <TaskPanelRows tasks={boardTasks} />
            )}
            {/* The classic's queued-command display (PromptInputQueued
              Commands' rows, last child of the scroll content exactly
              where FullscreenLayout mounts it) — fed from the wire's
              pending commands, the attached-UI source for the
              session-scoped queue. Same synthetic user-message rows
              through the same Message dispatch, so the preview is the
              classic pane's. Hidden in an agent drill-down, exactly where
              PromptInputQueuedCommands hides. */}
            {!viewingAgentTaskId && (
              <ViewerQueuedCommands commands={view.queue} />
            )}

            {/* Blocking request trays, mounted INSIDE the scroll content
              like FullscreenLayout's overlay — classic renders
              PermissionRequest below the messages in the same ScrollBox
              (scroll up to re-read context while a dialog is up), and
              PromptInput returns null behind it, so the dock below is
              hidden while anything is pending. No wrapper inset: the
              mirrored dialogs size themselves against the terminal. */}
            {pendingRequest && isConnected && (
              <ViewerErrorBoundary label="Permission tray">
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
              </ViewerErrorBoundary>
            )}
          </ScrollBox>
          {!tasksDialog &&
            !showLocalDialog &&
            !viewingAgentTaskId &&
            pillVisible && (
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

        {/* Queued prompts and background tasks. The task board does not
          live here — it renders as the classic task panel, spinner-slot
          busy-time and standalone at idle, above. Hidden while a local
          dialog or a blocking tray owns the bottom of the screen, like
          PromptInput returning null behind the REPL's modal, and in an
          agent drill-down — the classic's queued-rows gate. */}
        {isConnected &&
          !tasksDialog &&
          !showLocalDialog &&
          !pendingRequest &&
          !viewingAgentTaskId &&
          view.tasks.length > 0 && (
            <Box flexShrink={0} flexDirection="column" paddingX={2}>
              {/* Queued prompts no longer render here: the classic's own
                PromptInputQueuedCommands shows them in the scroll content
                above, reading the shared queue. */}
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
            bottom of the screen or a blocking tray takes the keys, like
            PromptInput returning null behind the REPL's modal. */}
        {isConnected && !tasksDialog && !showLocalDialog && !pendingRequest && (
          <Box flexShrink={0} flexDirection="column" marginTop={1}>
            {/* The /buddy teaser, painted exactly like the classic's
                notification row: position=absolute takes zero layout
                height, marginTop=-1 pulls it into the gap row above the
                divider, height=1 + overflow=hidden clip it to one row. */}
            {buddyTeaser && (
              <Box
                position="absolute"
                marginTop={-1}
                height={1}
                width="100%"
                paddingLeft={2}
                paddingRight={1}
                flexDirection="column"
                alignItems="flex-end"
                justifyContent="flex-end"
                overflow="hidden"
              >
                <Text wrap="truncate">
                  <RainbowTeaser text="/buddy" />
                </Text>
              </Box>
            )}
            {/* The classic's agent banner (PromptInput's agentBanner
              branch): while a drill-down is on screen the input's frame
              rules go the agent's color and the top rule carries the
              @name chip. */}
            {agentBanner ? (
              <Text color={agentBanner.bgColor}>
                {agentBanner.text ? (
                  <>
                    {'─'.repeat(
                      Math.max(0, columns - stringWidth(agentBanner.text) - 4),
                    )}
                    <Text
                      backgroundColor={agentBanner.bgColor}
                      color="inverseText"
                    >
                      {' '}
                      {agentBanner.text}{' '}
                    </Text>
                    {'──'}
                  </>
                ) : (
                  '─'.repeat(columns)
                )}
              </Text>
            ) : (
              <Text color="promptBorder">{'─'.repeat(columns)}</Text>
            )}
            {pendingRequest ? (
              <Box marginLeft={2}>
                <Text dimColor>Waiting for permission…</Text>
              </Box>
            ) : (
              <Box flexDirection="row">
                {/* The separator after the glyph is a non-breaking space,
                    like the classic PromptChar's `&nbsp;` — a plain
                    space is trailing whitespace the renderer trims, and
                    the classic pane keeps the extra cell. */}
                {/* The classic PromptChar: the theme's default text color
                    (no accent), dimmed while the turn loads — the viewed
                    agent's color while its banner is up. */}
                <Text
                  color={agentBanner ? agentBanner.bgColor : undefined}
                  dimColor={isRunning || turnStarting}
                >
                  {editingQueueId ? '✎\u00A0' : '❯\u00A0'}
                </Text>
                {vimEnabled ? (
                  // The classic's own vim engine, wired like PromptInput's
                  // baseProps: the same INSERT/NORMAL keymap, the same
                  // placeholder, the same ctrl+c/ctrl+d double-press exit.
                  // Editing keys are its useInput's, which is why the
                  // handler above stands down while it is mounted.
                  <Box flexGrow={1} flexShrink={1}>
                    <VimTextInput
                      value={inputText}
                      onChange={changeFromInput}
                      onSubmit={submitFromInput}
                      onExit={doExit}
                      onExitMessage={(show, keyName) =>
                        setEngineExit({
                          pending: show,
                          keyName: keyName ?? null,
                        })
                      }
                      onHistoryUp={() => historyNav('up')}
                      onHistoryDown={() => historyNav('down')}
                      onHistoryReset={() => {
                        historyAtRef.current = -1
                      }}
                      placeholder={inputPlaceholder ?? undefined}
                      focus={composerActive && inputFocused}
                      showCursor
                      multiline
                      columns={columns - 3}
                      cursorOffset={cursorOffset}
                      onChangeCursorOffset={setCursorOffset}
                      disableCursorMovementForUpDownKeys={palette.length > 0}
                      disableEscapeDoublePress={palette.length > 0}
                      initialMode={vimMode}
                      onModeChange={setVimMode}
                    />
                  </Box>
                ) : inputText ? (
                  <>
                    <Text>{inputText.slice(0, cursorAt)}</Text>
                    {/* The engine's caret: the inverse cell sits between
                        the text before and after the cursor, and an
                        unfocused input paints none — like the classic's
                        focus gate on the TextInput. */}
                    {inputFocused ? <Text inverse> </Text> : null}
                    <Text>{inputText.slice(cursorAt)}</Text>
                    {argumentHint && (
                      // The classic's showArgumentHint: a bare slash
                      // command with a hint renders the hint dim after
                      // the cursor until arguments are typed.
                      <Text dimColor>
                        {inputText.endsWith(' ') ? '' : ' '}
                        {argumentHint}
                      </Text>
                    )}
                  </>
                ) : inputPlaceholder ? (
                  // The classic input's queue-hint placeholder, rendered
                  // through the classic's own renderPlaceholder helper —
                  // cursor on the first character (chalk inverse), the
                  // rest chalk-dim. The helper's SGR-dim bytes are what
                  // the classic pane emits; ink's theme-gray dimColor is
                  // a different escape sequence for the same look.
                  <Text wrap="truncate">
                    <Ansi>
                      {renderPlaceholder({
                        placeholder: inputPlaceholder,
                        value: inputText,
                        showCursor: inputFocused,
                        focus: inputFocused,
                        terminalFocus: inputFocused,
                      }).renderedPlaceholder ?? ''}
                    </Ansi>
                  </Text>
                ) : ghostText ? (
                  // The suggestion ghost: cursor first, dim suggestion
                  // after it — the classic input row with a placeholder.
                  <>
                    {inputFocused ? <Text inverse> </Text> : null}
                    <Text dimColor>
                      {ghostText.slice(0, Math.max(0, columns - 4))}
                    </Text>
                  </>
                ) : inputFocused ? (
                  <Text inverse> </Text>
                ) : null}
              </Box>
            )}
            {/* The banner's bottom rule: the agent's color while the banner
              is up, the frame color otherwise — the classic's closing rule
              of the same branch. */}
            <Text color={agentBanner ? agentBanner.bgColor : 'promptBorder'}>
              {'─'.repeat(columns)}
            </Text>
            {editingQueueId && (
              <Box paddingX={2}>
                <Text dimColor>
                  editing a queued command — Enter saves, Esc discards
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
            {/* One bottom line, like the classic pane: the classic footer's
                own left-side component (mode label, spinner hints, tasks
                pill), reading the same store and keybindings the REPL's
                does — then the coordinator agent panel rows below it, the
                way PromptInputFooter mounts CoordinatorTaskPanel. */}
            <AttachedBottomBar
              meta={view.meta}
              running={isRunning || turnStarting}
              suppressHint={
                (isLocalHost && statusLine.suppressHint) || inputText.length > 0
              }
              statusLine={isLocalHost ? statusLine.node : null}
              exitPending={exitState.pending || engineExit.pending}
              exitKeyName={
                engineExit.pending ? engineExit.keyName : exitState.keyName
              }
              isLocalHost={isLocalHost}
              helpOpen={helpOpen}
              vimMode={vimEnabled ? vimMode : undefined}
              tasksSelected={tasksSelected}
              onOpenTasksDialog={() => setTasksDialog(true)}
            />
            {/* The classic's suggestion overlay: floats over the scroll
                content above the prompt — the same absolute box
                FullscreenLayout portals the REPL's palette through. Last
                sibling so it paints over the notification rows, like the
                classic's portaled overlay does. */}
            {paletteOpen && (
              <Box
                position="absolute"
                bottom="100%"
                left={0}
                right={0}
                paddingX={2}
                paddingY={1}
                flexDirection="column"
                opaque
              >
                <PromptInputFooterSuggestions
                  suggestions={suggestionItems}
                  selectedSuggestion={selectedSuggestionIndex}
                  maxColumnWidth={paletteMaxWidth}
                  overlay
                />
              </Box>
            )}
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
                <BackgroundTasksDialog onDone={() => setTasksDialog(false)} />
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
                <ViewerErrorBoundary label="Dialog">
                  {localDialog.jsx}
                </ViewerErrorBoundary>
              </Box>
            </Box>
          </ModalContext>
        )}

        {/* The classic layout's bottomFloat: the companion's reaction
            bubble, absolute at the pane's bottom-right over whatever the
            dock shows, reading companionReaction off the shared store —
            null (no reaction, no companion, muted) the same way. */}
        <Box position="absolute" bottom={0} right={0} opaque>
          <CompanionFloatingBubble />
        </Box>
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

/** The classic's queued-command preview rows over the wire's pending
 * commands — the attached-UI twin of PromptInputQueuedCommands, which
 * reads the session-scoped queue store this process cannot see. */
function ViewerQueuedCommands({
  commands,
}: {
  commands: WirePendingCommand[]
}): React.ReactNode {
  const messages = useMemo(() => {
    const visible = commands.filter(command => !command.isMeta)
    if (visible.length === 0) return null
    return normalizeMessages(
      visible.map(command => createUserMessage({ content: command.text })),
    )
  }, [commands])
  if (messages === null) return null
  return (
    <Box marginTop={1} flexDirection="column">
      {messages.map((message, i) => (
        <QueuedMessageProvider key={i} isFirst={i === 0}>
          <Message
            message={message}
            lookups={EMPTY_LOOKUPS}
            addMargin={false}
            tools={[]}
            commands={[]}
            verbose={false}
            inProgressToolUseIDs={EMPTY_SET}
            progressMessagesForMessage={[]}
            shouldAnimate={false}
            shouldShowDot={false}
            isTranscriptMode={false}
            isStatic={true}
            width="100%"
          />
        </QueuedMessageProvider>
      ))}
    </Box>
  )
}

function AttachedBottomBar({
  meta,
  running,
  suppressHint,
  exitPending,
  exitKeyName,
  isLocalHost,
  helpOpen,
  vimMode,
  statusLine,
  tasksSelected,
  onOpenTasksDialog,
}: {
  meta: WireSessionMeta | null
  running: boolean
  /** True when a displayed statusline owns the footer or input is in
   *  flight — classic footer behavior: the `? for shortcuts` hint yields
   *  to the user's own line and to typing. */
  suppressHint: boolean
  exitPending: boolean
  exitKeyName: string | null
  isLocalHost: boolean
  /** The shortcuts help replaces the footer's whole left side, like
   *  PromptInputFooter's helpOpen branch. */
  helpOpen: boolean
  /** The vim engine's mode while editorMode is vim, else undefined —
   *  PromptInputFooter's exact gate: no editor, no indicator. */
  vimMode: VimMode | undefined
  /** The tasks pill's focus, from the shared store's footerSelection —
   *  the same prop PromptInputFooter passes in the REPL. */
  tasksSelected: boolean
  /** The statusline row node, mounted inside this padded column like
   *  PromptInputFooter mounts StatusLine above FooterLeftSide — both
   *  rows share the footer's paddingX so they align. */
  statusLine: React.ReactNode
  onOpenTasksDialog: () => void
}): React.ReactNode {
  if (!meta) return null

  if (helpOpen) {
    return (
      <PromptInputHelpMenu dimColor={true} fixedWidth={true} paddingX={2} />
    )
  }

  return (
    <>
      <Box paddingX={2} flexDirection="column">
        {/* PromptInputFooter's gate: no statusline while the exit
            double-press message is up (mode is always 'prompt' here). */}
        {statusLine && !exitPending && <Box flexShrink={0}>{statusLine}</Box>}
        <PromptInputFooterLeftSide
          exitMessage={{ show: exitPending, key: exitKeyName ?? undefined }}
          vimMode={vimMode}
          mode="prompt"
          // ModeIndicator reads only the mode off the context; the wire's
          // permissionMode is the same enum the classic carries there.
          toolPermissionContext={
            { mode: meta.permissionMode } as ToolPermissionContext
          }
          suppressHint={suppressHint}
          isLoading={running}
          tasksSelected={tasksSelected}
          isSearching={false}
          historyQuery=""
          setHistoryQuery={() => {}}
          historyFailedMatch={false}
          onOpenTasksDialog={onOpenTasksDialog}
        />
      </Box>
      {/* The agent panel rows, exactly where PromptInputFooter mounts
          them — same gate (coordinator mode or the setting), same shared
          store, so the rows and their eviction tick are the classic's. */}
      {isLocalHost &&
        (isCoordinatorMode() || getInitialSettings().showAgentPanel) && (
          <CoordinatorTaskPanel />
        )}
    </>
  )
}
