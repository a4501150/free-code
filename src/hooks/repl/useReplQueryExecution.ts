/**
 * The TUI adapter around SessionCore.
 *
 * The loop lives in `src/session/SessionCore.ts`: context assembly, the
 * generator, every transcript mutation (applied through the host's
 * `setMessages`) and every surface change (announced as typed events). This
 * hook keeps the exact prop contract the REPL screen was built against and
 * does three jobs:
 *
 * 1. Own one core instance per mounted REPL session, fed by a live deps
 *    object refreshed after every render — the core never sees a stale
 *    permission context or agent definition (the same ref-carrier trick the
 *    attach bridge used).
 * 2. Project core events onto the React setters: stream state and
 *    conversation identity. Transcript events need no re-apply here because
 *    the core wrote through `setMessages`; the wire projector consumes them.
 * 3. Keep the host-only turn-lifecycle bookkeeping around the core call:
 *    timing refs, completion time, the long-turn summary message, and the
 *    cancel-and-restore-last-prompt behavior (input history is a terminal
 *    concern, not session state).
 */
import { useCallback, useEffect, useRef } from 'react'
import { count } from '../../utils/array.js'
import {
  createUserMessage,
  createTurnDurationMessage,
  handleMessageFromStream,
} from '../../utils/messages.js'
import { isLoggableMessage } from '../../utils/sessionStorage.js'
import {
  getCommandQueue,
  getCommandQueueLength,
} from '../../utils/messageQueueManager.js'
import {
  selectableUserMessagesFilter,
  messagesAfterAreOnlySynthetic,
} from '../../components/MessageSelector.js'
import { removeLastFromHistory } from '../../history.js'
import { createAbortController } from '../../utils/abortController.js'
import type {
  Message as MessageType,
  UserMessage,
} from '../../types/message.js'
import type { EffortValue } from '../../utils/effort.js'
import type { ProcessUserInputContext } from '../../utils/processUserInput/processUserInput.js'
import type { AgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js'
import type { MCPServerConnection } from '../../services/mcp/types.js'
import type { QueryGuard } from '../../utils/QueryGuard.js'
import type { SpinnerMode } from '../../components/Spinner.js'
import type {
  StreamingToolUse,
  StreamingThinking,
} from '../../utils/messages.js'
import { SessionCore, type SessionCoreDeps } from '../../session/SessionCore.js'
import type { SessionEvent } from '../../session/events.js'

export function useReplQueryExecution(props: {
  messagesRef: React.RefObject<MessageType[]>
  setMessages: (action: React.SetStateAction<MessageType[]>) => void
  setStreamMode: (mode: SpinnerMode) => void
  setStreamingToolUses: React.Dispatch<React.SetStateAction<StreamingToolUse[]>>
  setStreamingThinking: React.Dispatch<
    React.SetStateAction<StreamingThinking | null>
  >
  setStreamingText: (text: string | null) => void
  setResponseLength: (f: (prev: number) => number) => void
  onStreamingText: (f: (current: string | null) => string | null) => void
  setSpinnerMessage: (msg: string | null) => void
  setSpinnerColor: (color: any) => void
  setSpinnerShimmerColor: (color: any) => void
  setCompactingStartTime: (
    time: number | null | ((prev: number | null) => number | null),
  ) => void
  resetLoadingState: () => void
  resetTimingRefs: () => void
  queryGuard: QueryGuard
  setAbortController: (controller: AbortController | null) => void
  scrollRef: React.RefObject<any>
  setConversationId: (id: any) => void
  setLastQueryCompletionTime: (time: number) => void
  setAutoTitle: (title: string | undefined) => void
  autoTitleAttemptedRef: React.MutableRefObject<boolean>
  setUserInputOnProcessing: (input: string | undefined) => void
  inputValueRef: React.RefObject<string>
  loadingStartTimeRef: React.RefObject<number>
  totalPausedMsRef: React.RefObject<number>
  restoreMessageSyncRef: React.MutableRefObject<(m: UserMessage) => void>
  getToolUseContext: (
    messages: MessageType[],
    newMessages: MessageType[],
    abortController: AbortController,
    mainLoopModel: string,
  ) => ProcessUserInputContext
  mainThreadAgentDefinition?: AgentDefinition
  initialMcpClients?: MCPServerConnection[]
  toolPermissionContext: any
  setAppState: (fn: (prev: any) => any) => void
  store: { getState: () => any; setState: (fn: (prev: any) => any) => void }
  customSystemPrompt?: string
  appendSystemPrompt?: string
  canUseTool: any
  onBeforeQuery?: (
    input: string,
    newMessages: MessageType[],
  ) => Promise<boolean>
  onTurnComplete?: (messages: MessageType[]) => void | Promise<void>
  mrOnBeforeQuery: (
    input: string,
    messages: MessageType[],
    newCount: number,
  ) => Promise<boolean>
  mrOnTurnComplete: (messages: MessageType[], aborted: boolean) => Promise<void>
  titleDisabled: boolean
  sessionTitle: string | undefined
  agentTitle: string | undefined
}) {
  // Live-props carrier. The core and the event projection both read through
  // it, and the identity-free effect refreshes it after every render, so the
  // one core instance always acts on current values.
  const propsRef = useRef(props)
  useEffect(() => {
    propsRef.current = props
  })

  const depsRef = useRef<SessionCoreDeps | null>(null)
  if (depsRef.current === null) {
    const p = props
    depsRef.current = {
      messagesRef: p.messagesRef as React.MutableRefObject<MessageType[]>,
      setMessages: next => propsRef.current.setMessages(next),
      queryGuard: p.queryGuard,
      getToolUseContext: p.getToolUseContext,
      canUseTool: p.canUseTool,
      store: p.store,
      toolPermissionContext: p.toolPermissionContext,
      setAppState: p.setAppState,
      initialMcpClients: p.initialMcpClients,
      mainThreadAgentDefinition: p.mainThreadAgentDefinition,
      customSystemPrompt: p.customSystemPrompt,
      appendSystemPrompt: p.appendSystemPrompt,
      title: {
        disabled: p.titleDisabled,
        current: p.sessionTitle,
        agentTitle: p.agentTitle,
        onAutoTitle: t => propsRef.current.setAutoTitle(t),
      },
      onBeforeQuery: (input, messages, newCount) =>
        propsRef.current.mrOnBeforeQuery(input, messages, newCount),
      onTurnComplete: messages => propsRef.current.onTurnComplete?.(messages),
    }
  }
  const coreRef = useRef<SessionCore | null>(null)
  if (coreRef.current === null) {
    coreRef.current = new SessionCore(depsRef.current)
  }
  const core = coreRef.current

  // Refresh the volatile deps after every render.
  useEffect(() => {
    const d = depsRef.current!
    const p = propsRef.current
    d.queryGuard = p.queryGuard
    d.getToolUseContext = p.getToolUseContext
    d.canUseTool = p.canUseTool
    d.store = p.store
    d.toolPermissionContext = p.toolPermissionContext
    d.setAppState = p.setAppState
    d.initialMcpClients = p.initialMcpClients
    d.mainThreadAgentDefinition = p.mainThreadAgentDefinition
    d.customSystemPrompt = p.customSystemPrompt
    d.appendSystemPrompt = p.appendSystemPrompt
    d.title = {
      disabled: p.titleDisabled,
      current: p.sessionTitle,
      agentTitle: p.agentTitle,
      onAutoTitle: t => propsRef.current.setAutoTitle(t),
    }
  })

  // React projection of core events. Handlers read setters off the live
  // carrier at call time, so one mount-time subscription covers the session.
  useEffect(() => {
    return core.subscribe((event: SessionEvent) => {
      const p = propsRef.current
      switch (event.type) {
        case 'turn_started':
          p.setResponseLength(() => 0)
          p.setStreamingToolUses([])
          p.setStreamingText(null)
          return
        case 'activity':
          if (event.activity) p.setStreamMode(event.activity)
          return
        case 'response_length_delta':
          p.setResponseLength(len => len + event.chars)
          return
        case 'streaming_text': {
          // The capability gate (reduced motion / viewport-yank bug) lives
          // in onStreamingText; the core owns the fold, the TUI renders its
          // word when the terminal can show it.
          const text = event.text
          p.onStreamingText(() => text)
          return
        }
        case 'streaming_tool_uses':
          p.setStreamingToolUses(event.toolUses)
          return
        case 'streaming_thinking':
          p.setStreamingThinking(event.thinking)
          return
        case 'transcript_replaced':
          // The new array already arrived via setMessages (the core wrote
          // through it); this is the one render-side reaction compaction
          // wants.
          if (event.reason === 'compact') {
            p.scrollRef.current?.scrollToBottom()
          }
          return
        case 'conversation_id':
          p.setConversationId(event.id)
          return
        default:
          // transcript_* mutations arrived through setMessages; surface
          // events (meta/todos/queue/tasks) are consumed by the wire
          // projector, not re-applied here.
          return
      }
    })
  }, [core])

  const onQueryEvent = useCallback(
    (event: Parameters<typeof handleMessageFromStream>[0]) => {
      core.handleStreamEvent(event)
    },
    [core],
  )

  const onQuery = useCallback(
    async (
      newMessages: MessageType[],
      abortController: AbortController,
      shouldQuery: boolean,
      additionalAllowedTools: string[],
      mainLoopModelParam: string,
      onBeforeQueryCallback?: (
        input: string,
        newMessages: MessageType[],
      ) => Promise<boolean>,
      input?: string,
      effort?: EffortValue,
    ): Promise<void> => {
      const p = propsRef.current
      p.resetTimingRefs()

      const result = await core.submitTurn({
        newMessages,
        abortController,
        shouldQuery,
        additionalAllowedTools,
        mainLoopModel: mainLoopModelParam,
        input,
        effort,
        proceedGate: onBeforeQueryCallback,
      })
      // A queued turn ran nothing beyond the enqueue; no post-turn
      // bookkeeping (the pre-core finally was skipped the same way).
      if (result === 'queued') return

      p.setLastQueryCompletionTime(Date.now())
      p.resetLoadingState()
      await p.mrOnTurnComplete(
        propsRef.current.messagesRef.current,
        abortController.signal.aborted,
      )

      const turnDurationMs =
        Date.now() - p.loadingStartTimeRef.current - p.totalPausedMsRef.current
      if (turnDurationMs > 30000 && !abortController.signal.aborted) {
        const prev = propsRef.current.messagesRef.current
        p.setMessages(prev => [
          ...prev,
          createTurnDurationMessage(
            turnDurationMs,
            count(prev, isLoggableMessage),
          ),
        ])
      }

      p.setAbortController(null)

      if (
        abortController.signal.reason === 'user-cancel' &&
        !p.queryGuard.isActive &&
        p.inputValueRef.current === '' &&
        getCommandQueueLength() === 0 &&
        !p.store.getState().viewingAgentTaskId
      ) {
        const msgs = propsRef.current.messagesRef.current
        const lastUserMsg = msgs.findLast(selectableUserMessagesFilter)
        if (lastUserMsg) {
          const idx = msgs.lastIndexOf(lastUserMsg)
          if (messagesAfterAreOnlySynthetic(msgs, idx)) {
            removeLastFromHistory()
            p.restoreMessageSyncRef.current(lastUserMsg)
          }
        }
      }
    },
    [core],
  )

  const handleIncomingPrompt = useCallback(
    (content: string, options?: { isMeta?: boolean }): boolean => {
      const p = propsRef.current
      if (p.queryGuard.isActive) return false

      if (
        getCommandQueue().some(
          cmd => cmd.mode === 'prompt' || cmd.mode === 'bash',
        )
      ) {
        return false
      }

      const newAbortController = createAbortController()
      p.setAbortController(newAbortController)

      const userMessage = createUserMessage({
        content,
        isMeta: options?.isMeta ? true : undefined,
      })

      void onQuery(
        [userMessage],
        newAbortController,
        true,
        [],
        p.store.getState().mainLoopModelForSession ??
          'claude-sonnet-4-20250514',
      )
      return true
    },
    [onQuery],
  )

  return {
    onQueryEvent,
    onQuery,
    handleIncomingPrompt,
  }
}
