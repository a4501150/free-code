/**
 * SessionCore — the owner of one session's loop, transcript and surfaces.
 *
 * The loop driver extracted from the TUI's query-execution hook (and, in the
 * print path, from its drain loop): it builds the effective system prompt,
 * drives `query()`, applies every stream event to the transcript, and
 * announces every mutation on a typed event bus. It has no React imports;
 * UIs subscribe (the TUI directly, remote clients through the wire
 * projector).
 *
 * Ownership in this phase: the transcript array is still the host's ref
 * (the REPL's `messagesRef`, mutated in place and announced — the ref IS
 * the truth, exactly as the REPL already treats it), and per-turn context
 * assembly (`getToolUseContext`, permission racing) is injected. Extracting
 * those behind the core boundary is the remaining work of the phase; what
 * must not regress is the single-driver invariant: one core, one query loop,
 * all state changes announced.
 *
 * A core constructed with a `scope` runs every turn inside
 * `runInSessionScope`, which is what lets one process host several sessions.
 * Without a scope the core addresses the root session state — every process
 * today.
 */

import { randomUUID } from 'crypto'
import { fireCompanionObserver } from '../buddy/observer.js'
import { query } from '../query.js'
import { getQuerySourceForREPL } from '../utils/promptCategory.js'
import { getSystemPrompt } from '../constants/prompts.js'
import { buildEffectiveSystemPrompt } from '../utils/systemPrompt.js'
import { getSystemContext, getUserContext } from '../context.js'
import {
  getSessionId,
  getOriginalCwd,
  newSessionState,
  runInSessionScope,
  resetTurnHookDuration,
  resetTurnToolDuration,
  resetTurnClassifierDuration,
  type SessionState,
} from '../bootstrap/state.js'
import {
  handleMessageFromStream,
  isCompactBoundaryMessage,
  getMessagesAfterCompactBoundary,
} from '../utils/messages.js'
import {
  removeTranscriptMessage,
  isEphemeralToolProgress,
} from '../utils/sessionStorage.js'
import {
  queryCheckpoint,
  logQueryProfileReport,
} from '../utils/queryProfiler.js'
import {
  checkAndDisableBypassPermissionsIfNeeded,
  checkAndDisableAutoModeIfNeeded,
} from '../utils/permissions/bypassPermissionsKillswitch.js'
import {
  getScratchpadDir,
  isScratchpadEnabled,
} from '../utils/permissions/filesystem.js'
import { maybeMarkProjectOnboardingComplete } from '../projectOnboardingState.js'
import { closeOpenDiffs, getConnectedIdeClient } from '../utils/ide.js'
import { diagnosticTracker } from '../services/diagnosticTracking.js'
import { mergeClients } from '../hooks/useMergedClients.js'
import { enqueue } from '../utils/messageQueueManager.js'
import { getContentText } from '../utils/messages.js'
import { logError } from '../utils/log.js'
import { generateSessionTitle } from '../utils/sessionTitle.js'
import { saveAiGeneratedTitle } from '../utils/sessionStorage.js'
import type { Message, UserMessage } from '../types/message.js'
import type { SDKMessage } from '../structuredProtocol/index.js'
import type { StreamingToolUse, StreamingThinking } from '../utils/messages.js'
import type { EffortValue } from '../utils/effort.js'
import type { ProcessUserInputContext } from '../utils/processUserInput/processUserInput.js'
import type {
  CanUseToolFn,
  CompactProgressEvent,
  ToolPermissionContext,
} from '../Tool.js'
import type { AgentDefinition } from '../tools/AgentTool/loadAgentsDir.js'
import type { MCPServerConnection } from '../services/mcp/types.js'
import type { QueryGuard } from '../utils/QueryGuard.js'
import * as coordinatorModeModule from '../coordinator/coordinatorMode.js'
import {
  createSessionEventBus,
  type SessionEvent,
  type SessionEventSubscriber,
} from './events.js'

export type SessionCoreDeps = {
  /**
   * Own a private per-session state object (multi-session hosting). Omit to
   * run against the root scope.
   */
  scope?: SessionState
  /** Read view of the authoritative transcript. */
  messagesRef: { current: Message[] }
  /**
   * The host's transcript write channel (the REPL's ref-eager `setMessages`
   * wrapper, later the core's own store). The core computes every new array
   * itself and hands it over whole; the host decides how its projection
   * catches up, and the matching `transcript_*` event is the only signal to
   * other subscribers.
   */
  setMessages: (next: Message[]) => void
  queryGuard: QueryGuard
  /**
   * Per-turn context assembly for the core's own query loop. An
   * executor-mode host (headless `-p`) never calls it, so it may be omitted.
   */
  getToolUseContext?: (
    messages: Message[],
    newMessages: Message[],
    abortController: AbortController,
    mainLoopModel: string,
  ) => ProcessUserInputContext
  canUseTool: CanUseToolFn
  /** The AppState store (the framework-free one) the host shares with tools. */
  store: {
    getState: () => any
    setState: (fn: (prev: any) => any) => void
  }
  toolPermissionContext: ToolPermissionContext
  setAppState: (fn: (prev: any) => any) => void
  initialMcpClients?: MCPServerConnection[]
  mainThreadAgentDefinition?: AgentDefinition
  customSystemPrompt?: string
  appendSystemPrompt?: string
  /** Title policy inputs: a host with `titleDisabled` never auto-titles. */
  title: {
    disabled: boolean
    current: string | undefined
    agentTitle: string | undefined
    onAutoTitle: (title: string) => void
  }
  /** Turn observers kept by the host (moreright, companion, idle notify). */
  onBeforeQuery?: (
    input: string,
    messages: Message[],
    newMessageCount: number,
  ) => Promise<boolean>
  onTurnComplete?: (messages: Message[]) => void | Promise<void>
}

/**
 * A host-provided loop driver (the headless `-p` path, whose QueryEngine
 * pipeline owns everything inside the loop — transcript recording, usage
 * accumulation, the SDKMessage stdout contract). The core still owns the
 * guard and announces the turn lifecycle; everything the driver emits is
 * handed to `deliver`, which the core also mirrors onto the event bus as
 * `sdk_message`.
 */
export type TurnExecutor = (
  deliver: (message: SDKMessage) => void,
) => Promise<void>

export type TurnRequest = {
  newMessages: Message[]
  abortController: AbortController
  shouldQuery: boolean
  additionalAllowedTools: string[]
  mainLoopModel: string
  input?: string
  effort?: EffortValue
  /**
   * The host's own gate (assessor / plan flows), run after the core's
   * `onBeforeQuery` observer and able to stop the turn before the loop.
   */
  proceedGate?: (input: string, messages: Message[]) => Promise<boolean>
  /**
   * Run this turn through the host's driver instead of the core's own
   * query loop (see `TurnExecutor`). Set per-request because the headless
   * driver is rebuilt from fresh per-turn inputs.
   */
  executor?: TurnExecutor
}

export class SessionCore {
  readonly events = createSessionEventBus()
  private readonly deps: SessionCoreDeps
  private readonly scope: SessionState | undefined
  private autoTitleAttempted = false

  constructor(deps: SessionCoreDeps) {
    this.deps = deps
    this.scope = deps.scope ?? undefined
    if (deps.scope === undefined) {
      // Root-scope mode: the process-wide state is already initialized by
      // startup; nothing to create. Recorded explicitly because `newSessionState`
      // here would fork the host's identity away from the root.
    }
  }

  /** The session-state object this core's accessors resolve against. */
  getState(): SessionState | undefined {
    return this.scope
  }

  subscribe(cb: SessionEventSubscriber): () => void {
    return this.events.subscribe(cb)
  }

  private emit(event: SessionEvent): void {
    this.events.emit(event)
  }

  /** The transcript, for snapshotting consumers (wire projector, -p bridge). */
  getMessages(): readonly Message[] {
    return this.deps.messagesRef.current
  }

  /** When the current compaction began; null while nothing is compacting. */
  get compactStartedAt(): number | null {
    return this.compactStarted
  }

  /** True while a manual /compact or auto-compaction is in flight. */
  get isCompacting(): boolean {
    return this.compactStarted !== null
  }

  /**
   * The single sink for compaction progress (the tool-use context's
   * `onCompactProgress`, wherever that context was built). Records the
   * state and announces it with the raw service event — surfaces choose
   * their own wording, the core owns the fact.
   */
  handleCompactProgress(event: CompactProgressEvent): void {
    if (event.type === 'compact_end') {
      this.compactStarted = null
    } else if (this.compactStarted === null) {
      this.compactStarted = Date.now()
    }
    this.emit({
      type: 'compacting',
      startedAt: this.compactStarted,
      progress: event,
    })
  }
  private compactStarted: number | null = null

  /**
   * Drive one turn — the successor of the REPL's `onQuery`. Guarded, queued
   * on busy (the queue is the session's submission bus, so a busy core parks
   * fresh user prompts instead of dropping them), and always releases the
   * guard.
   */
  async submitTurn(req: TurnRequest): Promise<'queued' | 'done' | 'declined'> {
    const { newMessages, shouldQuery, input } = req
    const generation = this.deps.queryGuard.tryStart()
    if (generation === null) {
      newMessages
        .filter((m): m is UserMessage => m.type === 'user' && !m.isMeta)
        .map(m => getContentText(m.message.content))
        .filter((text): text is string => text !== null)
        .forEach(text => enqueue({ value: text, mode: 'prompt' }))
      return 'queued'
    }

    try {
      this.applyNewMessages(newMessages)
      if (input && this.deps.onBeforeQuery) {
        const proceed = await this.deps.onBeforeQuery(
          input,
          this.deps.messagesRef.current,
          newMessages.length,
        )
        // A declined turn still runs the completion callbacks — the
        // pre-query gate short-circuits the loop, not the turn lifecycle.
        if (!proceed) return 'declined'
      }
      if (input && req.proceedGate) {
        const proceed = await req.proceedGate(
          input,
          this.deps.messagesRef.current,
        )
        if (!proceed) return 'declined'
      }
      await this.runTurn(req)
      return 'done'
    } catch (e) {
      logError(e)
      throw e
    } finally {
      // Releases the guard only. The host reacts to the result ('queued'
      // means the turn parked in the session queue and nothing else ran).
      this.deps.queryGuard.end(generation)
    }
  }

  /** Append at the tail, announcing each message. */
  private applyNewMessages(newMessages: Message[]): void {
    // An empty batch must not rewrite the transcript: a headless host's
    // transcript is an in-place-mutated array and rewriting the identity
    // would desync every closure holding it (the executor driver appends
    // to the host's array itself).
    if (newMessages.length === 0) return
    this.deps.setMessages([...this.deps.messagesRef.current, ...newMessages])
    for (const message of newMessages) {
      this.emit({ type: 'transcript_appended', message })
    }
  }

  /** Replace the whole transcript (compact, rewind, switch, restore). */
  replaceMessages(
    messages: Message[],
    reason: 'compact' | 'rewind' | 'switch' | 'restore',
  ): void {
    this.deps.setMessages(messages)
    this.emit({ type: 'transcript_replaced', messages, reason })
  }

  /**
   * The moved `onQueryImpl`: context assembly, system prompt, the generator
   * loop. All visible state changes are emitted; nothing here touches React.
   */
  private async runTurn(req: TurnRequest): Promise<void> {
    const body = async () => {
      const {
        newMessages,
        abortController,
        shouldQuery,
        additionalAllowedTools,
        mainLoopModel,
        effort,
      } = req
      const d = this.deps

      // Executor mode (headless `-p`): the host's driver owns the loop, so
      // none of the assembly below runs — the driver's own pipeline does
      // that today. The core keeps only the guard and the turn lifecycle.
      if (req.executor) {
        resetTurnHookDuration()
        resetTurnToolDuration()
        resetTurnClassifierDuration()
        this.visibleStreamingText = null
        this.emit({ type: 'turn_started' })
        await req.executor(message => {
          this.emit({ type: 'sdk_message', message })
        })
        this.emit({
          type: 'turn_finished',
          aborted: req.abortController.signal.aborted,
        })
        await d.onTurnComplete?.(d.messagesRef.current)
        return
      }

      if (shouldQuery) {
        const freshClients = mergeClients(
          d.initialMcpClients,
          d.store.getState().mcp.clients,
        )
        void diagnosticTracker.handleQueryStart(freshClients)
        const ideClient = getConnectedIdeClient(freshClients)
        if (ideClient) {
          void closeOpenDiffs(ideClient)
        }
      }

      void maybeMarkProjectOnboardingComplete()
      this.maybeGenerateAutoTitle(newMessages)

      d.setAppState((prev: any) => {
        const cur = prev.toolPermissionContext.alwaysAllowRules.command
        if (
          cur === additionalAllowedTools ||
          (cur?.length === additionalAllowedTools.length &&
            cur.every(
              (v: string, i: number) => v === additionalAllowedTools[i],
            ))
        ) {
          return prev
        }
        return {
          ...prev,
          toolPermissionContext: {
            ...prev.toolPermissionContext,
            alwaysAllowRules: {
              ...prev.toolPermissionContext.alwaysAllowRules,
              command: additionalAllowedTools,
            },
          },
        }
      })

      if (!shouldQuery) {
        if (newMessages.some(isCompactBoundaryMessage)) {
          this.emit({ type: 'conversation_id', id: randomUUID() })
        }
        this.emit({ type: 'turn_finished', aborted: false })
        return
      }

      const toolUseContext = d.getToolUseContext!(
        d.messagesRef.current,
        newMessages,
        abortController,
        mainLoopModel,
      )
      const { tools: freshTools, mcpClients: freshMcpClients } =
        toolUseContext.options

      if (effort !== undefined) {
        toolUseContext.effortOverride = effort
      }

      queryCheckpoint('query_context_loading_start')
      const [, , defaultSystemPrompt, baseUserContext, systemContext] =
        await Promise.all([
          checkAndDisableBypassPermissionsIfNeeded(
            d.toolPermissionContext,
            d.setAppState,
          ),
          checkAndDisableAutoModeIfNeeded(
            d.toolPermissionContext,
            d.setAppState,
            d.store.getState().fastMode,
          ),
          getSystemPrompt(
            freshTools,
            Array.from(
              toolPermissionContext_additionalDirs(d.toolPermissionContext),
            ),
          ),
          getUserContext(),
          getSystemContext(),
        ])
      const userContext = {
        ...baseUserContext,
        ...coordinatorModeModule.getCoordinatorUserContext(
          freshMcpClients,
          isScratchpadEnabled() ? getScratchpadDir() : undefined,
        ),
      }
      queryCheckpoint('query_context_loading_end')

      const systemPrompt = buildEffectiveSystemPrompt({
        mainThreadAgentDefinition: d.mainThreadAgentDefinition,
        toolUseContext,
        customSystemPrompt: d.customSystemPrompt,
        defaultSystemPrompt,
        appendSystemPrompt: d.appendSystemPrompt,
      })
      toolUseContext.renderedSystemPrompt = systemPrompt

      queryCheckpoint('query_query_start')
      resetTurnHookDuration()
      resetTurnToolDuration()
      resetTurnClassifierDuration()
      this.visibleStreamingText = null
      this.emit({ type: 'turn_started' })

      for await (const event of query({
        messages: d.messagesRef.current,
        systemPrompt,
        userContext,
        systemContext,
        canUseTool: d.canUseTool,
        toolUseContext,
        querySource: getQuerySourceForREPL(),
      })) {
        this.handleStreamEvent(event)
      }

      queryCheckpoint('query_end')
      logQueryProfileReport()
      this.emit({
        type: 'turn_finished',
        aborted: abortController.signal.aborted,
      })
      // Turn observers run only for a loop that actually ran: the
      // !shouldQuery path returned above, matching the pre-core behavior.
      await d.onTurnComplete?.(d.messagesRef.current)
      // Companion keyword reactions on the finished turn (self-debounced,
      // no-ops unhatched/muted).
      void fireCompanionObserver(d.messagesRef.current, reaction =>
        d.setAppState((prev: any) => ({
          ...prev,
          companionReaction: reaction,
        })),
      )
    }

    if (this.scope) {
      await runInSessionScope(this.scope, body)
    } else {
      await body()
    }
  }

  /** The moved `onQueryEvent` fan-out: transcript applies, per-block UI feeds. */
  handleStreamEvent(
    event: Parameters<typeof handleMessageFromStream>[0],
  ): void {
    // Raw pass-through first: projections that need the unfolded event (the
    // SDK adapter) must see it even if folding consumes it.
    this.emit({ type: 'raw_turn_event', event })
    handleMessageFromStream(
      event,
      newMessage => {
        const current = this.deps.messagesRef.current
        if (isCompactBoundaryMessage(newMessage)) {
          const kept = getMessagesAfterCompactBoundary(current)
          const next = [...kept, newMessage]
          this.deps.setMessages(next)
          this.emit({
            type: 'transcript_replaced',
            messages: next,
            reason: 'compact',
          })
          this.emit({ type: 'conversation_id', id: randomUUID() })
        } else if (
          newMessage.type === 'progress' &&
          isEphemeralToolProgress(newMessage.data.type)
        ) {
          const last = current.at(-1)
          if (
            last?.type === 'progress' &&
            last.parentToolUseID === newMessage.parentToolUseID &&
            last.data.type === newMessage.data.type
          ) {
            const copy = current.slice()
            copy[copy.length - 1] = newMessage
            this.deps.setMessages(copy)
            this.emit({
              type: 'transcript_progress_replaced',
              message: newMessage,
            })
          } else {
            this.deps.setMessages([...current, newMessage])
            this.emit({ type: 'transcript_appended', message: newMessage })
          }
        } else {
          this.deps.setMessages([...current, newMessage])
          this.emit({ type: 'transcript_appended', message: newMessage })
        }
      },
      newContent => {
        this.emit({ type: 'response_length_delta', chars: newContent.length })
      },
      mode => this.emit({ type: 'activity', activity: mode }),
      f => {
        // Same updater-callback shape as the streaming text fold: the core
        // keeps the previous value so the fold is deterministic here.
        const next = f(this.lastStreamingToolUses)
        this.lastStreamingToolUses = next
        this.emit({ type: 'streaming_tool_uses', toolUses: next })
      },
      tombstonedMessage => {
        this.deps.setMessages(
          this.deps.messagesRef.current.filter(m => m !== tombstonedMessage),
        )
        this.emit({ type: 'transcript_removed', uuid: tombstonedMessage.uuid })
        void removeTranscriptMessage(tombstonedMessage.uuid)
      },
      f => {
        const next = f(this.lastStreamingThinking)
        this.lastStreamingThinking = next
        this.emit({ type: 'streaming_thinking', thinking: next })
      },
      undefined,
      f => {
        // The core owns the visible-text fold now: the fold function arrives
        // instead of the next value, so apply it to the core's own copy and
        // announce the result. Consumers render what they are told, never a
        // second accumulation.
        this.visibleStreamingText = f(this.visibleStreamingText)
        this.emit({ type: 'streaming_text', text: this.visibleStreamingText })
      },
    )
  }
  // Streaming folds live on the core so every consumer renders what the core
  // announced, never a second accumulation of the same deltas.
  private visibleStreamingText: string | null = null
  private lastStreamingToolUses: StreamingToolUse[] = []
  private lastStreamingThinking: StreamingThinking | null = null

  private maybeGenerateAutoTitle(newMessages: Message[]): void {
    const d = this.deps
    if (
      d.title.disabled ||
      d.title.current ||
      d.title.agentTitle ||
      this.autoTitleAttempted
    ) {
      return
    }
    const firstUserMessage = newMessages.find(
      m => m.type === 'user' && !m.isMeta,
    )
    const text =
      firstUserMessage?.type === 'user'
        ? getContentText(firstUserMessage.message.content)
        : null
    if (
      text &&
      !text.startsWith('<command-name>') &&
      !text.startsWith('<command-message>') &&
      !text.startsWith('<local-command-stdout>') &&
      !text.startsWith('<bash-input>')
    ) {
      this.autoTitleAttempted = true
      void generateSessionTitle(text, new AbortController().signal).then(
        title => {
          if (title) {
            d.title.onAutoTitle(title)
            saveAiGeneratedTitle(getSessionId() as any, title)
          } else this.autoTitleAttempted = false
        },
        () => {
          this.autoTitleAttempted = false
        },
      )
    }
  }
}

function toolPermissionContext_additionalDirs(ctx: ToolPermissionContext) {
  return ctx.additionalWorkingDirectories.keys()
}
