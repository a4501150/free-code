import { feature } from 'bun:bundle'
import { useCallback } from 'react'
import { randomUUID } from 'crypto'
import { count } from '../../utils/array.js'
import { logForDebugging } from '../../utils/debug.js'
import { logError } from '../../utils/log.js'
import { isHumanTurn } from '../../utils/messagePredicates.js'
import {
  getOriginalCwd,
  getSessionId,
  resetTurnHookDuration,
  resetTurnToolDuration,
  resetTurnClassifierDuration,
} from '../../bootstrap/state.js'
import { query } from '../../query.js'
import { mergeClients } from '../useMergedClients.js'
import { getQuerySourceForREPL } from '../../utils/promptCategory.js'
import {
  queryCheckpoint,
  logQueryProfileReport,
} from '../../utils/queryProfiler.js'
import { getSystemPrompt } from '../../constants/prompts.js'
import { buildEffectiveSystemPrompt } from '../../utils/systemPrompt.js'
import { getSystemContext, getUserContext } from '../../context.js'
import {
  checkAndDisableBypassPermissionsIfNeeded,
  checkAndDisableAutoModeIfNeeded,
} from '../../utils/permissions/bypassPermissionsKillswitch.js'
import {
  getScratchpadDir,
  isScratchpadEnabled,
} from '../../utils/permissions/filesystem.js'
import { maybeMarkProjectOnboardingComplete } from '../../projectOnboardingState.js'
import { closeOpenDiffs, getConnectedIdeClient } from '../../utils/ide.js'
import { diagnosticTracker } from '../../services/diagnosticTracking.js'
import { generateSessionTitle } from '../../utils/sessionTitle.js'
import { saveAiGeneratedTitle } from '../../utils/sessionStorage.js'
import {
  handleMessageFromStream,
  isCompactBoundaryMessage,
  getMessagesAfterCompactBoundary,
  getContentText,
  createUserMessage,
  createAssistantMessage,
  createTurnDurationMessage,
} from '../../utils/messages.js'
import {
  removeTranscriptMessage,
  isLoggableMessage,
  isEphemeralToolProgress,
} from '../../utils/sessionStorage.js'
import {
  BASH_INPUT_TAG,
  COMMAND_MESSAGE_TAG,
  COMMAND_NAME_TAG,
  LOCAL_COMMAND_STDOUT_TAG,
} from '../../constants/xml.js'
import { setMemberActive } from '../../utils/swarm/teamHelpers.js'
import { getTeamName, getAgentName } from '../../utils/teammate.js'
import { isAgentSwarmsEnabled } from '../../utils/agentSwarmsEnabled.js'
import {
  enqueue,
  getCommandQueue,
  getCommandQueueLength,
} from '../../utils/messageQueueManager.js'
import {
  selectableUserMessagesFilter,
  messagesAfterAreOnlySynthetic,
} from '../../components/MessageSelector.js'
import { removeLastFromHistory } from '../../history.js'
import { getAllInProcessTeammateTasks } from '../../tasks/InProcessTeammateTask/InProcessTeammateTask.js'
import { createAbortController } from '../../utils/abortController.js'
import type {
  Message as MessageType,
  UserMessage,
} from '../../types/message.js'
import type { EffortValue } from '../../utils/effort.js'
import type { ProcessUserInputContext } from '../../utils/processUserInput/processUserInput.js'
import type { AgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js'
import type { MCPServerConnection } from '../../services/mcp/types.js'
import type { UUID } from 'crypto'
import type { QueryGuard } from '../../utils/QueryGuard.js'
import type { SpinnerMode } from '../../components/Spinner.js'
import type {
  StreamingToolUse,
  StreamingThinking,
} from '../../utils/messages.js'

// Dead code elimination: conditional import for coordinator mode
/* eslint-disable @typescript-eslint/no-require-imports */
const coordinatorModeModule = feature('COORDINATOR_MODE')
  ? (require('../../coordinator/coordinatorMode.js') as typeof import('../../coordinator/coordinatorMode.js'))
  : null
const getCoordinatorUserContext: (
  mcpClients: ReadonlyArray<{ name: string }>,
  scratchpadDir?: string,
) => { [k: string]: string } =
  coordinatorModeModule?.getCoordinatorUserContext ?? (() => ({}))
/* eslint-enable @typescript-eslint/no-require-imports */

// Dead code elimination: conditional import for loop mode
/* eslint-disable @typescript-eslint/no-require-imports */
const proactiveModule = feature('KAIROS')
  ? require('../../proactive/index.js')
  : null
/* eslint-enable @typescript-eslint/no-require-imports */

export function useReplQueryExecution({
  messagesRef,
  setMessages,
  setStreamMode,
  setStreamingToolUses,
  setStreamingThinking,
  setStreamingText,
  setResponseLength,
  onStreamingText,
  setSpinnerMessage,
  setSpinnerColor,
  setSpinnerShimmerColor,
  setCompactingStartTime,
  resetLoadingState,
  resetTimingRefs,
  queryGuard,
  setAbortController,
  scrollRef,
  setConversationId,
  setLastQueryCompletionTime,
  setAutoTitle,
  autoTitleAttemptedRef,
  setUserInputOnProcessing,
  inputValueRef,
  loadingStartTimeRef,
  totalPausedMsRef,
  swarmStartTimeRef,
  restoreMessageSyncRef,
  getToolUseContext,
  mainThreadAgentDefinition,
  initialMcpClients,
  toolPermissionContext,
  setAppState,
  store,
  customSystemPrompt,
  appendSystemPrompt,
  canUseTool,
  onBeforeQuery,
  onTurnComplete,
  mrOnBeforeQuery,
  mrOnTurnComplete,
  titleDisabled,
  sessionTitle,
  agentTitle,
  proactiveActive,
}: {
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
  swarmStartTimeRef: React.MutableRefObject<number | null>
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
  proactiveActive: boolean
}) {
  const onQueryEvent = useCallback(
    (event: Parameters<typeof handleMessageFromStream>[0]) => {
      handleMessageFromStream(
        event,
        newMessage => {
          if (isCompactBoundaryMessage(newMessage)) {
            setMessages(old => [
              ...getMessagesAfterCompactBoundary(old),
              newMessage,
            ])
            setConversationId(randomUUID())
            scrollRef.current?.scrollToBottom()
            if (feature('KAIROS')) {
              proactiveModule?.setContextBlocked(false)
            }
          } else if (
            newMessage.type === 'progress' &&
            isEphemeralToolProgress(newMessage.data.type)
          ) {
            setMessages(oldMessages => {
              const last = oldMessages.at(-1)
              if (
                last?.type === 'progress' &&
                last.parentToolUseID === newMessage.parentToolUseID &&
                last.data.type === newMessage.data.type
              ) {
                const copy = oldMessages.slice()
                copy[copy.length - 1] = newMessage
                return copy
              }
              return [...oldMessages, newMessage]
            })
          } else {
            setMessages(oldMessages => [...oldMessages, newMessage])
          }
          if (feature('KAIROS')) {
            if (
              newMessage.type === 'assistant' &&
              'isApiErrorMessage' in newMessage &&
              newMessage.isApiErrorMessage
            ) {
              proactiveModule?.setContextBlocked(true)
            } else if (newMessage.type === 'assistant') {
              proactiveModule?.setContextBlocked(false)
            }
          }
        },
        newContent => {
          setResponseLength(length => length + newContent.length)
        },
        setStreamMode,
        setStreamingToolUses,
        tombstonedMessage => {
          setMessages(oldMessages =>
            oldMessages.filter(m => m !== tombstonedMessage),
          )
          void removeTranscriptMessage(tombstonedMessage.uuid)
        },
        setStreamingThinking,
        undefined,
        onStreamingText,
      )
    },
    [
      setMessages,
      setResponseLength,
      setStreamMode,
      setStreamingToolUses,
      setStreamingThinking,
      onStreamingText,
      scrollRef,
      setConversationId,
    ],
  )

  const onQueryImpl = useCallback(
    async (
      messagesIncludingNewMessages: MessageType[],
      newMessages: MessageType[],
      abortController: AbortController,
      shouldQuery: boolean,
      additionalAllowedTools: string[],
      mainLoopModelParam: string,
      effort?: EffortValue,
    ) => {
      if (shouldQuery) {
        const freshClients = mergeClients(
          initialMcpClients,
          store.getState().mcp.clients,
        )
        void diagnosticTracker.handleQueryStart(freshClients)
        const ideClient = getConnectedIdeClient(freshClients)
        if (ideClient) {
          void closeOpenDiffs(ideClient)
        }
      }

      void maybeMarkProjectOnboardingComplete()

      if (
        !titleDisabled &&
        !sessionTitle &&
        !agentTitle &&
        !autoTitleAttemptedRef.current
      ) {
        const firstUserMessage = newMessages.find(
          m => m.type === 'user' && !m.isMeta,
        )
        const text =
          firstUserMessage?.type === 'user'
            ? getContentText(firstUserMessage.message.content)
            : null
        if (
          text &&
          !text.startsWith(`<${LOCAL_COMMAND_STDOUT_TAG}>`) &&
          !text.startsWith(`<${COMMAND_MESSAGE_TAG}>`) &&
          !text.startsWith(`<${COMMAND_NAME_TAG}>`) &&
          !text.startsWith(`<${BASH_INPUT_TAG}>`)
        ) {
          autoTitleAttemptedRef.current = true
          void generateSessionTitle(text, new AbortController().signal).then(
            title => {
              if (title) {
                setAutoTitle(title)
                saveAiGeneratedTitle(getSessionId() as UUID, title)
              } else autoTitleAttemptedRef.current = false
            },
            () => {
              autoTitleAttemptedRef.current = false
            },
          )
        }
      }

      store.setState(prev => {
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
          setConversationId(randomUUID())
          if (feature('KAIROS')) {
            proactiveModule?.setContextBlocked(false)
          }
        }
        resetLoadingState()
        setAbortController(null)
        return
      }

      const toolUseContext = getToolUseContext(
        messagesIncludingNewMessages,
        newMessages,
        abortController,
        mainLoopModelParam,
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
            toolPermissionContext,
            setAppState,
          ),
          checkAndDisableAutoModeIfNeeded(
            toolPermissionContext,
            setAppState,
            store.getState().fastMode,
          ),
          getSystemPrompt(
            freshTools,
            mainLoopModelParam,
            Array.from(
              toolPermissionContext.additionalWorkingDirectories.keys(),
            ),
            freshMcpClients,
          ),
          getUserContext(),
          getSystemContext(),
        ])
      const userContext = {
        ...baseUserContext,
        ...getCoordinatorUserContext(
          freshMcpClients,
          isScratchpadEnabled() ? getScratchpadDir() : undefined,
        ),
      }
      queryCheckpoint('query_context_loading_end')

      const systemPrompt = buildEffectiveSystemPrompt({
        mainThreadAgentDefinition,
        toolUseContext,
        customSystemPrompt,
        defaultSystemPrompt,
        appendSystemPrompt,
      })
      toolUseContext.renderedSystemPrompt = systemPrompt

      queryCheckpoint('query_query_start')
      resetTurnHookDuration()
      resetTurnToolDuration()
      resetTurnClassifierDuration()

      for await (const event of query({
        messages: messagesIncludingNewMessages,
        systemPrompt,
        userContext,
        systemContext,
        canUseTool,
        toolUseContext,
        querySource: getQuerySourceForREPL(),
      })) {
        onQueryEvent(event)
      }

      queryCheckpoint('query_end')
      resetLoadingState()
      logQueryProfileReport()
      await onTurnComplete?.(messagesRef.current)
    },
    [
      initialMcpClients,
      resetLoadingState,
      getToolUseContext,
      toolPermissionContext,
      setAppState,
      customSystemPrompt,
      onTurnComplete,
      appendSystemPrompt,
      canUseTool,
      mainThreadAgentDefinition,
      onQueryEvent,
      sessionTitle,
      titleDisabled,
      agentTitle,
      autoTitleAttemptedRef,
      setAutoTitle,
      store,
      setAbortController,
      setConversationId,
      messagesRef,
    ],
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
      if (isAgentSwarmsEnabled()) {
        const teamName = getTeamName()
        const agentName = getAgentName()
        if (teamName && agentName) {
          void setMemberActive(teamName, agentName, true)
        }
      }

      const thisGeneration = queryGuard.tryStart()
      if (thisGeneration === null) {
        newMessages
          .filter((m): m is UserMessage => m.type === 'user' && !m.isMeta)
          .map(_ => getContentText(_.message.content))
          .filter(_ => _ !== null)
          .forEach((msg, i) => {
            enqueue({ value: msg, mode: 'prompt' })
          })
        return
      }

      try {
        resetTimingRefs()
        setMessages(oldMessages => [...oldMessages, ...newMessages])
        setResponseLength(_ => 0)
        setStreamingToolUses([])
        setStreamingText(null)

        const latestMessages = messagesRef.current

        if (input) {
          await mrOnBeforeQuery(input, latestMessages, newMessages.length)
        }

        if (onBeforeQueryCallback && input) {
          const shouldProceed = await onBeforeQueryCallback(
            input,
            latestMessages,
          )
          if (!shouldProceed) {
            return
          }
        }

        await onQueryImpl(
          latestMessages,
          newMessages,
          abortController,
          shouldQuery,
          additionalAllowedTools,
          mainLoopModelParam,
          effort,
        ).catch(e => {
          logError(e)
          throw e
        })
      } finally {
        if (queryGuard.end(thisGeneration)) {
          setLastQueryCompletionTime(Date.now())
          resetLoadingState()

          await mrOnTurnComplete(
            messagesRef.current,
            abortController.signal.aborted,
          )

          const turnDurationMs =
            Date.now() - loadingStartTimeRef.current - totalPausedMsRef.current
          if (
            turnDurationMs > 30000 &&
            !abortController.signal.aborted &&
            !proactiveActive
          ) {
            const hasRunningSwarmAgents = getAllInProcessTeammateTasks(
              store.getState().tasks,
            ).some(t => t.status === 'running')
            if (hasRunningSwarmAgents) {
              if (swarmStartTimeRef.current === null) {
                swarmStartTimeRef.current = loadingStartTimeRef.current
              }
            } else {
              setMessages(prev => [
                ...prev,
                createTurnDurationMessage(
                  turnDurationMs,
                  count(prev, isLoggableMessage),
                ),
              ])
            }
          }

          setAbortController(null)
        }

        if (
          abortController.signal.reason === 'user-cancel' &&
          !queryGuard.isActive &&
          inputValueRef.current === '' &&
          getCommandQueueLength() === 0 &&
          !store.getState().viewingAgentTaskId
        ) {
          const msgs = messagesRef.current
          const lastUserMsg = msgs.findLast(selectableUserMessagesFilter)
          if (lastUserMsg) {
            const idx = msgs.lastIndexOf(lastUserMsg)
            if (messagesAfterAreOnlySynthetic(msgs, idx)) {
              removeLastFromHistory()
              restoreMessageSyncRef.current(lastUserMsg)
            }
          }
        }
      }
    },
    [
      onQueryImpl,
      setAppState,
      resetLoadingState,
      queryGuard,
      mrOnBeforeQuery,
      mrOnTurnComplete,
      resetTimingRefs,
      setMessages,
      setResponseLength,
      setStreamingToolUses,
      setStreamingText,
      messagesRef,
      setAbortController,
      setConversationId,
      setLastQueryCompletionTime,
      inputValueRef,
      loadingStartTimeRef,
      totalPausedMsRef,
      swarmStartTimeRef,
      restoreMessageSyncRef,
      store,
      proactiveActive,
    ],
  )

  const handleIncomingPrompt = useCallback(
    (content: string, options?: { isMeta?: boolean }): boolean => {
      if (queryGuard.isActive) return false

      if (
        getCommandQueue().some(
          cmd => cmd.mode === 'prompt' || cmd.mode === 'bash',
        )
      ) {
        return false
      }

      const newAbortController = createAbortController()
      setAbortController(newAbortController)

      const userMessage = createUserMessage({
        content,
        isMeta: options?.isMeta ? true : undefined,
      })

      void onQuery(
        [userMessage],
        newAbortController,
        true,
        [],
        store.getState().mainLoopModelForSession ?? 'claude-sonnet-4-20250514',
      )
      return true
    },
    [onQuery, store, queryGuard, setAbortController],
  )

  return {
    onQueryEvent,
    onQueryImpl,
    onQuery,
    handleIncomingPrompt,
  }
}
