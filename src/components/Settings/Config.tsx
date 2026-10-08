/**
 * REPL host adapter for the settings dialog's Config tab: reads the store
 * slices Config renders from, holds the mount-time AppState snapshot the
 * Escape-revert restores, and wires the write callbacks with the same
 * updaters this file used before the panels/SettingsDialog/Config split. The
 * MCP sub-dialog wiring mirrors components/mcp/MCPSettings.tsx. Keeps the
 * original Config export so Settings.tsx keeps mounting it unchanged.
 */

import * as React from 'react'
import { useCallback, useState } from 'react'
import type {
  CommandResultDisplay,
  LocalJSXCommandContext,
} from '../../commands.js'
import {
  useMcpReconnect,
  useMcpToggleEnabled,
} from '../../services/mcp/MCPConnectionManager.js'
import { applyServerDisconnected } from '../../services/mcp/utils.js'
import {
  useAppState,
  useAppStateStore,
  useSetAppState,
} from '../../state/AppState.js'
import { getFastModeModel, isFastModeEnabled } from '../../utils/fastMode.js'
import { transitionPlanAutoMode } from '../../utils/permissions/permissionSetup.js'
import {
  Config as ConfigPanel,
  type AppStateSettingsPatch,
} from '../panels/SettingsDialog/Config.js'

type Props = {
  onClose: (
    result?: string,
    options?: { display?: CommandResultDisplay },
  ) => void
  context: LocalJSXCommandContext
  setTabsHidden: (hidden: boolean) => void
  onIsSearchModeChange?: (inSearchMode: boolean) => void
  contentHeight?: number
}

export function Config({
  onClose,
  context,
  setTabsHidden,
  onIsSearchModeChange,
  contentHeight,
}: Props): React.ReactNode {
  const mainLoopModel = useAppState(s => s.mainLoopModel)
  const verbose = useAppState(s => s.verbose)
  const thinkingEnabled = useAppState(s => s.thinkingEnabled)
  const isFastMode = useAppState(s =>
    isFastModeEnabled() ? s.fastMode : false,
  )
  const promptSuggestionEnabled = useAppState(s => s.promptSuggestionEnabled)
  const mcp = useAppState(s => s.mcp)
  const agentDefinitions = useAppState(s => s.agentDefinitions)
  const syntaxHighlightingDisabled =
    useAppState(s => s.settings.syntaxHighlightingDisabled) ?? false
  const setAppState = useSetAppState()
  const reconnectMcpServer = useMcpReconnect()
  const toggleMcpServer = useMcpToggleEnabled()

  // AppState fields Config may modify — snapshot once at mount. The original
  // component read it imperatively via store.getState() in its first render;
  // the adapter mounts in the same commit, so the snapshot values are
  // identical to what revertChanges used to restore from.
  const store = useAppStateStore()
  const [initialAppState] = useState(() => {
    const s = store.getState()
    return {
      mainLoopModel: s.mainLoopModel,
      mainLoopModelForSession: s.mainLoopModelForSession,
      verbose: s.verbose,
      thinkingEnabled: s.thinkingEnabled,
      fastMode: s.fastMode,
      promptSuggestionEnabled: s.promptSuggestionEnabled,
      isBriefOnly: s.isBriefOnly,
      settings: s.settings,
    }
  })

  // A server whose auth was cleared: mark it needs-auth/failed and drop its
  // tools, commands and resources from the store (wiring identical to
  // A server whose auth was cleared: mark it needs-auth/failed and drop its
  // tools, commands and resources from the store.
  const onServerDisconnected = useCallback(
    (serverName: string, clientType: 'needs-auth' | 'failed'): void => {
      setAppState(prev => ({
        ...prev,
        mcp: applyServerDisconnected(prev.mcp, serverName, clientType),
      }))
    },
    [setAppState],
  )

  const onMainModelChange = useCallback(
    (value: string | null): void => {
      setAppState(prev => ({
        ...prev,
        mainLoopModel: value,
        mainLoopModelForSession: null,
      }))
    },
    [setAppState],
  )

  const onVerboseChange = useCallback(
    (value: boolean): void => {
      setAppState(prev => ({
        ...prev,
        verbose: value,
      }))
    },
    [setAppState],
  )

  const onAppStateSettingsPatch = useCallback(
    (patch: AppStateSettingsPatch): void => {
      setAppState(prev => ({
        ...prev,
        settings: { ...prev.settings, ...patch },
      }))
    },
    [setAppState],
  )

  const onThinkingEnabledChange = useCallback(
    (enabled: boolean): void => {
      setAppState(prev => ({ ...prev, thinkingEnabled: enabled }))
    },
    [setAppState],
  )

  const onFastModeChange = useCallback(
    (enabled: boolean): void => {
      if (enabled) {
        setAppState(prev => ({
          ...prev,
          mainLoopModel: getFastModeModel(),
          mainLoopModelForSession: null,
          fastMode: true,
        }))
      } else {
        setAppState(prev => ({
          ...prev,
          fastMode: false,
        }))
      }
    },
    [setAppState],
  )

  const onPromptSuggestionChange = useCallback(
    (enabled: boolean): void => {
      setAppState(prev => ({
        ...prev,
        promptSuggestionEnabled: enabled,
      }))
    },
    [setAppState],
  )

  const onBriefOnlyChange = useCallback(
    (isBriefOnly: boolean): void => {
      setAppState(prev => {
        if (prev.isBriefOnly === isBriefOnly) return prev
        return { ...prev, isBriefOnly }
      })
    },
    [setAppState],
  )

  // Internal writes suppress the file watcher, so applySettingsChange won't
  // fire. The panel calls this after toggling useAutoModeDuringPlan so
  // mid-plan toggles take effect immediately.
  const onReconcilePlanAutoMode = useCallback((): void => {
    setAppState(prev => {
      const next = transitionPlanAutoMode(prev.toolPermissionContext)
      if (next === prev.toolPermissionContext) return prev
      return { ...prev, toolPermissionContext: next }
    })
  }, [setAppState])

  // Escape-revert: batch-restore all possibly-touched fields to the mount-time
  // snapshot, including the auto-mode reconcile the original updater ran.
  const onRevertAppState = useCallback((): void => {
    const ia = initialAppState
    setAppState(prev => ({
      ...prev,
      mainLoopModel: ia.mainLoopModel,
      mainLoopModelForSession: ia.mainLoopModelForSession,
      verbose: ia.verbose,
      thinkingEnabled: ia.thinkingEnabled,
      fastMode: ia.fastMode,
      promptSuggestionEnabled: ia.promptSuggestionEnabled,
      isBriefOnly: ia.isBriefOnly,
      settings: ia.settings,
      // Reconcile auto-mode state after useAutoModeDuringPlan revert —
      // the onChange handler may have activated/deactivated auto mid-plan.
      toolPermissionContext: transitionPlanAutoMode(prev.toolPermissionContext),
    }))
  }, [setAppState, initialAppState])

  return (
    <ConfigPanel
      onClose={onClose}
      context={context}
      setTabsHidden={setTabsHidden}
      onIsSearchModeChange={onIsSearchModeChange}
      contentHeight={contentHeight}
      mainLoopModel={mainLoopModel}
      verbose={verbose}
      thinkingEnabled={thinkingEnabled}
      isFastMode={isFastMode}
      promptSuggestionEnabled={promptSuggestionEnabled}
      mcpClients={mcp.clients}
      syntaxHighlightingDisabled={syntaxHighlightingDisabled}
      mcpTools={mcp.tools}
      mcpCommands={mcp.commands}
      mcpResources={mcp.resources}
      agentDefinitions={agentDefinitions.allAgents}
      onReconnect={reconnectMcpServer}
      onToggleEnabled={toggleMcpServer}
      onServerDisconnected={onServerDisconnected}
      onMainModelChange={onMainModelChange}
      onVerboseChange={onVerboseChange}
      onAppStateSettingsPatch={onAppStateSettingsPatch}
      onThinkingEnabledChange={onThinkingEnabledChange}
      onFastModeChange={onFastModeChange}
      onPromptSuggestionChange={onPromptSuggestionChange}
      onBriefOnlyChange={onBriefOnlyChange}
      onReconcilePlanAutoMode={onReconcilePlanAutoMode}
      onRevertAppState={onRevertAppState}
    />
  )
}
