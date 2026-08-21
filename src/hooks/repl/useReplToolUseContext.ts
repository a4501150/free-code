import { feature } from 'bun:bundle'
import { useCallback } from 'react'
import { mergeClients } from '../useMergedClients.js'
import { assembleToolPool } from '../../tools.js'
import { mergeAndFilterTools } from '../../utils/toolPool.js'
import { resolveAgentTools } from '../../tools/AgentTool/agentToolUtils.js'
import { sendNotification } from '../../services/notifier.js'
import { compactProgressLabel } from '../../services/compact/compactProgressLabel.js'
import type { ProcessUserInputContext } from '../../utils/processUserInput/processUserInput.js'
import type { Message as MessageType } from '../../types/message.js'
import type { FileHistoryState } from '../../utils/fileHistory.js'
import type { AgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js'
import type { MCPServerConnection } from '../../services/mcp/types.js'
import type { ScopedMcpServerConfig } from '../../services/mcp/types.js'
import type { ThinkingConfig } from '../../utils/thinking.js'
import type { Command } from '../../commands.js'
import type { Tool, ToolPermissionContext } from '../../Tool.js'
import type { PromptRequest, PromptResponse } from '../../types/hooks.js'

export function useReplToolUseContext({
  commands,
  combinedInitialTools,
  mainThreadAgentDefinition,
  debug,
  initialMcpClients,
  ideInstallationStatus,
  dynamicMcpConfig,
  theme,
  allowedAgentTypes,
  store,
  setAppState,
  reverify,
  addNotification,
  setMessages,
  onChangeDynamicMcpConfig,
  resume,
  requestPrompt,
  disabled,
  customSystemPrompt,
  appendSystemPrompt,
  setConversationId,
  terminal,
  readFileState,
  setToolJSX,
  loadedNestedMemoryPathsRef,
  setResponseLength,
  setStreamMode,
  setSpinnerMessage,
  setSpinnerColor,
  setSpinnerShimmerColor,
  setCompactingStartTime,
  setInProgressToolUseIDs,
  hasInterruptibleToolInProgressRef,
  scrollRef,
  contentReplacementStateRef,
  setIDEToInstallExtension,
  setIsMessageSelectorVisible,
  thinkingConfig,
}: {
  commands: Command[]
  combinedInitialTools: Tool[]
  mainThreadAgentDefinition?: AgentDefinition
  debug: boolean
  initialMcpClients?: MCPServerConnection[]
  ideInstallationStatus: any
  dynamicMcpConfig?: Record<string, ScopedMcpServerConfig>
  theme: any
  allowedAgentTypes: string[] | undefined
  store: { getState: () => any; setState: (fn: (prev: any) => any) => void }
  setAppState: (fn: (prev: any) => any) => void
  reverify: () => void
  addNotification: (n: any) => void
  setMessages: (action: React.SetStateAction<MessageType[]>) => void
  onChangeDynamicMcpConfig: (
    config: Record<string, ScopedMcpServerConfig>,
  ) => void
  resume: any
  requestPrompt:
    | ((
        title: string,
        toolInputSummary?: string | null,
      ) => (request: PromptRequest) => Promise<PromptResponse>)
    | undefined
  disabled: boolean
  customSystemPrompt?: string
  appendSystemPrompt?: string
  setConversationId: (id: any) => void
  terminal: any
  readFileState: React.RefObject<any>
  setToolJSX: (args: any) => void
  loadedNestedMemoryPathsRef: React.RefObject<Set<string>>
  setResponseLength: (f: (prev: number) => number) => void
  setStreamMode: (mode: any) => void
  setSpinnerMessage: (msg: string | null) => void
  setSpinnerColor: (color: any) => void
  setSpinnerShimmerColor: (color: any) => void
  setCompactingStartTime: (time: any) => void
  setInProgressToolUseIDs: React.Dispatch<React.SetStateAction<Set<string>>>
  hasInterruptibleToolInProgressRef: { current: boolean }
  scrollRef: React.RefObject<any>
  contentReplacementStateRef: { current: any }
  setIDEToInstallExtension: (ide: any) => void
  setIsMessageSelectorVisible: (v: boolean) => void
  thinkingConfig: ThinkingConfig
}) {
  const getToolUseContext = useCallback(
    (
      messages: MessageType[],
      newMessages: MessageType[],
      abortController: AbortController,
      mainLoopModel: string,
    ): ProcessUserInputContext => {
      const s = store.getState()

      const computeTools = () => {
        const state = store.getState()
        const assembled = assembleToolPool(
          state.toolPermissionContext,
          state.mcp.tools,
        )
        const merged = mergeAndFilterTools(
          combinedInitialTools,
          assembled,
          state.toolPermissionContext.mode,
        )
        if (!mainThreadAgentDefinition) return merged
        return resolveAgentTools(mainThreadAgentDefinition, merged, false, true)
          .resolvedTools
      }

      return {
        abortController,
        options: {
          commands,
          tools: computeTools(),
          debug,
          verbose: s.verbose,
          mainLoopModel,
          thinkingConfig:
            s.thinkingEnabled !== false ? thinkingConfig : { type: 'disabled' },
          mcpClients: mergeClients(initialMcpClients, s.mcp.clients),
          mcpResources: s.mcp.resources,
          ideInstallationStatus,
          isNonInteractiveSession: false,
          dynamicMcpConfig,
          theme,
          agentDefinitions: allowedAgentTypes
            ? { ...s.agentDefinitions, allowedAgentTypes }
            : s.agentDefinitions,
          customSystemPrompt,
          appendSystemPrompt,
          refreshTools: computeTools,
        },
        getAppState: () => store.getState(),
        setAppState,
        messages,
        setMessages,
        updateFileHistoryState(
          updater: (prev: FileHistoryState) => FileHistoryState,
        ) {
          setAppState(prev => {
            const updated = updater(prev.fileHistory)
            if (updated === prev.fileHistory) return prev
            return { ...prev, fileHistory: updated }
          })
        },
        openMessageSelector: () => {
          if (!disabled) {
            setIsMessageSelectorVisible(true)
          }
        },
        onChangeAPIKey: reverify,
        readFileState: readFileState.current,
        setToolJSX,
        addNotification,
        appendSystemMessage: msg => setMessages(prev => [...prev, msg]),
        sendOSNotification: opts => {
          void sendNotification(opts, terminal)
        },
        onChangeDynamicMcpConfig,
        onInstallIDEExtension: setIDEToInstallExtension,
        nestedMemoryAttachmentTriggers: new Set<string>(),
        loadedNestedMemoryPaths: loadedNestedMemoryPathsRef.current,
        dynamicSkillDirTriggers: new Set<string>(),
        setResponseLength,
        setStreamMode,
        onCompactProgress: event => {
          setSpinnerMessage(compactProgressLabel(event))
          if (event.type === 'compact_end') {
            setSpinnerColor(null)
            setSpinnerShimmerColor(null)
            setCompactingStartTime(null)
          } else {
            if (event.type === 'hooks_start') {
              setSpinnerColor('claudeBlue_FOR_SYSTEM_SPINNER')
              setSpinnerShimmerColor('claudeBlueShimmer_FOR_SYSTEM_SPINNER')
            }
            setCompactingStartTime((prev: number | null) => prev ?? Date.now())
          }
        },
        setInProgressToolUseIDs,
        setHasInterruptibleToolInProgress: (v: boolean) => {
          hasInterruptibleToolInProgressRef.current = v
        },
        resume,
        setConversationId,
        scrollToBottom: () => scrollRef.current?.scrollToBottom(),
        requestPrompt: feature('HOOK_PROMPTS') ? requestPrompt : undefined,
        contentReplacementState: contentReplacementStateRef.current,
      }
    },
    [
      commands,
      combinedInitialTools,
      mainThreadAgentDefinition,
      debug,
      initialMcpClients,
      ideInstallationStatus,
      dynamicMcpConfig,
      theme,
      allowedAgentTypes,
      store,
      setAppState,
      reverify,
      addNotification,
      setMessages,
      onChangeDynamicMcpConfig,
      resume,
      requestPrompt,
      disabled,
      customSystemPrompt,
      appendSystemPrompt,
      setConversationId,
    ],
  )

  return { getToolUseContext }
}
