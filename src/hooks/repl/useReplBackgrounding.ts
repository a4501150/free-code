import { feature } from 'bun:bundle'
import { useCallback } from 'react'
import { getSystemPrompt } from '../../constants/prompts.js'
import { buildEffectiveSystemPrompt } from '../../utils/systemPrompt.js'
import { getSystemContext, getUserContext } from '../../context.js'
import { getQuerySourceForREPL } from '../../utils/promptCategory.js'
import { startBackgroundSession } from '../../tasks/LocalMainSessionTask.js'
import { useSessionBackgrounding } from '../useSessionBackgrounding.js'
import {
  createAttachmentMessage,
  getQueuedCommandAttachments,
} from '../../utils/attachments.js'
import { removeByFilter } from '../../utils/messageQueueManager.js'
import type { Message as MessageType } from '../../types/message.js'
import type { ProcessUserInputContext } from '../../utils/processUserInput/processUserInput.js'
import type { AgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js'

export function useReplBackgrounding({
  abortController,
  mainLoopModel,
  toolPermissionContext,
  mainThreadAgentDefinition,
  getToolUseContext,
  customSystemPrompt,
  appendSystemPrompt,
  canUseTool,
  setAppState,
  messagesRef,
  terminalTitle,
  setMessages,
  setIsExternalLoading,
  resetLoadingState,
  setAbortController,
}: {
  abortController: AbortController | null
  mainLoopModel: string
  toolPermissionContext: any
  mainThreadAgentDefinition?: AgentDefinition
  getToolUseContext: (
    messages: MessageType[],
    newMessages: MessageType[],
    abortController: AbortController,
    mainLoopModel: string,
  ) => ProcessUserInputContext
  customSystemPrompt?: string
  appendSystemPrompt?: string
  canUseTool: any
  setAppState: (fn: (prev: any) => any) => void
  messagesRef: React.RefObject<MessageType[]>
  terminalTitle: string
  setMessages: (action: React.SetStateAction<MessageType[]>) => void
  setIsExternalLoading: (value: boolean) => void
  resetLoadingState: () => void
  setAbortController: (controller: AbortController | null) => void
}) {
  const handleBackgroundQuery = useCallback(() => {
    abortController?.abort('background')
    const removedNotifications = removeByFilter(
      cmd => cmd.mode === 'task-notification',
    )

    void (async () => {
      const toolUseContext = getToolUseContext(
        messagesRef.current,
        [],
        new AbortController(),
        mainLoopModel,
      )

      const [defaultSystemPrompt, userContext, systemContext] =
        await Promise.all([
          getSystemPrompt(
            toolUseContext.options.tools,
            mainLoopModel,
            Array.from(
              toolPermissionContext.additionalWorkingDirectories.keys(),
            ),
            toolUseContext.options.mcpClients,
          ),
          getUserContext(),
          getSystemContext(),
        ])

      const systemPrompt = buildEffectiveSystemPrompt({
        mainThreadAgentDefinition,
        toolUseContext,
        customSystemPrompt,
        defaultSystemPrompt,
        appendSystemPrompt,
      })
      toolUseContext.renderedSystemPrompt = systemPrompt

      const notificationAttachments = await getQueuedCommandAttachments(
        removedNotifications,
      ).catch(() => [])
      const notificationMessages = notificationAttachments.map(
        createAttachmentMessage,
      )

      const existingPrompts = new Set<string>()
      for (const m of messagesRef.current) {
        if (
          m.type === 'attachment' &&
          m.attachment.type === 'queued_command' &&
          m.attachment.commandMode === 'task-notification' &&
          typeof m.attachment.prompt === 'string'
        ) {
          existingPrompts.add(m.attachment.prompt)
        }
      }
      const uniqueNotifications = notificationMessages.filter(
        m =>
          m.attachment.type === 'queued_command' &&
          (typeof m.attachment.prompt !== 'string' ||
            !existingPrompts.has(m.attachment.prompt)),
      )

      startBackgroundSession({
        messages: [...messagesRef.current, ...uniqueNotifications],
        queryParams: {
          systemPrompt,
          userContext,
          systemContext,
          canUseTool,
          toolUseContext,
          querySource: getQuerySourceForREPL(),
        },
        description: terminalTitle,
        setAppState,
        agentDefinition: mainThreadAgentDefinition,
      })
    })()
  }, [
    abortController,
    mainLoopModel,
    toolPermissionContext,
    mainThreadAgentDefinition,
    getToolUseContext,
    customSystemPrompt,
    appendSystemPrompt,
    canUseTool,
    setAppState,
    messagesRef,
    terminalTitle,
  ])

  const { handleBackgroundSession } = useSessionBackgrounding({
    setMessages,
    setIsLoading: setIsExternalLoading,
    resetLoadingState,
    setAbortController,
    onBackgroundQuery: handleBackgroundQuery,
  })

  return { handleBackgroundSession, handleBackgroundQuery }
}
