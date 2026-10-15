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
import type { LocalDialog, LocalDialogStore } from '../session/localDialogs.js'
import {
  NewMessagesPill,
  isJumpToBottomVisible,
  SuggestionsOverlay,
  DialogOverlay,
} from '../components/FullscreenLayout.js'
import { PromptOverlayProvider } from '../context/promptOverlayContext.js'
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
import { IDLE_SPECULATION_STATE } from '../state/AppStateStore.js'
import type { Message as MessageType } from '../types/message.js'
import { addToHistory as appendHistory } from '../history.js'
import { AssistantThinkingMessage } from '../components/messages/AssistantThinkingMessage.js'
import { AssistantTextMessage } from '../components/messages/AssistantTextMessage.js'
import { getAllBaseTools } from '../tools.js'
import type { ToolPermissionContext, Tools } from '../Tool.js'
import { exitAgentView } from '../state/agentViewHelpers.js'
import { isLocalAgentTask } from '../tasks/LocalAgentTask/LocalAgentTask.js'
import { BackgroundTasksDialog } from '../components/tasks/BackgroundTasksDialog.js'
import { ModalContext } from '../context/modalContext.js'
import { rpcBody } from '../webui/client/composerViews.js'
import PromptInput from '../components/PromptInput/PromptInput.js'
import { useReplInput } from '../hooks/repl/useReplInput.js'
import { useApiKeyVerification } from '../hooks/useApiKeyVerification.js'
import type { Command } from '../commands.js'
import type { AgentDefinition } from '../tools/AgentTool/loadAgentsDir.js'
import type { ComposerHost } from '../components/PromptInput/composerHost.js'
import type { PromptInputHelpers } from '../utils/handlePromptSubmit.js'
import { getNextPermissionMode } from '../utils/permissions/getNextPermissionMode.js'
import { logForDebugging } from '../utils/debug.js'
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

// useReplInput's background-PR-intercept hook: a REPL affordance this
// viewer has no part of.
const NO_BG_PR_INTERCEPT = (_prev: string, _next: string): boolean => false

// The composer's `messages` prop for a wire-fed host: the array is not
// what the composer reads on this surface — transcriptFacts carries the
// honest facts (see the mount site) and the footer's message-derived
// stats (StatusLine cache counters) have no local transcript to walk.
const NO_MESSAGES: MessageType[] = []

// Stable empty agent list for a remote attach (agents are a palette
// input; a fresh array identity would churn it every render).
const EMPTY_AGENTS: AgentDefinition[] = []

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
  /**
   * The real command registry / agent definitions, when this process
   * assembled them (the hosted launcher's session defaults). The classic
   * palette consumes these whole; without them (remote attach) the viewer
   * projects the wire catalog's metadata instead, which lacks the
   * registry's richer help text and argument completions.
   */
  commands?: Command[]
  agents?: AgentDefinition[]
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
  commands: commandsProp,
  agents: agentsProp,
  onExit,
}: AttachedSessionProps): React.ReactNode {
  const store = useMemo(() => createViewStore(), [])
  const view = useWireStore(store)
  // Live store reads (an Enter that flips the agent view in the same
  // keystroke must steer from the store, not this render's closure).
  const appStateStore = useAppStateStore()
  const setAppState = useSetAppState()
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
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
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
  // The classic composer's input-local state: the host-agnostic REPL
  // input store (useReplInput) owns the buffer, pastes, vim mode,
  // history-search and help-menu flags and the submit counter, exactly
  // as it does in the REPL. The viewer needs a transcript repin hook
  // and nothing else session-side: typing while scrolled away re-pins
  // the view like the classic's.
  const repinScroll = useCallback(() => {
    scrollRef.current?.scrollToBottom()
    dividerYRef.current = null
  }, [])
  const lastUserScrollTsRef = useRef(0)
  const composer = useReplInput({
    repinScroll,
    lastUserScrollTsRef,
    recentScrollRepinWindowMs: 1000,
    trySuggestBgPRIntercept: NO_BG_PR_INTERCEPT,
  })
  const { status: apiKeyStatus } = useApiKeyVerification()
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

  // The wire ComposerHost: every REPL-owned closure the classic composer
  // reaches for (see components/PromptInput/composerHost.ts) mapped onto
  // a verb of this surface. Input-local state (buffer, history index,
  // footer selection, palette) never crosses here — the component owns
  // it, which is the whole point of the seam.
  const composerHost = useMemo<ComposerHost>(() => {
    // The classic clears the buffer synchronously at accept time
    // (useReplSubmission's onSubmit clears before dispatch;
    // handlePromptSubmit does the same on its queue path). A clear
    // trailing the wire round-trip writes '' blind and stomps text typed
    // while send() was in flight — so both submit halves call this
    // before their first await.
    const clearAtAccept = (helpers: PromptInputHelpers): void => {
      composer.setInputValue('')
      composer.setPastedContents({})
      helpers.clearBuffer()
      helpers.resetHistory()
      helpers.setCursorOffset(0)
    }
    return {
      submit: async (input, helpers, speculationAccept) => {
        if (speculationAccept) {
          // Speculation is session-scoped: the speculative turn lives in
          // the session's own query loop and its adoption happens there
          // (or not at all, when the session discards it). The viewer's
          // half is to stop painting the ghost: clear the store fields
          // that drive it and send the accepted text as a plain prompt.
          setAppState(prev => ({
            ...prev,
            promptSuggestion: {
              text: null,
              promptId: null,
              shownAt: 0,
              acceptedAt: 0,
              generationRequestId: null,
            },
            speculation: IDLE_SPECULATION_STATE,
          }))
        }
        clearAtAccept(helpers)
        // /tasks is a local dialog, not a turn: when this process IS the
        // session's, the viewer mounts the classic BackgroundTasksDialog
        // itself — the session's task state and output files are right
        // here, no wire round-trip (and no dropped JSX) needed. A remote
        // attach falls through to the session, which replies as before.
        const trimmed = input.trim()
        const word = trimmed.split(/\s/)[0] ?? ''
        if (isLocalHost && trimmed === '/tasks') {
          setTasksDialog(true)
        } else if (word === '/compact' || word === '/clear') {
          // /compact and /clear render nothing when the host runs them,
          // so the viewer sends those two as rpc — the same buttons the
          // browser has.
          await send(
            rpcBody(word === '/compact' ? 'compact' : 'clear') as Record<
              string,
              unknown
            >,
          )
        } else {
          // The classic records the submitted line in the shared history
          // file (handlePromptSubmit's half; the composer's arrows read
          // it back through useArrowKeyHistory, same file, same process).
          if (trimmed) appendHistory(input)
          // The human-message backstop the classic REPL runs on submit:
          // re-pin the transcript and clear the unseen-divider snapshot.
          repinScroll()
          markTurnStarting()
          composer.setSubmitCount(s => s + 1)
          await send({
            kind: 'prompt',
            content: input,
            delivery: 'next',
            commandId: randomUUID(),
            sessionEpoch: view.meta?.sessionEpoch ?? 0,
          } as Record<string, unknown>)
        }
      },
      submitToAgent: async (input, target, helpers) => {
        // The composer already resolved the steering target from the
        // live store (getActiveAgentForInput); the wire prompt carries
        // the agent id and the session's queue routes it, so no local
        // task lookup is needed here.
        repinScroll()
        clearAtAccept(helpers)
        await send({
          kind: 'prompt',
          content: input,
          delivery: 'next',
          commandId: randomUUID(),
          sessionEpoch: view.meta?.sessionEpoch ?? 0,
          agentId: target.id,
        })
      },
      prefetchAttachments: () => {
        // The keystroke prefetch of the @-mention/MCP/agent attachment
        // trio warms the prompt pipeline — which runs session-side,
        // where its own submits warm their own caches. Nothing for the
        // viewer to pre-warm over the wire.
      },
      cyclePermissionMode: ctx => {
        // Compute the next mode locally (pure over the context the
        // footer already renders) and ask the session to transition.
        // The session's mode_set handler performs the transition on the
        // shared store and republishes meta — the same route the
        // browser's mode button takes (webui Shell.tsx) — so the viewer
        // never writes the session's permission state directly.
        logForDebugging(
          `[attached] cyclePermissionMode: currentMode=${ctx.mode}`,
        )
        const nextMode = getNextPermissionMode(ctx)
        void clientRef.current?.command('mode', {
          kind: 'mode_set',
          mode: nextMode,
        })
      },
    }
  }, [
    send,
    view.meta,
    isLocalHost,
    setAppState,
    markTurnStarting,
    repinScroll,
    composer.setInputValue,
    composer.setPastedContents,
    composer.setSubmitCount,
  ])

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

  // Ctrl+C/D double-press exit stays viewer-local while the classic
  // composer is unmounted (connecting, disconnected, a dialog or a tray
  // owns the keys). While it is mounted the classic engine's own
  // onExitMessage paints the footer's double-press row — the REPL has
  // no outer exit hook either — and ctrl+c during a running turn rides
  // this hook's interrupt branch, the counterpart of the classic's
  // CancelRequestHandler app:interrupt.
  useExitOnCtrlCDWithKeybindings(
    doExit,
    () => {
      if (view.meta?.state === 'running' && clientRef.current) {
        cancel()
        return true
      }
      return false
    },
    !composerActive,
  )

  // What the classic composer's session-state props hold in the REPL,
  // read where this process can honestly source them.
  const storeToolPermissionContext = useAppState(s => s.toolPermissionContext)
  const mcpClients = useAppState(s => s.mcp.clients)
  // Remote attach: the viewer does not share the session's store, so
  // the wire's permissionMode — the same enum the classic carries in
  // the context — is what the ModeIndicator can honestly show.
  const toolPermissionContext = isLocalHost
    ? storeToolPermissionContext
    : view.meta
      ? ({ mode: view.meta.permissionMode } as ToolPermissionContext)
      : storeToolPermissionContext
  const setToolPermissionContext = useCallback(
    (ctx: ToolPermissionContext) => {
      // The session owns its permission state; cyclePermissionMode
      // routes changes through mode_set and the session republishes.
      // This write only refreshes the viewer's own display copy.
      setAppState(prev => ({ ...prev, toolPermissionContext: ctx }))
    },
    [setAppState],
  )
  // The real registry when this process assembled it (hosted); a remote
  // attach projects the wire catalog's metadata — the palette reads
  // name/aliases/description/argumentHint only, and execution rides the
  // wire submit regardless of what the suggestion object carries.
  const commands = useMemo<Command[]>(
    () =>
      commandsProp ??
      (view.catalog.commands.map(command => ({
        type: 'local',
        name: command.name,
        description: command.description ?? '',
        argumentHint: command.argHint,
        aliases: command.aliases,
      })) as unknown as Command[]),
    [commandsProp, view.catalog.commands],
  )
  const agents = agentsProp ?? EMPTY_AGENTS
  // Transcript facts the composer asks for in place of the Message[]
  // array it does not hold: the wire's projected rows are the truth
  // here (row count for the Esc-ladder and footer gates, an assistant
  // row for the thinking-toggle, no paste-ids on the wire projection).
  const transcriptFacts = useMemo(
    () => ({
      messageCount: view.order.length,
      maxPasteId: 0,
      hasAssistantMessage: view.order.some(
        id => view.items.get(id)?.kind === 'assistant',
      ),
    }),
    [view.order, view.items],
  )
  const conversationId = `${sessionId ?? pid}:${view.meta?.sessionEpoch ?? 0}`

  // The pill's Enter opens the classic tasks dialog through
  // showBashesDialog (PromptInput's handleOpenTasksDialog); this viewer
  // owns the dialog slot, so the flag is routed to it and reset.
  useEffect(() => {
    if (!composer.showBashesDialog) return
    composer.setShowBashesDialog(false)
    if (isLocalHost) setTasksDialog(true)
  }, [composer.showBashesDialog, composer.setShowBashesDialog, isLocalHost])

  // The prompt-suggestion ghost: the session's stop-hook fork writes
  // AppState.promptSuggestion.text into the shared store (the query loop
  // runs session-side) and the mounted PromptInput paints it like the
  // classic input paints its placeholder. What the classic host's
  // usePromptSuggestion would do — mark the suggestion as shown once
  // the input actually displays it (telemetry and empty-Enter accept
  // both gate on shownAt) — this viewer does here, with the same
  // visibility gate usePromptSuggestion applies.
  const suggestionText = useAppState(s => s.promptSuggestion.text)
  const suggestionVisible =
    suggestionText !== null &&
    composer.inputValue === '' &&
    composer.inputMode === 'prompt' &&
    !isRunning &&
    !turnStarting
  useEffect(() => {
    if (!suggestionVisible) return
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
  }, [suggestionVisible, setAppState])

  // ─── Agent drill-down state (the transcript half) ─────────────────────
  // The footer's pill/panel selection, its clamp effects and the agent
  // banner all live inside the mounted PromptInput now — they drive and
  // read the same shared store the REPL's do. What stays here is only
  // what the transcript and the Esc fallback read.
  const tasks = useAppState(s => s.tasks)
  const viewingAgentTaskId = useAppState(s => s.viewingAgentTaskId)
  // The classic's viewed-agent derivation (REPL.tsx): the local_agent whose
  // transcript is on screen, if any.
  const viewedTask = viewingAgentTaskId ? tasks[viewingAgentTaskId] : undefined
  const viewedAgentTask =
    viewedTask && isLocalAgentTask(viewedTask) ? viewedTask : undefined
  const viewedAgentRunning = viewedAgentTask?.status === 'running'

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

  // The slash palette, its selection/dismissal fold, the argument hint
  // and the history ring all live inside the mounted PromptInput now —
  // the real useTypeahead over the real command registry, keyed by the
  // real useArrowKeyHistory. Nothing bespoke remains to own those keys.

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

  // The minimal key fallback for what the mounted composer's own engine
  // does not own (its useInput covers editing, the palette, the footer
  // pill, the help menu, history search, double-Esc clear and its own
  // ctrl+c/ctrl+d double-press exit): the agent-drill-down and
  // running-turn Esc cancels, the empty Shift+Enter steering interrupt,
  // and the injected-context toggle the collapsed rows name. The
  // classic REPL rides its CancelRequestHandler and
  // useBackgroundTaskNavigation keybindings here; those are wired to
  // the REPL's local abort controller and confirm queue, while cancel
  // is a wire verb on this surface, so a plain input listener stands in.
  useInput(
    (input, key) => {
      if (!composerActive) return
      if (key.escape) {
        // The classic's agent-view Esc (useBackgroundTaskNavigation): a
        // running agent aborts its own work — the leader's turn is never
        // cancelled from a drill-down; a settled agent releases the view.
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
          return
        }
        if (isRunning) {
          cancel()
          return
        }
        return
      }
      if (
        key.return &&
        key.shift &&
        isRunning &&
        composer.inputValue.trim() === ''
      ) {
        // Steer: an empty Shift+Enter is the browser's interrupt affordance.
        cancel()
        return
      }
      if (key.ctrl && (input === 'o' || input === 't')) {
        // Expand/collapse the injected-context rows — the classic
        // transcript toggle, and the exact key the collapsed rows name.
        setShowInjectedContext(value => !value)
      }
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

        {/* Composer — the classic dock component: frame rules, agent
            banner, input engine, slash overlay, footer (statusline, mode
            label, tasks pill, agent panel rows, help menu) — the same
            PromptInput the REPL mounts, reading the shared store, with
            session-side actions riding the wire ComposerHost above. The
            queued-command preview rows stay in the scroll content (the
            classic PromptInputQueuedCommands' position); the input's
            queue-editing affordance degrades on a remote attach, where
            the session-scoped queue module behind it is invisible (the
            wire rows above are its read-only mirror). Hidden while a
            local dialog owns the bottom of the screen or a blocking tray
            takes the keys, like PromptInput returning null behind the
            REPL's modal. */}
        {composerActive && (
          // The prompt-overlay portal pair the classic FullscreenLayout
          // owns: CommandPalette publishes its suggestion list through
          // this context and PromptInput's dialog slot likewise — without
          // the provider+overlay mount the palette computes suggestions
          // but nothing renders them. Same dock anchoring as the classic
          // (overlays are the dock column's first children).
          <PromptOverlayProvider>
            <Box flexShrink={0} flexDirection="column" marginTop={1}>
              <SuggestionsOverlay />
              <DialogOverlay />
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
              <PromptInput
                debug={false}
                ideSelection={undefined}
                host={composerHost}
                toolPermissionContext={toolPermissionContext}
                setToolPermissionContext={setToolPermissionContext}
                apiKeyStatus={apiKeyStatus}
                commands={commands}
                agents={agents}
                isLoading={isRunning || turnStarting}
                onExit={doExit}
                verbose={verbose}
                messages={NO_MESSAGES}
                transcriptFacts={transcriptFacts}
                input={composer.inputValue}
                onInputChange={composer.setInputValue}
                mode={composer.inputMode}
                onModeChange={composer.setInputMode}
                stashedPrompt={composer.stashedPrompt}
                setStashedPrompt={composer.setStashedPrompt}
                submitCount={composer.submitCount}
                onShowMessageSelector={() => {}}
                mcpClients={mcpClients}
                pastedContents={composer.pastedContents}
                setPastedContents={composer.setPastedContents}
                vimMode={composer.vimMode}
                setVimMode={composer.setVimMode}
                showBashesDialog={composer.showBashesDialog}
                setShowBashesDialog={composer.setShowBashesDialog}
                isSearchingHistory={composer.isSearchingHistory}
                setIsSearchingHistory={composer.setIsSearchingHistory}
                helpOpen={composer.isHelpOpen}
                setHelpOpen={composer.setIsHelpOpen}
                insertTextRef={composer.insertTextRef}
                conversationId={conversationId}
              />
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
            </Box>
          </PromptOverlayProvider>
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
