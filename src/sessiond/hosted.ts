/**
 * An in-process hosted session — the unit sessiond hosts N of.
 *
 * One `HostedSession` binds together the pieces a single-session process
 * wires implicitly: a private session scope (`newSessionState`, so every
 * `getSessionId()`-style accessor inside a turn resolves to this session),
 * a private AppState store, a `SessionCore` that runs each turn inside that
 * scope, a wire `SessionChannel` carrying the session's own request broker,
 * and the framework-free input chain (`handlePromptSubmit` →
 * `processUserInput` → `core.submitTurn`) that the TUI and the queue
 * processor share.
 *
 * Submissions go through the session's command queue even in-process: a
 * busy session parks fresh prompts (core.submitTurn enqueues on busy) and
 * the drain picks them up at turn end, so an HTTP submit never races the
 * loop. Permission asks open on the session's broker — the same single
 * ask/race site every host uses — so a request stays open when nobody is
 * attached rather than auto-denying.
 *
 * This module must not import react/ink: what the TUI passes from render
 * state arrives as plain values or no-ops here.
 */

import { randomUUID, type UUID } from 'crypto'
import type { SessionId } from '../types/ids.js'
import type { ToolPermissionContext } from '../Tool.js'
import {
  getCwdState,
  newSessionState,
  runInSessionScope,
  getSessionId,
  setMainLoopModelOverride,
  getTotalCostUSD,
  getTotalLinesAdded,
  getTotalLinesRemoved,
  type SessionState,
} from '../bootstrap/state.js'
import {
  SessionCore,
  type SessionCoreTurnInputs,
} from '../session/SessionCore.js'
import { currentSessionRequests } from '../session/requests.js'
import type {
  WireImage,
  WirePendingCommand,
  WirePermissionMode,
  WireSessionActivity,
  WireSessionState,
  WireTodo,
} from '../session/wire.js'
import { createSessionChannel, type SessionChannel } from '../server/channel.js'
import { buildSubmitValue, type SessionRuntime } from '../server/runtime.js'
import { buildWireCatalog, tasksToWire } from '../server/catalog.js'
import { loadAgentWireTranscript } from '../server/agentTranscript.js'
import { createStore, type Store } from '../state/store.js'
import { getDefaultAppState, type AppState } from '../state/AppStateStore.js'
import {
  createLocalDialogStore,
  type LocalDialogStore,
} from '../session/localDialogs.js'
import { QueryGuard } from '../utils/QueryGuard.js'
import {
  enqueue,
  getCommandQueueSnapshot,
  subscribeToCommandQueue,
} from '../utils/messageQueueManager.js'
import { processQueueIfReady } from '../utils/queueProcessor.js'
import { handlePromptSubmit } from '../utils/handlePromptSubmit.js'
import { getProjectDir, recordTranscript } from '../utils/sessionStorage.js'
import { hasPermissionsToUseTool } from '../utils/permissions/permissions.js'
import { applyPermissionUpdates } from '../utils/permissions/PermissionUpdate.js'
import {
  EXTERNAL_PERMISSION_MODES,
  toExternalPermissionMode,
} from '../utils/permissions/PermissionMode.js'
import {
  stripDangerousPermissionsForAutoMode,
  transitionPermissionMode,
} from '../utils/permissions/permissionSetup.js'
import { getPlanSlug, setPlanSlug } from '../utils/plans.js'
import { wrapCanUseToolWithWebUI } from '../server/headlessBridge.js'
import { logError } from '../utils/log.js'
import { provisionContentReplacementState } from '../utils/toolResultStorage.js'
import {
  createFileStateCacheWithSizeLimit,
  READ_FILE_STATE_CACHE_SIZE,
} from '../utils/fileStateCache.js'
import { getStreamActivity } from '../utils/streamActivity.js'
import { getMainTaskListId, listTasks, onTasksUpdated } from '../utils/tasks.js'
import { getDefaultMainLoopModel } from '../utils/model/modelResolution.js'
import { buildToolUseContext } from './toolUseContext.js'
import { createHostedRpc } from './hostedRpc.js'
import { startHostedStatusLine } from './hostedStatusLine.js'
import type { QueuedCommand } from '../types/textInputTypes.js'
import type { Command } from '../commands.js'
import type { Tool } from '../Tool.js'
import type { Message } from '../types/message.js'
import type { DomainUserContentBlock } from '../types/domain.js'
import type { ThinkingConfig } from '../utils/thinking.js'
import type {
  AgentDefinition,
  AgentDefinitionsResult,
} from '../tools/AgentTool/loadAgentsDir.js'
import type { MCPServerConnection } from '../services/mcp/types.js'
import {
  loadMessagesFromJsonlPath,
  deserializeMessages,
} from '../utils/conversationRecovery.js'
import { existsSync } from 'fs'
import { join } from 'path'

export type HostedSessionOptions = {
  /** Defaults to a fresh UUID; pass an existing id to adopt a resumed one. */
  sessionId?: string
  cwd: string
  initialTranscript?: Message[]
  /** Slash-command registry surfaced to the model and the wire catalog. */
  commands?: Command[]
  /** The session's own tool pool (assembleToolPool merges permission/MCP). */
  tools?: Tool[]
  /** null / undefined: the account/config default. */
  model?: string | null
  /** Seeded whole into the store when present (rules + mode together). */
  toolPermissionContext?: ToolPermissionContext
  permissionMode?: WirePermissionMode
  customSystemPrompt?: string
  appendSystemPrompt?: string
  /** Thinking policy; absent means adaptive. */
  thinkingConfig?: ThinkingConfig
  /** Main-thread agent definition (`--agent`); absent means the plain loop. */
  mainThreadAgentDefinition?: AgentDefinition
  /**
   * The session's agent catalog (built-ins + dirs + CLI agents). Seeded into
   * the store — AgentTool reads it from there, and the default is an empty
   * list, which silently strands every subagent call as "type not found".
   */
  agentDefinitions?: AgentDefinitionsResult
  /** MCP connections the caller resolved; attached to turns as initial clients. */
  mcpClients?: MCPServerConnection[]
  /** The `--settings` overlay, recorded and forwarded (flag settings are process-scoped). */
  settings?: string
}

export type HostedSession = {
  readonly scope: SessionState
  readonly store: Store<AppState>
  readonly core: SessionCore
  readonly channel: SessionChannel
  readonly runtime: SessionRuntime
  readonly queryGuard: QueryGuard
  readonly sessionId: string
  /**
   * The handoff for local-jsx slash-command dialogs: the session's
   * `setToolJSX` writes here, and a viewer in this process (the hosted
   * launcher) mounts the JSX in its modal slot. See session/localDialogs.ts.
   */
  readonly dialogs: LocalDialogStore
  /** The options this session was started with, for hosts that re-derive rows. */
  readonly options: Readonly<HostedSessionOptions>
  /** Queue a prompt on this session; starts a turn when idle. */
  submit(
    content: string | DomainUserContentBlock[],
    options?: {
      delivery?: 'next' | 'interrupt'
      isMeta?: boolean
      images?: WireImage[]
      commandId?: string
    },
  ): void
  /** Abort the running turn, if any. */
  cancel(): void
  stop(): void
}

export function createHostedSession(
  options: HostedSessionOptions,
): HostedSession {
  const sessionId = (options.sessionId ?? randomUUID()) as SessionId
  const scope = newSessionState({
    sessionId,
    cwd: options.cwd,
    originalCwd: options.cwd,
    projectRoot: options.cwd,
  })
  const store = createStore<AppState>(getDefaultAppState())
  if (options.toolPermissionContext) {
    const context = options.toolPermissionContext
    store.setState(prev => ({
      ...prev,
      toolPermissionContext: context,
    }))
  } else if (options.permissionMode) {
    const mode = options.permissionMode
    store.setState(prev => ({
      ...prev,
      toolPermissionContext: {
        ...prev.toolPermissionContext,
        mode,
      },
    }))
  }
  if (options.agentDefinitions) {
    const agentDefinitions = options.agentDefinitions
    store.setState(prev => ({ ...prev, agentDefinitions }))
  }
  const setAppState = (updater: (prev: any) => any): void => {
    store.setState(updater)
  }
  const queryGuard = new QueryGuard()
  // The setToolJSX sink for local-jsx slash commands: the session builds
  // the dialog, the hosting terminal's viewer mounts it (see localDialogs).
  const dialogs = createLocalDialogStore()

  const broker = runInSessionScope(scope, () => currentSessionRequests())

  // No terminal dialog exists for a hosted session: an `ask` decision goes
  // to the session's broker (mirrored on the wire channel) and waits.
  const canUseTool = wrapCanUseToolWithWebUI(
    async (
      tool,
      input,
      toolUseContext,
      assistantMessage,
      toolUseId,
      forceDecision,
    ) =>
      forceDecision ??
      (await hasPermissionsToUseTool(
        tool,
        input,
        toolUseContext,
        assistantMessage,
        toolUseId,
      )),
  )

  // The real cache class, not a Map stand-in: the suggestion/speculation
  // forks clone this state through `cache.dump()`, and a plain Map has no
  // dump — the fork died before its first request with the Map in place.
  const readFileStateRef = {
    current: createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE),
  }
  const loadedNestedMemoryPathsRef = { current: new Set<string>() }
  const hasInterruptibleToolInProgressRef = { current: false }
  const contentReplacementStateRef = {
    current: provisionContentReplacementState(),
  }
  let inProgressToolUseIds: ReadonlySet<string> = new Set()

  // The context facade the builder shares with the TUI's projection:
  // host-side edits route back through the core.
  const setMessages = (
    action: Message[] | ((prev: Message[]) => Message[]),
  ): void => {
    const prev = core.getMessages() as Message[]
    core.replaceMessages(
      typeof action === 'function' ? action(prev) : action,
      'edit',
    )
  }

  const resolveModel = (): string | undefined => {
    const s = store.getState()
    if (s.mainLoopModelForSession) return s.mainLoopModelForSession
    if (options.model) return options.model
    try {
      return getDefaultMainLoopModel()
    } catch {
      return undefined
    }
  }

  const getToolUseContext = buildToolUseContext({
    commands: options.commands ?? [],
    combinedInitialTools: options.tools ?? [],
    mainThreadAgentDefinition: options.mainThreadAgentDefinition,
    debug: false,
    ideInstallationStatus: undefined,
    theme: 'dark',
    allowedAgentTypes: undefined,
    store,
    setAppState,
    reverify: () => {},
    // Host-surfaced messages reach every client as a `notify` event. The
    // React shapes (color, priority, fold) are surface concerns; the wire
    // carries level + text, and the level vocabulary is exactly the toast
    // severities a client can render.
    addNotification: (n: unknown) => {
      const level =
        n &&
        typeof n === 'object' &&
        'level' in n &&
        (n as { level?: unknown }).level
          ? (n as { level: string }).level === 'error' ||
            (n as { level: string }).level === 'warn'
            ? (n as { level: 'info' | 'warn' | 'error' }).level
            : 'info'
          : 'info'
      const text =
        typeof n === 'string'
          ? n
          : n && typeof n === 'object' && 'text' in n
            ? String((n as { text: unknown }).text)
            : ''
      if (text) channel.publishNotify({ level, text })
    },
    setMessages,
    onChangeDynamicMcpConfig: () => {},
    // In-session /resume: the classic path adopts/forks inside the REPL's
    // own state; here the same moves run through the `resume` rpc — one
    // announced transcript replace, one identity rotation. A target held
    // by another live process opens the classic conflict dialog through
    // the local-jsx handoff (see hostedResume.tsx); cancel/join leave this
    // session exactly where it was.
    resume: async (sessionId: string, _log: unknown, entrypoint: string) => {
      let fork = entrypoint === 'fork' || entrypoint === 'ownership_fork'
      if (!fork) {
        // Lazy: the conflict dialog drags the render runtime, and this
        // module stays render-free (see the header note).
        const { resolveResumeConflictForHost } =
          await import('./hostedResume.js')
        const choice = await resolveResumeConflictForHost(dialogs, sessionId)
        if (choice === 'cancel' || choice === 'join') return
        if (choice === 'fork') fork = true
      }
      await runtime.rpc?.('resume', {
        sessionId,
        forkSession: fork,
      })
    },
    requestPrompt: undefined,
    disabled: false,
    customSystemPrompt: options.customSystemPrompt,
    appendSystemPrompt: options.appendSystemPrompt,
    setConversationId: () => {},
    terminal: undefined,
    readFileState: readFileStateRef,
    setToolJSX: dialogs.set,
    loadedNestedMemoryPathsRef,
    setResponseLength: () => {},
    setStreamMode: () => {
      channel.publishMeta()
    },
    // The core owns the compacting fact and announces it; the wire mirrors.
    onCompactProgress: event => core.handleCompactProgress(event),
    setInProgressToolUseIDs: action => {
      inProgressToolUseIds =
        typeof action === 'function'
          ? action(new Set(inProgressToolUseIds))
          : action
    },
    hasInterruptibleToolInProgressRef,
    scrollRef: { current: null },
    contentReplacementStateRef,
    setIDEToInstallExtension: () => {},
    setIsMessageSelectorVisible: () => {},
    thinkingConfig: options.thinkingConfig ?? { type: 'adaptive' },
  })

  const inputs: SessionCoreTurnInputs = {
    queryGuard,
    getToolUseContext,
    canUseTool,
    store,
    toolPermissionContext: store.getState().toolPermissionContext,
    setAppState,
    initialMcpClients: options.mcpClients,
    mainThreadAgentDefinition: options.mainThreadAgentDefinition,
    title: {
      disabled: true,
      current: undefined,
      agentTitle: undefined,
      onAutoTitle: () => {},
    },
  }

  const core = new SessionCore({
    scope,
    initialTranscript: options.initialTranscript
      ? [...options.initialTranscript]
      : [],
    turnInputs: inputs,
  })

  let currentAbortController: AbortController | null = null

  const onQuery: Parameters<typeof handlePromptSubmit>[0]['onQuery'] = async (
    newMessages,
    abortController,
    shouldQuery,
    additionalAllowedTools,
    mainLoopModel,
    onBeforeQuery,
    input,
    effort,
  ) => {
    currentAbortController = abortController
    inputs.toolPermissionContext = store.getState().toolPermissionContext
    try {
      await core.submitTurn({
        newMessages,
        abortController,
        shouldQuery,
        additionalAllowedTools,
        mainLoopModel,
        input,
        effort,
        proceedGate: onBeforeQuery,
      })
    } finally {
      currentAbortController = null
      // submitTurn's finally has released the guard by the time its promise
      // settles here; the turn_finished subscription's pump ran while the
      // guard was still held and skipped, so the drain is re-armed at the
      // one point guaranteed to run after guard release. A steered
      // ('now'-priority) command runs next.
      // A clear-context plan approval wrote an initialMessage while this
      // turn unwound; the REPL's effect would consume it at exactly this
      // point (loop idle, message pending), so the drain waits behind it.
      maybeProcessInitialMessage()
      pump()
      // Same reason for meta: the turn_finished publish measured the state
      // while the guard was still held, so it said `running`. Without this
      // republication a viewer's status stays "working…" after the turn
      // ends — nothing else publishes on guard release.
      channel.publishMeta()
    }
  }

  const executeInput = async (commands: QueuedCommand[]): Promise<void> => {
    await handlePromptSubmit({
      helpers: {
        setCursorOffset: () => {},
        clearBuffer: () => {},
        resetHistory: () => {},
      },
      queryGuard,
      commands: options.commands ?? [],
      onInputChange: () => {},
      setPastedContents: () => {},
      setToolJSX: dialogs.set,
      getToolUseContext,
      messages: core.getMessages() as Message[],
      mainLoopModel: resolveModel() ?? 'claude-sonnet-4-20250514',
      ideSelection: undefined,
      setUserInputOnProcessing: () => {},
      setAbortController: controller => {
        currentAbortController = controller
      },
      onQuery,
      setAppState,
      querySource: 'repl_main_thread',
      canUseTool,
      queuedCommands: commands,
    })
  }

  /** Drain one step of this session's queue when the loop is free. */
  function pump(): void {
    if (queryGuard.isActive) return
    runInSessionScope(scope, () => {
      processQueueIfReady({
        // A hosted turn must not take the serve process down: failures are
        // logged and the queue is re-armed for the next item.
        executeInput: async commands => {
          try {
            await executeInput(commands)
          } catch (err) {
            logError(err)
            queueMicrotask(pump)
          }
        },
      })
    })
  }

  const channel = createSessionChannel({
    sessionId,
    cwd: options.cwd,
    startedAt: Date.now(),
    broker,
    getCost: () =>
      runInSessionScope(scope, () => ({
        costUsd: getTotalCostUSD(),
        linesAdded: getTotalLinesAdded(),
        linesRemoved: getTotalLinesRemoved(),
      })),
  })

  const runtime: SessionRuntime = {
    getMessages: () => core.getMessages(),
    // The channel folds streaming drafts straight off the core bus; the
    // throttle and the flush-before-patch ordering are the channel's.
    subscribeCore: cb => core.subscribe(cb),
    // Sidechain drill-down. The load runs inside this session's scope: the
    // sidechain file lives under the session's own project directory.
    getAgentTranscript: agentId =>
      runInSessionScope(scope, () => loadAgentWireTranscript(agentId)),
    getState: (): WireSessionState =>
      runInSessionScope(scope, () =>
        broker.pending().length > 0
          ? 'requires_action'
          : queryGuard.isActive
            ? 'running'
            : 'idle',
      ),
    getActivity: (): WireSessionActivity | undefined =>
      queryGuard.isActive
        ? runInSessionScope(scope, () => getStreamActivity())
        : undefined,
    getIsCompacting: () => core.isCompacting,
    getModel: () => resolveModel(),
    getPermissionMode: () => {
      const mode = store.getState().toolPermissionContext.mode as string
      return (EXTERNAL_PERMISSION_MODES as readonly string[]).includes(mode) ||
        // Auto rides the wire as itself: the classifier lives inside this
        // session's permission path; the surface just renders the banner.
        mode === 'auto'
        ? (mode as WirePermissionMode)
        : undefined
    },
    getTodos: () => todosCache,
    getTasks: () => tasksToWire(store.getState().tasks ?? {}),
    getCatalog: () => buildWireCatalog(options.commands ?? []),
    getPendingCommands: () =>
      runInSessionScope(scope, () => {
        const commands: WirePendingCommand[] = []
        for (const cmd of getCommandQueueSnapshot()) {
          if (cmd.mode !== 'prompt') continue
          const text =
            typeof cmd.value === 'string'
              ? cmd.value
              : cmd.value
                  .filter(
                    (b): b is { type: 'text'; text: string } =>
                      b.type === 'text',
                  )
                  .map(b => b.text)
                  .join('\n')
          if (text && cmd.uuid) {
            commands.push({ id: cmd.uuid, text, isMeta: cmd.isMeta })
          }
        }
        return commands
      }),
    getInProgressToolUseIds: () => inProgressToolUseIds,

    submit(content, delivery, commandId, images) {
      submitInner(
        buildSubmitValue(content, images),
        delivery,
        commandId,
        undefined,
      )
    },

    cancel() {
      cancel()
    },

    setModel(model) {
      store.setState(prev => ({ ...prev, mainLoopModelForSession: model }))
      runInSessionScope(scope, () =>
        setMainLoopModelOverride(model ?? undefined),
      )
      channel.publishMeta()
    },

    setMode(mode) {
      store.setState(prev => {
        const context = prev.toolPermissionContext
        const next = transitionPermissionMode(context.mode, mode, context)
        return {
          ...prev,
          toolPermissionContext: { ...next, mode },
        }
      })
      channel.publishMeta()
    },

    rpc: createHostedRpc({
      scope,
      core,
      channel,
      store,
      queryGuard,
      getToolUseContext,
      resolveModel: () => resolveModel() ?? 'claude-sonnet-4-20250514',
      loadTranscriptMessages: targetId =>
        runInSessionScope(scope, async () => {
          // Inside this session's scope: the transcript lives under the
          // session's own project directory, not the serve process's cwd.
          const path = join(getProjectDir(getCwdState()), `${targetId}.jsonl`)
          if (!existsSync(path)) return null
          const { messages } = await loadMessagesFromJsonlPath(path)
          return deserializeMessages(messages as Message[])
        }),
    }),
  }
  channel.registerRuntime(runtime)

  // ── initialMessage: the hosted mirror of the REPL's processInitialMessage ──
  // The plan-approval dialog with "clear context" (ExitPlanModePermissionRequest,
  // mounted by this session's wire viewer over the shared store) writes an
  // initialMessage and rejects the tool call to unblock the loop. The REPL
  // consumes that by clearing the conversation, adopting the approval's mode,
  // and running the message as a fresh query; this is that consumption, run
  // once the loop that unblocked it has ended (same `!isLoading` gate the
  // REPL effect waits on).
  let initialMessageInFlight = false
  function maybeProcessInitialMessage(): void {
    if (initialMessageInFlight || queryGuard.isActive) return
    const pending = store.getState().initialMessage
    if (!pending) return
    initialMessageInFlight = true
    void (async () => {
      try {
        await runInSessionScope(scope, async () => {
          if (pending.clearContext) {
            // The plan slug belongs to the conversation about to be abandoned;
            // re-pin it to the fresh id so a next plan cycle reuses it (the
            // same carry the REPL's clear path performs).
            const oldSlug = pending.message.planContent
              ? getPlanSlug()
              : undefined
            await runtime.rpc?.('clear', undefined)
            if (oldSlug) setPlanSlug(getSessionId(), oldSlug)
          }
          const mode = pending.mode
          store.setState((prev: any) => {
            let context = prev.toolPermissionContext
            if (mode) {
              context = applyPermissionUpdates(context, [
                {
                  type: 'setMode',
                  mode: toExternalPermissionMode(mode),
                  destination: 'session',
                },
              ])
              if (mode === 'auto') {
                context = stripDangerousPermissionsForAutoMode({
                  ...context,
                  mode: 'auto',
                  prePlanMode: undefined,
                })
              }
            }
            return {
              ...prev,
              initialMessage: null,
              toolPermissionContext: context,
            }
          })
          const abortController = new AbortController()
          currentAbortController = abortController
          inputs.toolPermissionContext = store.getState().toolPermissionContext
          await core.submitTurn({
            newMessages: [pending.message],
            abortController,
            shouldQuery: true,
            additionalAllowedTools: [],
            mainLoopModel: resolveModel() ?? 'claude-sonnet-4-20250514',
          })
        })
      } catch (err) {
        logError(err)
      } finally {
        initialMessageInFlight = false
        currentAbortController = null
        pump()
        channel.publishMeta()
      }
    })()
  }
  // A write while the session is idle needs no turn boundary to wake on.
  const unsubscribeInitialMessage = store.subscribe(() => {
    if (store.getState().initialMessage) maybeProcessInitialMessage()
  })

  // Todos are the file-backed task store the TUI reads, keyed by the
  // session id (getMainTaskListId's scope-resolved fallback). The task
  // tools inside a turn fire onTasksUpdated; a refresh re-reads this
  // session's list and republishes when the mapped view actually changed.
  let todosCache: WireTodo[] = []
  let todosFetchSeq = 0
  function refreshTodos(): void {
    const listId = runInSessionScope(scope, () => getMainTaskListId())
    const seq = ++todosFetchSeq
    void listTasks(listId)
      .then(tasks => {
        if (seq !== todosFetchSeq) return
        const next = tasks
          .slice()
          .sort((a, b) =>
            a.id.localeCompare(b.id, undefined, { numeric: true }),
          )
          .map(t => ({
            content: t.subject,
            status: t.status,
            activeForm: t.activeForm,
          }))
        if (JSON.stringify(next) === JSON.stringify(todosCache)) return
        todosCache = next
        channel.publishTodos()
      })
      .catch(err => {
        logError(err)
      })
  }
  const unsubscribeTasks = onTasksUpdated(() => refreshTodos())
  refreshTodos()

  // Transcript persistence, the same incremental discipline as the TUI's
  // useLogMessages: new tail + parent hint while the chain head is stable,
  // full array (recordTranscript dedups against what is on disk) after a
  // compaction or same-head shrink. Serialized so two writes never race a
  // half-committed chain, and a failure leaves the watermark untouched so
  // the next write retries the same slice.
  let lastRecordedLength = 0
  let lastRecordedParent: UUID | undefined
  let firstRecordedUuid: UUID | undefined
  let persistence: Promise<void> = Promise.resolve()

  function persistTranscript(): void {
    persistence = persistence
      .then(async () => {
        const messages = core.getMessages() as Message[]
        const first = messages[0]?.uuid as UUID | undefined
        const isIncremental =
          first !== undefined &&
          firstRecordedUuid === first &&
          lastRecordedLength <= messages.length
        const startIndex = isIncremental ? lastRecordedLength : 0
        if (startIndex === messages.length) return
        const slice = startIndex === 0 ? messages : messages.slice(startIndex)
        const lastRecorded = await runInSessionScope(scope, () =>
          recordTranscript(
            slice,
            isIncremental ? lastRecordedParent : undefined,
          ),
        )
        if (lastRecorded) lastRecordedParent = lastRecorded
        firstRecordedUuid = first
        lastRecordedLength = messages.length
      })
      .catch(err => {
        logError(err)
      })
  }

  // Core events drive the wire: every transcript write republishes the
  // diff, every lifecycle beat refreshes meta, and turn end re-arms the
  // queue drain.
  const unsubscribeCore = core.subscribe(event => {
    switch (event.type) {
      case 'transcript_appended':
      case 'transcript_replaced':
      case 'transcript_progress_replaced':
      case 'transcript_removed':
        channel.publishTranscript()
        persistTranscript()
        return
      case 'turn_finished':
        channel.publishMeta()
        pump()
        return
      case 'activity':
      case 'turn_started':
      case 'compacting':
      case 'conversation_id':
        channel.publishMeta()
        return
      default:
        return
    }
  })

  // The statusline driver: the hosted mirror of the REPL footer's
  // <StatusLine> — runs the configured (or embedded default) command in this
  // session's scope and publishes the text to the shared store's
  // statusLineText for the hosting terminal's viewer to render.
  const stopStatusLine = startHostedStatusLine({ scope, core, store })

  // The queue store is session-scoped: both the subscription registration
  // and the callback body must resolve against this session's scope.
  // A 'now'-priority arrival interrupts: the running turn aborts so the
  // drain runs the new command next — the hosted counterpart of the REPL's
  // queue-watch effect. One abort per command id; the abort of an already
  // aborted turn would be noise.
  let lastInterruptedCommandId: string | undefined
  const onQueueChanged = (): void => {
    runInSessionScope(scope, () => {
      if (queryGuard.isActive) {
        const interrupter = getCommandQueueSnapshot().find(
          cmd => cmd.priority === 'now' && cmd.uuid,
        )
        if (
          interrupter?.uuid &&
          interrupter.uuid !== lastInterruptedCommandId
        ) {
          lastInterruptedCommandId = interrupter.uuid
          currentAbortController?.abort('interrupt')
        }
      }
      channel.publishQueue()
      pump()
    })
  }
  const unsubscribeQueue = runInSessionScope(scope, () =>
    subscribeToCommandQueue(onQueueChanged),
  )

  function submitInner(
    value: string | DomainUserContentBlock[],
    delivery: 'next' | 'interrupt' | undefined,
    commandId: string,
    isMeta: boolean | undefined,
  ): void {
    runInSessionScope(scope, () => {
      enqueue({
        mode: 'prompt',
        value,
        priority: delivery === 'interrupt' ? 'now' : 'next',
        uuid: commandId as UUID,
        origin: { kind: 'webui' },
        isMeta,
      })
    })
    pump()
  }

  function submit(
    content: string | DomainUserContentBlock[],
    submitOptions?: {
      delivery?: 'next' | 'interrupt'
      isMeta?: boolean
      images?: WireImage[]
      commandId?: string
    },
  ): void {
    submitInner(
      typeof content === 'string'
        ? buildSubmitValue(content, submitOptions?.images)
        : content,
      submitOptions?.delivery,
      submitOptions?.commandId ?? randomUUID(),
      submitOptions?.isMeta,
    )
  }

  function cancel(): void {
    currentAbortController?.abort('user-cancel')
  }

  function stop(): void {
    currentAbortController?.abort('user-cancel')
    runInSessionScope(scope, () => broker.cancelAll())
    unsubscribeQueue()
    unsubscribeCore()
    unsubscribeTasks()
    unsubscribeInitialMessage()
    stopStatusLine()
    dialogs.set(null)
    channel.stop()
  }

  return {
    scope,
    store,
    core,
    channel,
    runtime,
    queryGuard,
    sessionId,
    options,
    dialogs,
    submit,
    cancel,
    stop,
  }
}
