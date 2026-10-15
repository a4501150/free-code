import { useCallback } from 'react'
import {
  buildToolUseContext,
  type ToolUseContextParams,
} from '../../sessiond/toolUseContext.js'

/**
 * The TUI's `getToolUseContext`: a `useCallback` wrapper over the
 * framework-free builder in `sessiond/toolUseContext.ts`, so the TUI and a
 * hosted session assemble the same per-turn context. The prop contract is
 * unchanged from the pre-extraction hook.
 */
export function useReplToolUseContext(params: ToolUseContextParams): {
  getToolUseContext: ReturnType<typeof buildToolUseContext>
} {
  const {
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
    setIDEToInstallExtension,
  } = params

  return {
    getToolUseContext: useCallback(buildToolUseContext(params), [
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
      setIDEToInstallExtension,
    ]),
  }
}
