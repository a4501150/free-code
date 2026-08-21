// This hook wraps the submission-related callbacks from REPL.tsx:
// - processInitialMessage effect
// - onSubmit callback
// - onAgentSubmit callback
// - handleOpenRateLimitOptions callback

import { feature } from 'bun:bundle'
import * as React from 'react'
import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { Text } from '../../ink.js'
import { logForDebugging } from '../../utils/debug.js'
import { errorMessage } from '../../utils/errors.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { getOriginalCwd, getSessionId } from '../../bootstrap/state.js'
import { clearConversation } from '../../commands/clear/conversation.js'
import { getPlanSlug, setPlanSlug } from '../../utils/plans.js'
import {
  fileHistoryEnabled,
  fileHistoryMakeSnapshot,
} from '../../utils/fileHistory.js'
import type { FileHistoryState } from '../../utils/fileHistory.js'
import { applyPermissionUpdates } from '../../utils/permissions/PermissionUpdate.js'
import { buildPermissionUpdates } from '../../components/permissions/ExitPlanModePermissionRequest/ExitPlanModePermissionRequest.js'
import { stripDangerousPermissionsForAutoMode } from '../../utils/permissions/permissionSetup.js'
import { createAbortController } from '../../utils/abortController.js'
import { createUserMessage, getContentText } from '../../utils/messages.js'
import {
  handlePromptSubmit,
  type PromptInputHelpers,
} from '../../utils/handlePromptSubmit.js'
import { getQuerySourceForREPL } from '../../utils/promptCategory.js'
import {
  addToHistory,
  expandPastedTextRefs,
  parseReferences,
} from '../../history.js'
import { prependModeCharacterToInput } from '../../components/PromptInput/inputModes.js'
import { prependToShellHistoryCache } from '../../utils/suggestions/shellHistoryCompletion.js'
import {
  handleSpeculationAccept,
  type ActiveSpeculationState,
} from '../../services/PromptSuggestion/speculation.js'
import {
  isLocalAgentTask,
  queuePendingMessage,
  appendMessageToLocalAgent,
} from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { injectUserMessageToTeammate } from '../../tasks/InProcessTeammateTask/InProcessTeammateTask.js'
import { resumeAgentBackground } from '../../tools/AgentTool/resumeAgent.js'
import {
  getCommandName,
  isCommandEnabled,
  type Command,
  type CommandResultDisplay,
} from '../../commands.js'
import type {
  PromptInputMode,
  QueuedCommand,
} from '../../types/textInputTypes.js'
import type {
  Message as MessageType,
  UserMessage,
} from '../../types/message.js'
import type { PastedContent } from '../../utils/config.js'
import type { SetAppState } from '../../utils/messageQueueManager.js'
import type { LocalAgentTaskState } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import type { InProcessTeammateTaskState } from '../../tasks/InProcessTeammateTask/types.js'

// Dead code elimination
/* eslint-disable @typescript-eslint/no-require-imports */
const proactiveModule = feature('KAIROS')
  ? require('../../proactive/index.js')
  : null
/* eslint-enable @typescript-eslint/no-require-imports */

export function useReplSubmission(deps: {
  // All dependencies from REPL closure
  initialMessage: any
  isLoading: boolean
  setMessages: (action: React.SetStateAction<MessageType[]>) => void
  setAppState: (fn: (prev: any) => any) => void
  onQuery: any
  mainLoopModel: string
  repinScroll: () => void
  onSubmit_deps: {
    queryGuard: any
    isExternalLoading: boolean
    inputMode: PromptInputMode
    commands: Command[]
    setInputValue: (value: string) => void
    setInputMode: (mode: PromptInputMode) => void
    setPastedContents: React.Dispatch<
      React.SetStateAction<Record<number, PastedContent>>
    >
    setSubmitCount: React.Dispatch<React.SetStateAction<number>>
    setIDESelection: (sel: any) => void
    setToolJSX: (args: any) => void
    getToolUseContext: any
    messagesRef: React.RefObject<MessageType[]>
    pastedContents: Record<number, PastedContent>
    ideSelection: any
    setUserInputOnProcessing: (input: string | undefined) => void
    setAbortController: (controller: AbortController | null) => void
    abortController: AbortController | null
    addNotification: (n: any) => void
    stashedPrompt: any
    setStashedPrompt: (p: any) => void
    onBeforeQuery: any
    canUseTool: any
    awaitPendingHooks: () => Promise<void>
    inputValueRef: React.RefObject<string>
    streamModeRef: React.RefObject<any>
    hasInterruptibleToolInProgressRef: { current: boolean }
    readFileState: React.RefObject<any>
    resetTimingRefs: () => void
    tipPickedThisTurnRef: React.RefObject<boolean>
  }
  store: any
  readFileState: React.RefObject<any>
  loadedNestedMemoryPathsRef: React.RefObject<Set<string>>
  scrollRef: React.RefObject<any>
  setConversationId: (id: any) => void
  autoTitleAttemptedRef: React.MutableRefObject<boolean>
  setAutoTitle: (title: string | undefined) => void
  bashTools: React.RefObject<Set<string>>
  bashToolsProcessedIdx: React.RefObject<number>
  setAbortController: (controller: AbortController | null) => void
}) {
  const {
    initialMessage,
    isLoading,
    setMessages,
    setAppState,
    onQuery,
    mainLoopModel,
    repinScroll,
    onSubmit_deps: d,
    store,
    readFileState,
    loadedNestedMemoryPathsRef,
    scrollRef,
    setConversationId,
    autoTitleAttemptedRef,
    setAutoTitle,
    bashTools,
    bashToolsProcessedIdx,
    setAbortController,
  } = deps

  // ── processInitialMessage ──
  const initialMessageRef = useRef(false)
  useEffect(() => {
    const pending = initialMessage
    if (!pending || isLoading || initialMessageRef.current) return
    initialMessageRef.current = true

    async function processInitialMessage(
      initialMsg: NonNullable<typeof pending>,
    ) {
      if (initialMsg.clearContext) {
        const oldPlanSlug = initialMsg.message.planContent
          ? getPlanSlug()
          : undefined

        await clearConversation({
          setMessages,
          readFileState: readFileState.current,
          loadedNestedMemoryPaths: loadedNestedMemoryPathsRef.current,
          getAppState: () => store.getState(),
          setAppState,
          setConversationId,
          scrollToBottom: () => scrollRef.current?.scrollToBottom(),
        })
        autoTitleAttemptedRef.current = false
        setAutoTitle(undefined)
        bashTools.current.clear()
        bashToolsProcessedIdx.current = 0

        if (oldPlanSlug) {
          setPlanSlug(getSessionId(), oldPlanSlug)
        }
      }

      setAppState(prev => {
        let updatedToolPermissionContext = initialMsg.mode
          ? applyPermissionUpdates(
              prev.toolPermissionContext,
              buildPermissionUpdates(initialMsg.mode),
            )
          : prev.toolPermissionContext
        if (initialMsg.mode === 'auto') {
          updatedToolPermissionContext = stripDangerousPermissionsForAutoMode({
            ...updatedToolPermissionContext,
            mode: 'auto',
            prePlanMode: undefined,
          })
        }

        const base = {
          ...prev,
          initialMessage: null,
          toolPermissionContext: updatedToolPermissionContext,
        }
        if (
          feature('VERIFY_PLAN') &&
          isEnvTruthy(process.env.CLAUDE_CODE_VERIFY_PLAN) &&
          initialMsg.message.planContent
        ) {
          return {
            ...base,
            pendingPlanVerification: {
              plan: initialMsg.message.planContent as string,
              verificationStarted: false,
              verificationCompleted: false,
            },
          }
        }
        return base
      })

      if (fileHistoryEnabled()) {
        void fileHistoryMakeSnapshot(
          (updater: (prev: FileHistoryState) => FileHistoryState) => {
            setAppState(prev => ({
              ...prev,
              fileHistory: updater(prev.fileHistory),
            }))
          },
          initialMsg.message.uuid,
        )
      }

      await d.awaitPendingHooks()

      const content = initialMsg.message.message.content

      if (typeof content === 'string' && !initialMsg.message.planContent) {
        void onSubmit(content, {
          setCursorOffset: () => {},
          clearBuffer: () => {},
          resetHistory: () => {},
        })
        if (initialMsg.clearContext) {
          setTimeout(repinScroll, 0)
        }
      } else {
        const newAbortController = createAbortController()
        setAbortController(newAbortController)
        void onQuery(
          [initialMsg.message],
          newAbortController,
          true,
          [],
          mainLoopModel,
        )
        setTimeout(repinScroll, 0)
      }

      setTimeout(
        ref => {
          ref.current = false
        },
        100,
        initialMessageRef,
      )
    }

    void processInitialMessage(pending)
  }, [
    initialMessage,
    isLoading,
    setMessages,
    setAppState,
    onQuery,
    mainLoopModel,
    repinScroll,
  ])

  // ── onSubmit ──
  const onSubmit = useCallback(
    async (
      input: string,
      helpers: PromptInputHelpers,
      speculationAccept?: {
        state: ActiveSpeculationState
        speculationSessionTimeSavedMs: number
        setAppState: SetAppState
      },
      options?: { fromKeybinding?: boolean },
    ) => {
      repinScroll()

      if (feature('KAIROS')) {
        proactiveModule?.resumeProactive()
      }

      if (!speculationAccept && input.trim().startsWith('/')) {
        const trimmedInput = expandPastedTextRefs(
          input,
          d.pastedContents,
        ).trim()
        const spaceIndex = trimmedInput.indexOf(' ')
        const commandName =
          spaceIndex === -1
            ? trimmedInput.slice(1)
            : trimmedInput.slice(1, spaceIndex)
        const commandArgs =
          spaceIndex === -1 ? '' : trimmedInput.slice(spaceIndex + 1).trim()

        const matchingCommand = d.commands.find(
          cmd =>
            isCommandEnabled(cmd) &&
            (cmd.name === commandName ||
              cmd.aliases?.includes(commandName) ||
              getCommandName(cmd) === commandName),
        )
        const shouldTreatAsImmediate =
          d.queryGuard.isActive &&
          (matchingCommand?.immediate || options?.fromKeybinding)

        if (
          matchingCommand &&
          shouldTreatAsImmediate &&
          matchingCommand.type === 'local-jsx'
        ) {
          if (input.trim() === d.inputValueRef.current.trim()) {
            d.setInputValue('')
            helpers.setCursorOffset(0)
            helpers.clearBuffer()
            d.setPastedContents({})
          }

          const executeImmediateCommand = async (): Promise<void> => {
            let doneWasCalled = false
            const onDone = (
              result?: string,
              doneOptions?: {
                display?: CommandResultDisplay
                metaMessages?: string[]
              },
            ): void => {
              doneWasCalled = true
              d.setToolJSX({
                jsx: null,
                shouldHidePromptInput: false,
                clearLocalJSX: true,
              })
              const newMessages: MessageType[] = []
              if (result && doneOptions?.display !== 'skip') {
                d.addNotification({
                  key: `immediate-${matchingCommand.name}`,
                  text: result,
                  priority: 'immediate',
                })
              }
              if (doneOptions?.metaMessages?.length) {
                newMessages.push(
                  ...doneOptions.metaMessages.map(content =>
                    createUserMessage({ content, isMeta: true }),
                  ),
                )
              }
              if (newMessages.length) {
                setMessages(prev => [...prev, ...newMessages])
              }
              if (d.stashedPrompt !== undefined) {
                d.setInputValue(d.stashedPrompt.text)
                helpers.setCursorOffset(d.stashedPrompt.cursorOffset)
                d.setPastedContents(d.stashedPrompt.pastedContents)
                d.setStashedPrompt(undefined)
              }
            }

            const context = d.getToolUseContext(
              d.messagesRef.current,
              [],
              createAbortController(),
              mainLoopModel,
            )

            const jsx = await matchingCommand.call(onDone, context, commandArgs)

            if (jsx && !doneWasCalled) {
              d.setToolJSX({
                jsx,
                shouldHidePromptInput: false,
                isLocalJSXCommand: true,
              })
            }
          }
          void executeImmediateCommand()
          return
        }
      }

      if (!options?.fromKeybinding) {
        addToHistory({
          display: speculationAccept
            ? input
            : prependModeCharacterToInput(input, d.inputMode),
          pastedContents: speculationAccept ? {} : d.pastedContents,
        })
        if (d.inputMode === 'bash') {
          prependToShellHistoryCache(input.trim())
        }
      }

      const isSlashCommand = !speculationAccept && input.trim().startsWith('/')
      const submitsNow = !isLoading || speculationAccept
      if (d.stashedPrompt !== undefined && !isSlashCommand && submitsNow) {
        d.setInputValue(d.stashedPrompt.text)
        helpers.setCursorOffset(d.stashedPrompt.cursorOffset)
        d.setPastedContents(d.stashedPrompt.pastedContents)
        d.setStashedPrompt(undefined)
      } else if (submitsNow) {
        if (!options?.fromKeybinding) {
          d.setInputValue('')
          helpers.setCursorOffset(0)
        }
        d.setPastedContents({})
      }

      if (submitsNow) {
        d.setInputMode('prompt')
        d.setIDESelection(undefined)
        d.setSubmitCount(_ => _ + 1)
        helpers.clearBuffer()
        d.tipPickedThisTurnRef.current = false

        if (!isSlashCommand && d.inputMode === 'prompt' && !speculationAccept) {
          d.setUserInputOnProcessing(input)
          d.resetTimingRefs()
        }
      }

      if (speculationAccept) {
        const { queryRequired } = await handleSpeculationAccept(
          speculationAccept.state,
          speculationAccept.speculationSessionTimeSavedMs,
          speculationAccept.setAppState,
          input,
          {
            setMessages,
            readFileState: d.readFileState,
            cwd: getOriginalCwd(),
          },
        )
        if (queryRequired) {
          const newAbortController = createAbortController()
          d.setAbortController(newAbortController)
          void onQuery([], newAbortController, true, [], mainLoopModel)
        }
        return
      }

      await d.awaitPendingHooks()

      await handlePromptSubmit({
        input,
        helpers,
        queryGuard: d.queryGuard,
        isExternalLoading: d.isExternalLoading,
        mode: d.inputMode,
        commands: d.commands,
        onInputChange: d.setInputValue,
        setPastedContents: d.setPastedContents,
        setToolJSX: d.setToolJSX,
        getToolUseContext: d.getToolUseContext,
        messages: d.messagesRef.current,
        mainLoopModel,
        pastedContents: d.pastedContents,
        ideSelection: d.ideSelection,
        setUserInputOnProcessing: d.setUserInputOnProcessing,
        setAbortController: d.setAbortController,
        abortController: d.abortController,
        onQuery,
        setAppState,
        querySource: getQuerySourceForREPL(),
        onBeforeQuery: d.onBeforeQuery,
        canUseTool: d.canUseTool,
        addNotification: d.addNotification,
        setMessages,
        streamMode: d.streamModeRef.current,
        hasInterruptibleToolInProgress:
          d.hasInterruptibleToolInProgressRef.current,
      })

      if ((isSlashCommand || isLoading) && d.stashedPrompt !== undefined) {
        d.setInputValue(d.stashedPrompt.text)
        helpers.setCursorOffset(d.stashedPrompt.cursorOffset)
        d.setPastedContents(d.stashedPrompt.pastedContents)
        d.setStashedPrompt(undefined)
      }
    },
    [
      d.queryGuard,
      isLoading,
      d.isExternalLoading,
      d.inputMode,
      d.commands,
      d.setInputValue,
      d.setInputMode,
      d.setPastedContents,
      d.setSubmitCount,
      d.setIDESelection,
      d.setToolJSX,
      d.getToolUseContext,
      mainLoopModel,
      d.pastedContents,
      d.ideSelection,
      d.setUserInputOnProcessing,
      d.setAbortController,
      d.addNotification,
      onQuery,
      d.stashedPrompt,
      d.setStashedPrompt,
      setAppState,
      d.onBeforeQuery,
      d.canUseTool,
      setMessages,
      d.awaitPendingHooks,
      repinScroll,
    ],
  )

  // ── onAgentSubmit ──
  const onAgentSubmit = useCallback(
    async (
      input: string,
      task: InProcessTeammateTaskState | LocalAgentTaskState,
      helpers: PromptInputHelpers,
    ) => {
      if (isLocalAgentTask(task)) {
        appendMessageToLocalAgent(
          task.id,
          createUserMessage({ content: input }),
          setAppState,
        )
        if (task.status === 'running') {
          queuePendingMessage(task.id, input, setAppState)
        } else {
          void resumeAgentBackground({
            agentId: task.id,
            prompt: input,
            toolUseContext: d.getToolUseContext(
              d.messagesRef.current,
              [],
              new AbortController(),
              mainLoopModel,
            ),
            canUseTool: d.canUseTool,
          }).catch(err => {
            logForDebugging(
              `resumeAgentBackground failed: ${errorMessage(err)}`,
            )
            d.addNotification({
              key: `resume-agent-failed-${task.id}`,
              jsx: (
                <Text color="error">
                  Failed to resume agent: {errorMessage(err)}
                </Text>
              ),
              priority: 'low',
            })
          })
        }
      } else {
        injectUserMessageToTeammate(task.id, input, setAppState)
      }
      d.setInputValue('')
      helpers.setCursorOffset(0)
      helpers.clearBuffer()
    },
    [
      setAppState,
      d.setInputValue,
      d.getToolUseContext,
      d.canUseTool,
      mainLoopModel,
      d.addNotification,
    ],
  )

  // ── handleOpenRateLimitOptions ──
  const onSubmitRef = useRef(onSubmit)
  onSubmitRef.current = onSubmit
  const handleOpenRateLimitOptions = useCallback(() => {
    void onSubmitRef.current('/rate-limit-options', {
      setCursorOffset: () => {},
      clearBuffer: () => {},
      resetHistory: () => {},
    })
  }, [])

  return { onSubmit, onAgentSubmit, handleOpenRateLimitOptions }
}
