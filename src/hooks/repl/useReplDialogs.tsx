import { feature } from 'bun:bundle'
import {
  useState,
  useRef,
  useCallback,
  useEffect,
  useLayoutEffect,
} from 'react'
import * as React from 'react'
import { Text } from '../../ink.js'
import { logForDebugging } from '../../utils/debug.js'
import { errorMessage } from '../../utils/errors.js'
import { gracefulShutdownSync } from '../../utils/gracefulShutdown.js'
import { isAgentSwarmsEnabled } from '../../utils/agentSwarmsEnabled.js'
import {
  isSwarmWorker,
  generateSandboxRequestId,
  sendSandboxPermissionRequestViaMailbox,
  sendSandboxPermissionResponseViaMailbox,
} from '../../utils/swarm/permissionSync.js'
import { registerSandboxPermissionCallback } from '../useSwarmPermissionPoller.js'
import {
  registerLeaderToolUseConfirmQueue,
  unregisterLeaderToolUseConfirmQueue,
  registerLeaderSetToolPermissionContext,
  unregisterLeaderSetToolPermissionContext,
} from '../../utils/swarm/leaderPermissionBridge.js'
import { popAllEditable } from '../../utils/messageQueueManager.js'
import {
  createAssistantMessage,
  createAgentsKilledMessage,
} from '../../utils/messages.js'
import { SandboxManager } from '../../utils/sandbox/sandbox-adapter.js'
import useCanUseTool from '../useCanUseTool.js'
import type { ToolUseConfirm } from '../../components/permissions/PermissionRequest.js'
import type { ToolPermissionContext } from '../../Tool.js'
import type { PromptRequest, PromptResponse } from '../../types/hooks.js'
import type {
  SandboxAskCallback,
  NetworkHostPattern,
} from '../../utils/sandbox/sandbox-adapter.js'
import type { Message as MessageType } from '../../types/message.js'
import type { PastedContent } from '../../utils/config.js'
import type { PromptInputMode } from '../../types/textInputTypes.js'
import type { SpinnerMode } from '../../components/Spinner.js'

// Dead code elimination: conditional import for proactive
/* eslint-disable @typescript-eslint/no-require-imports */
const proactiveModule = feature('KAIROS')
  ? require('../../proactive/index.js')
  : null
/* eslint-enable @typescript-eslint/no-require-imports */

export function useReplDialogs({
  toolJSX,
  isShowingLocalJSXCommand,
  isExiting,
  exitFlow,
  isMessageSelectorVisible,
  showIdeOnboarding,
  isPromptInputActive,
  workerSandboxPermissions,
  elicitation,
  isLoading,
  focusedInputDialogRef,
  pauseStartTimeRef,
  totalPausedMsRef,
  repinScroll,
  setMessages,
  messagesRef,
  streamingText,
  streamMode,
  queryGuard,
  resetLoadingState,
  abortController,
  setAbortController,
  setAppState,
  store,
  addNotification,
  mrOnTurnComplete,
  inputValue,
  inputValueRef,
  setInputValue,
  setInputMode,
  setPastedContents,
  stashedPrompt,
  setStashedPrompt,
  showBashesDialog,
  vimMode,
  isSearchingHistory,
  isHelpOpen,
  inputMode,
  screen,
  pendingWorkerRequest,
  pendingSandboxRequest,
}: {
  toolJSX: any
  isShowingLocalJSXCommand: boolean
  isExiting: boolean
  exitFlow: React.ReactNode
  isMessageSelectorVisible: boolean
  showIdeOnboarding: boolean
  isPromptInputActive: boolean
  workerSandboxPermissions: any
  elicitation: any
  isLoading: boolean
  focusedInputDialogRef: React.MutableRefObject<any>
  pauseStartTimeRef: React.MutableRefObject<number | null>
  totalPausedMsRef: React.MutableRefObject<number>
  repinScroll: () => void
  setMessages: (action: React.SetStateAction<MessageType[]>) => void
  messagesRef: React.RefObject<MessageType[]>
  streamingText: string | null
  streamMode: SpinnerMode
  queryGuard: any
  resetLoadingState: () => void
  abortController: AbortController | null
  setAbortController: (controller: AbortController | null) => void
  setAppState: (fn: (prev: any) => any) => void
  store: any
  addNotification: (n: any) => void
  mrOnTurnComplete: (messages: MessageType[], aborted: boolean) => Promise<void>
  inputValue: string
  inputValueRef: React.RefObject<string>
  setInputValue: (value: string) => void
  setInputMode: (mode: PromptInputMode) => void
  setPastedContents: React.Dispatch<
    React.SetStateAction<Record<number, PastedContent>>
  >
  stashedPrompt: any
  setStashedPrompt: (p: any) => void
  showBashesDialog: string | boolean
  vimMode: any
  isSearchingHistory: boolean
  isHelpOpen: boolean
  inputMode: PromptInputMode
  screen: any
  pendingWorkerRequest: any
  pendingSandboxRequest: any
}) {
  // ── Permission queues ──
  const [toolUseConfirmQueue, setToolUseConfirmQueue] = useState<
    ToolUseConfirm[]
  >([])
  const [permissionStickyFooter, setPermissionStickyFooter] =
    useState<React.ReactNode | null>(null)
  const [sandboxPermissionRequestQueue, setSandboxPermissionRequestQueue] =
    useState<
      Array<{
        hostPattern: NetworkHostPattern
        resolvePromise: (allowConnection: boolean) => void
      }>
    >([])
  const [promptQueue, setPromptQueue] = useState<
    Array<{
      request: PromptRequest
      title: string
      toolInputSummary?: string | null
      resolve: (response: PromptResponse) => void
      reject: (error: Error) => void
    }>
  >([])

  const isWaitingForApproval =
    toolUseConfirmQueue.length > 0 ||
    promptQueue.length > 0 ||
    pendingWorkerRequest ||
    pendingSandboxRequest

  const hasActivePrompt =
    toolUseConfirmQueue.length > 0 ||
    promptQueue.length > 0 ||
    sandboxPermissionRequestQueue.length > 0 ||
    elicitation.queue.length > 0 ||
    workerSandboxPermissions.queue.length > 0

  // Register the leader's setToolUseConfirmQueue
  useEffect(() => {
    registerLeaderToolUseConfirmQueue(setToolUseConfirmQueue)
    return () => unregisterLeaderToolUseConfirmQueue()
  }, [setToolUseConfirmQueue])

  // ── Dialog focus ──
  function getFocusedInputDialog():
    | 'message-selector'
    | 'sandbox-permission'
    | 'tool-permission'
    | 'prompt'
    | 'worker-sandbox-permission'
    | 'elicitation'
    | 'init-onboarding'
    | 'ide-onboarding'
    | 'model-switch'
    | 'lsp-recommendation'
    | 'plugin-hint'
    | 'desktop-upsell'
    | undefined {
    if (isExiting || exitFlow) return undefined
    if (isMessageSelectorVisible) return 'message-selector'
    if (sandboxPermissionRequestQueue[0]) return 'sandbox-permission'
    const allowDialogsWithAnimation =
      !toolJSX || toolJSX.shouldContinueAnimation
    if (allowDialogsWithAnimation && toolUseConfirmQueue[0])
      return 'tool-permission'
    if (allowDialogsWithAnimation && promptQueue[0]) return 'prompt'
    if (allowDialogsWithAnimation && workerSandboxPermissions.queue[0])
      return 'worker-sandbox-permission'
    if (allowDialogsWithAnimation && elicitation.queue[0]) return 'elicitation'
    if (isPromptInputActive) return undefined
    if (allowDialogsWithAnimation && showIdeOnboarding) return 'ide-onboarding'
    return undefined
  }

  const focusedInputDialog = getFocusedInputDialog()
  const hasSuppressedDialogs = false
  focusedInputDialogRef.current = focusedInputDialog

  // Auto-stash prompt text when dialog interrupts typing
  const prevDialogForStashRef = useRef(focusedInputDialog)
  useEffect(() => {
    const prev = prevDialogForStashRef.current
    prevDialogForStashRef.current = focusedInputDialog

    const isCritical = (
      d: typeof focusedInputDialog,
    ): d is
      | 'tool-permission'
      | 'sandbox-permission'
      | 'prompt'
      | 'worker-sandbox-permission'
      | 'elicitation' =>
      d === 'tool-permission' ||
      d === 'sandbox-permission' ||
      d === 'prompt' ||
      d === 'worker-sandbox-permission' ||
      d === 'elicitation'

    if (
      !prev &&
      isCritical(focusedInputDialog) &&
      inputValueRef.current.trim().length > 0 &&
      !stashedPrompt
    ) {
      setStashedPrompt({
        text: inputValueRef.current,
        cursorOffset: inputValueRef.current.length,
        pastedContents: {},
      })
      setInputValue('')
    }

    if (isCritical(prev) && !focusedInputDialog && stashedPrompt) {
      setInputValue(stashedPrompt.text)
      setStashedPrompt(undefined)
    }
  }, [
    focusedInputDialog,
    stashedPrompt,
    setInputValue,
    setStashedPrompt,
    inputValueRef,
  ])

  // Timing pause/resume for permission dialogs
  useEffect(() => {
    if (!isLoading) return
    const isPaused = focusedInputDialog === 'tool-permission'
    const now = Date.now()
    if (isPaused && pauseStartTimeRef.current === null) {
      pauseStartTimeRef.current = now
    } else if (!isPaused && pauseStartTimeRef.current !== null) {
      totalPausedMsRef.current += now - pauseStartTimeRef.current
      pauseStartTimeRef.current = null
    }
  }, [focusedInputDialog, isLoading, pauseStartTimeRef, totalPausedMsRef])

  // Re-pin scroll on permission overlay appear/dismiss
  const prevDialogRef = useRef(focusedInputDialog)
  useLayoutEffect(() => {
    const was = prevDialogRef.current === 'tool-permission'
    const now = focusedInputDialog === 'tool-permission'
    if (was !== now) repinScroll()
    prevDialogRef.current = focusedInputDialog
  }, [focusedInputDialog, repinScroll])

  // Re-pin scroll when local-JSX overlay closes
  const prevLocalJSXRef = useRef(isShowingLocalJSXCommand)
  useLayoutEffect(() => {
    const was = prevLocalJSXRef.current
    const now = isShowingLocalJSXCommand
    if (was && !now) repinScroll()
    prevLocalJSXRef.current = now
  }, [isShowingLocalJSXCommand, repinScroll])

  // ── Cancel handler ──
  function onCancel() {
    if (focusedInputDialog === 'elicitation') return

    logForDebugging(
      `[onCancel] focusedInputDialog=${focusedInputDialog} streamMode=${streamMode}`,
    )

    if (feature('KAIROS')) {
      proactiveModule?.pauseProactive()
    }

    queryGuard.forceEnd()

    if (streamingText?.trim()) {
      setMessages(prev => [
        ...prev,
        createAssistantMessage({ content: streamingText }),
      ])
    }

    resetLoadingState()

    if (focusedInputDialog === 'tool-permission') {
      toolUseConfirmQueue[0]?.onAbort()
      setToolUseConfirmQueue([])
    } else if (focusedInputDialog === 'prompt') {
      for (const item of promptQueue) {
        item.reject(new Error('Prompt cancelled by user'))
      }
      setPromptQueue([])
      abortController?.abort('user-cancel')
    } else {
      abortController?.abort('user-cancel')
    }

    setAbortController(null)
    void mrOnTurnComplete(messagesRef.current, true)
  }

  const handleQueuedCommandOnCancel = useCallback(() => {
    const result = popAllEditable(inputValue, 0)
    if (!result) return
    setInputValue(result.text)
    setInputMode('prompt')
    if (result.images.length > 0) {
      setPastedContents(prev => {
        const newContents = { ...prev }
        for (const image of result.images) {
          newContents[image.id] = image
        }
        return newContents
      })
    }
  }, [setInputValue, setInputMode, inputValue, setPastedContents])

  const cancelRequestProps = {
    setToolUseConfirmQueue,
    onCancel,
    onAgentsKilled: () =>
      setMessages(prev => [...prev, createAgentsKilledMessage()]),
    isMessageSelectorVisible: isMessageSelectorVisible || !!showBashesDialog,
    screen,
    abortSignal: abortController?.signal,
    popCommandFromQueue: handleQueuedCommandOnCancel,
    vimMode,
    isLocalJSXCommand: toolJSX?.isLocalJSXCommand,
    isSearchingHistory,
    isHelpOpen,
    inputMode,
    inputValue,
    streamMode,
  }

  // ── Sandbox callback ──
  const sandboxAskCallback: SandboxAskCallback = useCallback(
    async (hostPattern: NetworkHostPattern) => {
      if (isAgentSwarmsEnabled() && isSwarmWorker()) {
        const requestId = generateSandboxRequestId()
        const sent = await sendSandboxPermissionRequestViaMailbox(
          hostPattern.host,
          requestId,
        )
        return new Promise(resolveShouldAllowHost => {
          if (!sent) {
            setSandboxPermissionRequestQueue(prev => [
              ...prev,
              { hostPattern, resolvePromise: resolveShouldAllowHost },
            ])
            return
          }
          registerSandboxPermissionCallback({
            requestId,
            host: hostPattern.host,
            resolve: resolveShouldAllowHost,
          })
          setAppState(prev => ({
            ...prev,
            pendingSandboxRequest: {
              requestId,
              host: hostPattern.host,
            },
          }))
        })
      }

      return new Promise(resolveShouldAllowHost => {
        let resolved = false
        function resolveOnce(allow: boolean): void {
          if (resolved) return
          resolved = true
          resolveShouldAllowHost(allow)
        }
        setSandboxPermissionRequestQueue(prev => [
          ...prev,
          { hostPattern, resolvePromise: resolveOnce },
        ])
      })
    },
    [setAppState, store],
  )

  // Sandbox unavailable notification
  useEffect(() => {
    const reason = SandboxManager.getSandboxUnavailableReason()
    if (!reason) return
    if (SandboxManager.isSandboxRequired()) {
      process.stderr.write(
        `\nError: sandbox required but unavailable: ${reason}\n` +
          `  sandbox.failIfUnavailable is set — refusing to start without a working sandbox.\n\n`,
      )
      gracefulShutdownSync(1, 'other')
      return
    }
    logForDebugging(`sandbox disabled: ${reason}`, { level: 'warn' })
    addNotification({
      key: 'sandbox-unavailable',
      jsx: (
        <>
          <Text color="warning">sandbox disabled</Text>
          <Text dimColor> · /sandbox</Text>
        </>
      ),
      priority: 'medium',
    })
  }, [addNotification])

  // Initialize sandbox
  if (SandboxManager.isSandboxingEnabled()) {
    SandboxManager.initialize(sandboxAskCallback).catch(err => {
      process.stderr.write(`\nError: Sandbox Error: ${errorMessage(err)}\n`)
      gracefulShutdownSync(1, 'other')
    })
  }

  // ── Permission context ──
  const setToolPermissionContext = useCallback(
    (context: ToolPermissionContext, options?: { preserveMode?: boolean }) => {
      setAppState(prev => ({
        ...prev,
        toolPermissionContext: {
          ...context,
          mode: options?.preserveMode
            ? prev.toolPermissionContext.mode
            : context.mode,
        },
      }))
      setImmediate(setToolUseConfirmQueue => {
        setToolUseConfirmQueue(currentQueue => {
          currentQueue.forEach(item => {
            void item.recheckPermission()
          })
          return currentQueue
        })
      }, setToolUseConfirmQueue)
    },
    [setAppState, setToolUseConfirmQueue],
  )

  useEffect(() => {
    registerLeaderSetToolPermissionContext(setToolPermissionContext)
    return () => unregisterLeaderSetToolPermissionContext()
  }, [setToolPermissionContext])

  const canUseTool = useCanUseTool(
    setToolUseConfirmQueue,
    setToolPermissionContext,
  )

  const requestPrompt = useCallback(
    (title: string, toolInputSummary?: string | null) =>
      (request: PromptRequest): Promise<PromptResponse> =>
        new Promise<PromptResponse>((resolve, reject) => {
          setPromptQueue(prev => [
            ...prev,
            { request, title, toolInputSummary, resolve, reject },
          ])
        }),
    [],
  )

  return {
    toolUseConfirmQueue,
    setToolUseConfirmQueue,
    permissionStickyFooter,
    setPermissionStickyFooter,
    sandboxPermissionRequestQueue,
    setSandboxPermissionRequestQueue,
    promptQueue,
    setPromptQueue,
    isWaitingForApproval,
    hasActivePrompt,
    focusedInputDialog,
    hasSuppressedDialogs,
    onCancel,
    handleQueuedCommandOnCancel,
    cancelRequestProps,
    setToolPermissionContext,
    canUseTool,
    requestPrompt,
  }
}
