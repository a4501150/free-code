// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import { feature } from 'bun:bundle'
import type { Screen } from '../types/repl.js'
import { count } from '../utils/array.js'
import { Box, Text, useStdin, useTheme } from '../ink.js'
import * as React from 'react'
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useCallback,
  useDeferredValue,
  useLayoutEffect,
  type RefObject,
} from 'react'
import { useNotifications } from '../context/notifications.js'
import { sendNotification } from '../services/notifier.js'
import { useTerminalNotification } from '../ink/useTerminalNotification.js'
import { hasCursorUpViewportYankBug } from '../ink/terminal.js'
import {
  createFileStateCacheWithSizeLimit,
  mergeFileStateCaches,
  READ_FILE_STATE_CACHE_SIZE,
} from '../utils/fileStateCache.js'
import {
  updateLastInteractionTime,
  getLastInteractionTime,
  getOriginalCwd,
  getProjectRoot,
  getSessionId,
  switchSession,
  setCostStateForRestore,
  resetTurnHookDuration,
  resetTurnToolDuration,
  resetTurnClassifierDuration,
} from '../bootstrap/state.js'
import { asSessionId, asAgentId } from '../types/ids.js'
import { logForDebugging } from '../utils/debug.js'
import { QueryGuard } from '../utils/QueryGuard.js'
import { isEnvTruthy } from '../utils/envUtils.js'
import { truncateToWidth } from '../utils/format.js'

import { setMemberActive } from '../utils/swarm/teamHelpers.js'
import { isSwarmWorker } from '../utils/swarm/permissionSync.js'
import { getTeamName, getAgentName } from '../utils/teammate.js'
import {
  injectUserMessageToTeammate,
  getAllInProcessTeammateTasks,
} from '../tasks/InProcessTeammateTask/InProcessTeammateTask.js'
import {
  isLocalAgentTask,
  queuePendingMessage,
  appendMessageToLocalAgent,
  type LocalAgentTaskState,
} from '../tasks/LocalAgentTask/LocalAgentTask.js'
import {
  registerLeaderToolUseConfirmQueue,
  unregisterLeaderToolUseConfirmQueue,
  registerLeaderSetToolPermissionContext,
  unregisterLeaderSetToolPermissionContext,
} from '../utils/swarm/leaderPermissionBridge.js'
import { endInteractionSpan } from '../utils/telemetry/sessionTracing.js'
import { useLogMessages } from '../hooks/useLogMessages.js'
import {
  type Command,
  type CommandResultDisplay,
  type ResumeEntrypoint,
  getCommandName,
  isCommandEnabled,
} from '../commands.js'
import type {
  PromptInputMode,
  QueuedCommand,
  VimMode,
} from '../types/textInputTypes.js'
import {
  MessageSelector,
  selectableUserMessagesFilter,
  messagesAfterAreOnlySynthetic,
} from '../components/MessageSelector.js'
import { useIdeLogging } from '../hooks/useIdeLogging.js'
import {
  PermissionRequest,
  type ToolUseConfirm,
} from '../components/permissions/PermissionRequest.js'
import {
  ResumeSessionConflictDialog,
  type ResumeSessionConflictChoice,
} from '../components/ResumeSessionConflictDialog.js'
import { readAttachDescriptor } from '../webui/attach/attachDescriptor.js'
import type { PromptRequest, PromptResponse } from '../types/hooks.js'
import PromptInput from '../components/PromptInput/PromptInput.js'
import { PromptInputQueuedCommands } from '../components/PromptInput/PromptInputQueuedCommands.js'
import { useMoreRight } from '../moreright/useMoreRight.js'
import {
  SpinnerWithVerb,
  BriefIdleStatus,
  type SpinnerMode,
} from '../components/Spinner.js'
import { getSystemPrompt } from '../constants/prompts.js'
import { buildEffectiveSystemPrompt } from '../utils/systemPrompt.js'
import { getSystemContext, getUserContext } from '../context.js'
import { getMemoryFiles } from '../utils/claudemd.js'
import { startBackgroundHousekeeping } from '../utils/backgroundHousekeeping.js'
import {
  saveCurrentSessionCosts,
  resetCostState,
  getStoredSessionCosts,
} from '../cost-tracker.js'
import { useCostSummary } from '../costHook.js'
import { useAfterFirstRender } from '../hooks/useAfterFirstRender.js'
import { useDeferredHookMessages } from '../hooks/useDeferredHookMessages.js'
import {
  addToHistory,
  removeLastFromHistory,
  expandPastedTextRefs,
  parseReferences,
} from '../history.js'
import { prependModeCharacterToInput } from '../components/PromptInput/inputModes.js'
import { prependToShellHistoryCache } from '../utils/suggestions/shellHistoryCompletion.js'
import { useApiKeyVerification } from '../hooks/useApiKeyVerification.js'
import { getShortcutDisplay } from '../keybindings/shortcutFormat.js'
import { useBackgroundTaskNavigation } from '../hooks/useBackgroundTaskNavigation.js'
import { useSwarmInitialization } from '../hooks/useSwarmInitialization.js'
import { useTeammateViewAutoExit } from '../hooks/useTeammateViewAutoExit.js'
import { errorMessage } from '../utils/errors.js'
import { logError } from '../utils/log.js'
import * as voiceIntegrationNs from '../hooks/useVoiceIntegration.js'
// Dead code elimination: conditional imports
const useVoiceIntegration: typeof import('../hooks/useVoiceIntegration.js').useVoiceIntegration =
  feature('VOICE_MODE')
    ? voiceIntegrationNs.useVoiceIntegration
    : () => ({
        stripTrailing: () => 0,
        handleKeyEvent: () => {},
        resetAnchor: () => {},
        interimRange: null,
      })
const VoiceKeybindingHandler: typeof import('../hooks/useVoiceIntegration.js').VoiceKeybindingHandler =
  feature('VOICE_MODE') ? voiceIntegrationNs.VoiceKeybindingHandler : () => null
// Dead code elimination: conditional import for coordinator mode
/* eslint-disable custom-rules/no-process-env-top-level, @typescript-eslint/no-require-imports */
const coordinatorModeModule = feature('COORDINATOR_MODE')
  ? (require('../coordinator/coordinatorMode.js') as typeof import('../coordinator/coordinatorMode.js'))
  : null
const getCoordinatorUserContext: (
  mcpClients: ReadonlyArray<{ name: string }>,
  scratchpadDir?: string,
) => { [k: string]: string } =
  coordinatorModeModule?.getCoordinatorUserContext ?? (() => ({}))
/* eslint-enable custom-rules/no-process-env-top-level, @typescript-eslint/no-require-imports */
import useCanUseTool from '../hooks/useCanUseTool.js'
import type { ToolPermissionContext, Tool } from '../Tool.js'
import {
  applyPermissionUpdate,
  applyPermissionUpdates,
  persistPermissionUpdate,
} from '../utils/permissions/PermissionUpdate.js'
import { buildPermissionUpdates } from '../components/permissions/ExitPlanModePermissionRequest/ExitPlanModePermissionRequest.js'
import {
  stripDangerousPermissionsForAutoMode,
  transitionPermissionMode,
} from '../utils/permissions/permissionSetup.js'
import {
  getScratchpadDir,
  isScratchpadEnabled,
} from '../utils/permissions/filesystem.js'
import { WEB_FETCH_TOOL_NAME } from '../tools/WebFetchTool/prompt.js'
import { SLEEP_TOOL_NAME } from '../tools/SleepTool/prompt.js'
import { getInitialSettings } from '../utils/settings/settings.js'
import {
  textForResubmit,
  handleMessageFromStream,
  type StreamingToolUse,
  type StreamingThinking,
  isCompactBoundaryMessage,
  getMessagesAfterCompactBoundary,
  getContentText,
  createUserMessage,
  createAssistantMessage,
  createTurnDurationMessage,
  createAgentsKilledMessage,
  createSystemMessage,
  createCommandInputMessage,
  formatCommandInputTags,
} from '../utils/messages.js'
import { generateSessionTitle } from '../utils/sessionTitle.js'
import {
  BASH_INPUT_TAG,
  COMMAND_MESSAGE_TAG,
  COMMAND_NAME_TAG,
  LOCAL_COMMAND_STDOUT_TAG,
} from '../constants/xml.js'
import { escapeXml } from '../utils/xml.js'
import type { ThinkingConfig } from '../utils/thinking.js'
import { gracefulShutdownSync } from '../utils/gracefulShutdown.js'
import {
  handlePromptSubmit,
  type PromptInputHelpers,
} from '../utils/handlePromptSubmit.js'
import { useQueueProcessor } from '../hooks/useQueueProcessor.js'
import { useMailboxBridge } from '../hooks/useMailboxBridge.js'
import {
  queryCheckpoint,
  logQueryProfileReport,
} from '../utils/queryProfiler.js'
import type {
  Message as MessageType,
  UserMessage,
  ProgressMessage,
  HookResultMessage,
  PartialCompactDirection,
} from '../types/message.js'
import { query } from '../query.js'
import { mergeClients, useMergedClients } from '../hooks/useMergedClients.js'
import { getQuerySourceForREPL } from '../utils/promptCategory.js'
import { useMergedTools } from '../hooks/useMergedTools.js'
import { mergeAndFilterTools } from '../utils/toolPool.js'
import { useMergedCommands } from '../hooks/useMergedCommands.js'
import { useSkillsChange } from '../hooks/useSkillsChange.js'
import { useManagePlugins } from '../hooks/useManagePlugins.js'
import { Messages } from '../components/Messages.js'
import { TaskListV2 } from '../components/TaskListV2.js'
import { TeammateViewHeader } from '../components/TeammateViewHeader.js'
import { useTasksV2WithCollapseEffect } from '../hooks/useTasksV2.js'
import { maybeMarkProjectOnboardingComplete } from '../projectOnboardingState.js'
import type { MCPServerConnection } from '../services/mcp/types.js'
import type { ScopedMcpServerConfig } from '../services/mcp/types.js'
import { randomUUID, type UUID } from 'crypto'
import { processSessionStartHooks } from '../utils/sessionStart.js'
import {
  executeSessionEndHooks,
  getSessionEndHookTimeoutMs,
} from '../utils/hooks.js'
import { type IDESelection, useIdeSelection } from '../hooks/useIdeSelection.js'
import { getTools, assembleToolPool } from '../tools.js'
import type { AgentDefinition } from '../tools/AgentTool/loadAgentsDir.js'
import * as loadAgentsDirNs from '../tools/AgentTool/loadAgentsDir.js'
import { clearConversation } from '../commands/clear/conversation.js'
import { renameRecordingForSession } from '../utils/asciicast.js'
import { resolveAgentTools } from '../tools/AgentTool/agentToolUtils.js'
import { resumeAgentBackground } from '../tools/AgentTool/resumeAgent.js'
import { useMainLoopModel } from '../hooks/useMainLoopModel.js'
import {
  useAppState,
  useSetAppState,
  useAppStateStore,
} from '../state/AppState.js'
import type { DomainUserImageBlock } from '../types/domain.js'
import type { ProcessUserInputContext } from '../utils/processUserInput/processUserInput.js'
import type { PastedContent } from '../utils/config.js'
import {
  copyPlanForFork,
  copyPlanForResume,
  getPlanSlug,
  setPlanSlug,
} from '../utils/plans.js'
import {
  clearSessionMetadata,
  resetSessionFilePointer,
  adoptResumedSessionFile,
  removeTranscriptMessage,
  recordContentReplacement,
  restoreSessionMetadata,
  isEphemeralToolProgress,
  isLoggableMessage,
  saveWorktreeState,
  getAgentTranscript,
  saveMode,
  saveAiGeneratedTitle,
} from '../utils/sessionStorage.js'
import { deserializeMessages } from '../utils/conversationRecovery.js'
import {
  extractReadFilesFromMessages,
  extractBashToolsFromMessages,
} from '../utils/queryHelpers.js'
import { runPostCompactCleanup } from '../services/compact/postCompactCleanup.js'
import { compactProgressLabel } from '../services/compact/compactProgressLabel.js'
import {
  provisionContentReplacementState,
  reconstructContentReplacementState,
  type ContentReplacementRecord,
} from '../utils/toolResultStorage.js'
import { partialCompactConversation } from '../services/compact/compact.js'
import type { LogOption } from '../types/logs.js'
import type { AgentColorName } from '../tools/AgentTool/agentColorManager.js'
import {
  fileHistoryMakeSnapshot,
  type FileHistoryState,
  fileHistoryRewind,
  type FileHistorySnapshot,
  copyFileHistoryForResume,
  fileHistoryEnabled,
  fileHistoryHasAnyChanges,
} from '../utils/fileHistory.js'
import {
  checkResumeSessionOwnership,
  computeStandaloneAgentContext,
  restoreAgentFromSession,
  restoreSessionStateFromLog,
  restoreWorktreeForResume,
  exitRestoredWorktree,
} from '../utils/sessionRestore.js'
import { updateSessionName } from '../utils/concurrentSessions.js'
import {
  isInProcessTeammateTask,
  type InProcessTeammateTaskState,
} from '../tasks/InProcessTeammateTask/types.js'
import { useInboxPoller } from '../hooks/useInboxPoller.js'
import * as useProactiveNs from '../proactive/useProactive.js'
import * as useScheduledTasksNs from '../hooks/useScheduledTasks.js'
// Dead code elimination: conditional import for loop mode
/* eslint-disable @typescript-eslint/no-require-imports */
const proactiveModule = feature('KAIROS')
  ? require('../proactive/index.js')
  : null
/* eslint-enable @typescript-eslint/no-require-imports */
// Dead code elimination: conditional import for the WebUI attach host
/* eslint-disable @typescript-eslint/no-require-imports */
const webuiAttachModule = feature('WEBUI')
  ? (require('../webui/attach/hostSingleton.js') as typeof import('../webui/attach/hostSingleton.js'))
  : null
const useReplAttachBridge = feature('WEBUI')
  ? (
      require('../webui/attach/replBridge.js') as typeof import('../webui/attach/replBridge.js')
    ).useReplAttachBridge
  : () => {}
/* eslint-enable @typescript-eslint/no-require-imports */
const PROACTIVE_NO_OP_SUBSCRIBE = (_cb: () => void) => () => {}
const PROACTIVE_FALSE = () => false
const SUGGEST_BG_PR_NOOP = (_p: string, _n: string): boolean => false
const useProactive = feature('KAIROS') ? useProactiveNs.useProactive : null
const useScheduledTasks = feature('AGENT_TRIGGERS')
  ? useScheduledTasksNs.useScheduledTasks
  : null
import { isAgentSwarmsEnabled } from '../utils/agentSwarmsEnabled.js'
import { useTaskListWatcher } from '../hooks/useTaskListWatcher.js'

import {
  type IDEExtensionInstallationStatus,
  closeOpenDiffs,
  getConnectedIdeClient,
  type IdeType,
} from '../utils/ide.js'
import { useIDEIntegration } from '../hooks/useIDEIntegration.js'
import exit from '../commands/exit/index.js'
import { ExitFlow } from '../components/ExitFlow.js'
import { getCurrentWorktreeSession } from '../utils/worktree.js'
import {
  popAllEditable,
  enqueue,
  type SetAppState,
  getCommandQueue,
  getCommandQueueLength,
  removeByFilter,
} from '../utils/messageQueueManager.js'
import { useCommandQueue } from '../hooks/useCommandQueue.js'
import { SessionBackgroundHint } from '../components/SessionBackgroundHint.js'
import { startBackgroundSession } from '../tasks/LocalMainSessionTask.js'
import { useSessionBackgrounding } from '../hooks/useSessionBackgrounding.js'
import { diagnosticTracker } from '../services/diagnosticTracking.js'
import {
  handleSpeculationAccept,
  type ActiveSpeculationState,
} from '../services/PromptSuggestion/speculation.js'
import type { EffortValue } from '../utils/effort.js'
import { activityManager } from '../utils/activityManager.js'
import { createAbortController } from '../utils/abortController.js'
import { MCPConnectionManager } from 'src/services/mcp/MCPConnectionManager.js'
import { useAwaySummary } from 'src/hooks/useAwaySummary.js'
import type { Theme } from 'src/utils/theme.js'
import { getTipToShowOnSpinner } from 'src/services/tips/tipScheduler.js'
import {
  checkAndDisableBypassPermissionsIfNeeded,
  checkAndDisableAutoModeIfNeeded,
  useKickOffCheckAndDisableBypassPermissionsIfNeeded,
  useKickOffCheckAndDisableAutoModeIfNeeded,
} from 'src/utils/permissions/bypassPermissionsKillswitch.js'
import { useFileHistorySnapshotInit } from 'src/hooks/useFileHistorySnapshotInit.js'
import { useSettingsErrors } from 'src/hooks/notifs/useSettingsErrors.js'
import { useMcpConnectivityStatus } from 'src/hooks/notifs/useMcpConnectivityStatus.js'
import { useAutoModeUnavailableNotification } from 'src/hooks/notifs/useAutoModeUnavailableNotification.js'
import { useLspInitializationNotification } from 'src/hooks/notifs/useLspInitializationNotification.js'
import { usePluginInstallationStatus } from 'src/hooks/notifs/usePluginInstallationStatus.js'
import { usePluginAutoupdateNotification } from 'src/hooks/notifs/usePluginAutoupdateNotification.js'
import { performStartupChecks } from 'src/utils/plugins/performStartupChecks.js'
import { UserTextMessage } from 'src/components/messages/UserTextMessage.js'
import { AwsAuthStatusBox } from '../components/AwsAuthStatusBox.js'
import { useRateLimitWarningNotification } from 'src/hooks/notifs/useRateLimitWarningNotification.js'
import { useDeprecationWarningNotification } from 'src/hooks/notifs/useDeprecationWarningNotification.js'
import { useNpmDeprecationNotification } from 'src/hooks/notifs/useNpmDeprecationNotification.js'
import { useIDEStatusIndicator } from 'src/hooks/notifs/useIDEStatusIndicator.js'
import { useTeammateLifecycleNotification } from 'src/hooks/notifs/useTeammateShutdownNotification.js'
import { useFastModeNotification } from 'src/hooks/notifs/useFastModeNotification.js'
import type { HookProgress } from '../types/hooks.js'
/* eslint-disable @typescript-eslint/no-require-imports */
import { FullscreenLayout } from '../components/FullscreenLayout.js'
import { BackgroundTasksDialog } from '../components/tasks/BackgroundTasksDialog.js'
import {
  isMouseTrackingEnabled,
  maybeGetTmuxControlModeWarning,
  maybeGetTmuxMouseHint,
} from '../utils/fullscreen.js'
import { AlternateScreen } from '../ink/components/AlternateScreen.js'
import {
  useMessageActions,
  MessageActionsKeybindings,
  MessageActionsBar,
  type MessageActionsState,
  type MessageActionsNav,
  type MessageActionCaps,
} from '../components/messageActions.js'
import {
  TranscriptModeFooter,
  TranscriptSearchBar,
} from '../components/repl/TranscriptChrome.js'
import { ReplDialogLayer } from '../components/repl/ReplDialogLayer.js'
import { ReplKeybindingShell } from '../components/repl/ReplKeybindingShell.js'
import { useReplToolJSX } from '../hooks/repl/useReplToolJSX.js'
import { useReplMessages } from '../hooks/repl/useReplMessages.js'
import { useReplExit } from '../hooks/repl/useReplExit.js'
import { useReplTerminalStatus } from '../hooks/repl/useReplTerminalStatus.js'
import { useReplSessionResume } from '../hooks/repl/useReplSessionResume.js'
import { useReplQueryExecution } from '../hooks/repl/useReplQueryExecution.js'
import { useReplStreaming } from '../hooks/repl/useReplStreaming.js'
import { useReplQueryLifecycle } from '../hooks/repl/useReplQueryLifecycle.js'
import { useReplToolUseContext } from '../hooks/repl/useReplToolUseContext.js'
import { useReplBackgrounding } from '../hooks/repl/useReplBackgrounding.js'
import { useReplDialogs } from '../hooks/repl/useReplDialogs.js'
import { useReplSubmission } from '../hooks/repl/useReplSubmission.js'
import { useReplTranscript } from '../hooks/repl/useReplTranscript.js'
import { useReplInput } from '../hooks/repl/useReplInput.js'
import { setClipboard } from '../ink/termio/osc.js'
import {
  createAttachmentMessage,
  getQueuedCommandAttachments,
} from '../utils/attachments.js'

// Stable identities for the agent-drill-down branches below. An inline [] or
// new Set() would change every render, invalidating the memos in Messages that
// key off them (syntheticStreamingToolUseMessages, streamingToolUseIDs).
const EMPTY_STREAMING_TOOL_USES: StreamingToolUse[] = []
const EMPTY_IN_PROGRESS_TOOL_USE_IDS = new Set<string>()

export type Props = {
  commands: Command[]
  debug: boolean
  initialTools: Tool[]
  // Initial messages to populate the REPL with
  initialMessages?: MessageType[]
  // Deferred hook messages promise — REPL renders immediately and injects
  // hook messages when they resolve. Awaited before the first API call.
  pendingHookMessages?: Promise<HookResultMessage[]>
  initialFileHistorySnapshots?: FileHistorySnapshot[]
  // Content-replacement records from a resumed session's transcript — used to
  // reconstruct contentReplacementState so the same results are re-replaced
  initialContentReplacements?: ContentReplacementRecord[]
  // Initial agent context for session resume (name/color set via /rename or /color)
  initialAgentName?: string
  initialAgentColor?: AgentColorName
  mcpClients?: MCPServerConnection[]
  dynamicMcpConfig?: Record<string, ScopedMcpServerConfig>
  autoConnectIdeFlag?: boolean
  strictMcpConfig?: boolean
  systemPrompt?: string
  appendSystemPrompt?: string
  // Optional callback invoked before query execution
  // Called after user message is added to conversation but before API call
  // Return false to prevent query execution
  onBeforeQuery?: (
    input: string,
    newMessages: MessageType[],
  ) => Promise<boolean>
  // Optional callback when a turn completes (model finishes responding)
  onTurnComplete?: (messages: MessageType[]) => void | Promise<void>
  // When true, disables REPL input (hides prompt and prevents message selector)
  disabled?: boolean
  // Optional agent definition to use for the main thread
  mainThreadAgentDefinition?: AgentDefinition
  // When true, disables all slash commands
  disableSlashCommands?: boolean
  // Task list id: when set, enables tasks mode that watches a task list and auto-processes tasks.
  taskListId?: string
  // Thinking configuration to use when thinking is enabled
  thinkingConfig: ThinkingConfig
}

export type { Screen } from '../types/repl.js'

export function REPL({
  commands: initialCommands,
  debug,
  initialTools,
  initialMessages,
  pendingHookMessages,
  initialFileHistorySnapshots,
  initialContentReplacements,
  initialAgentName,
  initialAgentColor,
  mcpClients: initialMcpClients,
  dynamicMcpConfig: initialDynamicMcpConfig,
  autoConnectIdeFlag,
  strictMcpConfig = false,
  systemPrompt: customSystemPrompt,
  appendSystemPrompt,
  onBeforeQuery,
  onTurnComplete,
  disabled = false,
  mainThreadAgentDefinition: initialMainThreadAgentDefinition,
  disableSlashCommands = false,
  taskListId,
  thinkingConfig,
}: Props): React.ReactNode {
  // Env-var gates hoisted to mount-time — isEnvTruthy does toLowerCase+trim+
  // includes, and these were on the render path (hot during PageUp spam).
  const titleDisabled = useMemo(
    () => isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_TERMINAL_TITLE),
    [],
  )
  const disableMessageActions = feature('MESSAGE_ACTIONS')
    ? // biome-ignore lint/correctness/useHookAtTopLevel: feature() is a compile-time constant
      useMemo(
        () => isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_MESSAGE_ACTIONS),
        [],
      )
    : false

  // Log REPL mount/unmount lifecycle
  useEffect(() => {
    logForDebugging(`[REPL:mount] REPL mounted, disabled=${disabled}`)
    return () => logForDebugging(`[REPL:unmount] REPL unmounting`)
  }, [disabled])

  // Agent definition is state so /resume can update it mid-session
  const [mainThreadAgentDefinition, setMainThreadAgentDefinition] = useState(
    initialMainThreadAgentDefinition,
  )

  const toolPermissionContext = useAppState(s => s.toolPermissionContext)
  const verbose = useAppState(s => s.verbose)
  const mcp = useAppState(s => s.mcp)
  const plugins = useAppState(s => s.plugins)
  const agentDefinitions = useAppState(s => s.agentDefinitions)
  const fileHistory = useAppState(s => s.fileHistory)
  const initialMessage = useAppState(s => s.initialMessage)
  const queuedCommands = useCommandQueue()
  const spinnerTip = useAppState(s => s.spinnerTip)
  const showExpandedTodos = useAppState(s => s.expandedView) === 'tasks'
  const pendingWorkerRequest = useAppState(s => s.pendingWorkerRequest)
  const teamContext = useAppState(s => s.teamContext)
  const tasks = useAppState(s => s.tasks)
  const elicitation = useAppState(s => s.elicitation)
  const viewingAgentTaskId = useAppState(s => s.viewingAgentTaskId)
  const setAppState = useSetAppState()

  // Bootstrap: retained local_agent that hasn't loaded disk yet → read
  // sidechain JSONL and UUID-merge with whatever stream has appended so far.
  // Stream appends immediately on retain (no defer); bootstrap fills the
  // prefix. Disk-write-before-yield means live is always a suffix of disk.
  const viewedLocalAgent = viewingAgentTaskId
    ? tasks[viewingAgentTaskId]
    : undefined
  const needsBootstrap =
    isLocalAgentTask(viewedLocalAgent) &&
    viewedLocalAgent.retain &&
    !viewedLocalAgent.diskLoaded
  useEffect(() => {
    if (!viewingAgentTaskId || !needsBootstrap) return
    const taskId = viewingAgentTaskId
    // includePreCompactHistory: the view is a display surface, so it should
    // show everything the agent did, not just the current compact interval.
    void getAgentTranscript(asAgentId(taskId), {
      includePreCompactHistory: true,
    }).then(result => {
      setAppState(prev => {
        const t = prev.tasks[taskId]
        if (!isLocalAgentTask(t) || t.diskLoaded || !t.retain) return prev
        const live = t.messages ?? []
        const liveUuids = new Set(live.map(m => m.uuid))
        const diskOnly = result
          ? result.messages.filter(m => !liveUuids.has(m.uuid))
          : []
        return {
          ...prev,
          tasks: {
            ...prev.tasks,
            [taskId]: {
              ...t,
              messages: [...diskOnly, ...live],
              diskLoaded: true,
            },
          },
        }
      })
    })
  }, [viewingAgentTaskId, needsBootstrap, setAppState])

  const store = useAppStateStore()
  const terminal = useTerminalNotification()
  const mainLoopModel = useMainLoopModel()

  // Note: standaloneAgentContext is initialized in main.tsx (via initialState) or
  // ResumeConversation.tsx (via setAppState before rendering REPL) to avoid
  // useEffect-based state initialization on mount (per CLAUDE.md guidelines)

  // Local state for commands (hot-reloadable when skill files change)
  const [localCommands, setLocalCommands] = useState(initialCommands)

  // Watch for skill file changes and reload all commands
  useSkillsChange(getProjectRoot(), setLocalCommands)

  // Track proactive mode for tools dependency - SleepTool filters by proactive state
  const proactiveActive = React.useSyncExternalStore(
    proactiveModule?.subscribeToProactiveChanges ?? PROACTIVE_NO_OP_SUBSCRIBE,
    proactiveModule?.isProactiveActive ?? PROACTIVE_FALSE,
  )

  // BriefTool.isEnabled() reads getUserMsgOptIn() from bootstrap state, which
  // /brief flips mid-session alongside isBriefOnly. The memo below needs a
  // React-visible dep to re-run getTools() when that happens; isBriefOnly is
  // the AppState mirror that triggers the re-render. Without this, toggling
  // /brief mid-session leaves the stale tool list (no SendUserMessage) and
  // the model emits plain text the brief filter hides.
  const isBriefOnly = useAppState(s => s.isBriefOnly)

  const localTools = useMemo(
    () => getTools(toolPermissionContext),
    [toolPermissionContext, proactiveActive, isBriefOnly],
  )

  useKickOffCheckAndDisableBypassPermissionsIfNeeded()
  useKickOffCheckAndDisableAutoModeIfNeeded()

  const [dynamicMcpConfig, setDynamicMcpConfig] = useState<
    Record<string, ScopedMcpServerConfig> | undefined
  >(initialDynamicMcpConfig)

  const onChangeDynamicMcpConfig = useCallback(
    (config: Record<string, ScopedMcpServerConfig>) => {
      setDynamicMcpConfig(config)
    },
    [setDynamicMcpConfig],
  )

  const { addNotification, removeNotification } = useNotifications()

  // eslint-disable-next-line prefer-const
  let trySuggestBgPRIntercept = SUGGEST_BG_PR_NOOP

  const mcpClients = useMergedClients(initialMcpClients, mcp.clients)

  // IDE integration
  const [ideSelection, setIDESelection] = useState<IDESelection | undefined>(
    undefined,
  )
  const [ideToInstallExtension, setIDEToInstallExtension] =
    useState<IdeType | null>(null)
  const [ideInstallationStatus, setIDEInstallationStatus] =
    useState<IDEExtensionInstallationStatus | null>(null)
  const [showIdeOnboarding, setShowIdeOnboarding] = useState(false)
  // notifications
  useIDEStatusIndicator({ ideSelection, mcpClients, ideInstallationStatus })
  useMcpConnectivityStatus({ mcpClients })
  useAutoModeUnavailableNotification()
  usePluginInstallationStatus()
  usePluginAutoupdateNotification()
  useSettingsErrors()
  useRateLimitWarningNotification(mainLoopModel)
  useFastModeNotification()
  useDeprecationWarningNotification(mainLoopModel)
  useNpmDeprecationNotification()
  useLspInitializationNotification()
  useTeammateLifecycleNotification()
  // Memoize the combined initial tools array to prevent reference changes
  const combinedInitialTools = useMemo(() => {
    return [...localTools, ...initialTools]
  }, [localTools, initialTools])

  // Initialize plugin management
  useManagePlugins({ enabled: true })

  const tasksV2 = useTasksV2WithCollapseEffect()

  // Start background plugin installations

  // SECURITY: This code is guaranteed to run ONLY after the "trust this folder" dialog
  // has been confirmed by the user. The trust dialog is shown in cli.tsx (line ~387)
  // before the REPL component is rendered. The dialog blocks execution until the user
  // accepts, and only then is the REPL component mounted and this effect runs.
  // This ensures that plugin installations from repository and user settings only
  // happen after explicit user consent to trust the current working directory.
  useEffect(() => {
    void performStartupChecks(setAppState)
  }, [setAppState])

  // Initialize swarm features: teammate hooks and context
  // Handles both fresh spawns and resumed teammate sessions
  useSwarmInitialization(setAppState, initialMessages, {
    enabled: true,
  })

  const mergedTools = useMergedTools(
    combinedInitialTools,
    mcp.tools,
    toolPermissionContext,
  )

  // Apply agent tool restrictions if mainThreadAgentDefinition is set
  const { tools, allowedAgentTypes } = useMemo(() => {
    if (!mainThreadAgentDefinition) {
      return {
        tools: mergedTools,
        allowedAgentTypes: undefined as string[] | undefined,
      }
    }
    const resolved = resolveAgentTools(
      mainThreadAgentDefinition,
      mergedTools,
      false,
      true,
    )
    return {
      tools: resolved.resolvedTools,
      allowedAgentTypes: resolved.allowedAgentTypes,
    }
  }, [mainThreadAgentDefinition, mergedTools])

  // Merge commands from local state, plugins, and MCP
  const commandsWithPlugins = useMergedCommands(
    localCommands,
    plugins.commands as Command[],
  )
  const mergedCommands = useMergedCommands(
    commandsWithPlugins,
    mcp.commands as Command[],
  )
  // Filter out all commands if disableSlashCommands is true
  const commands = useMemo(
    () => (disableSlashCommands ? [] : mergedCommands),
    [disableSlashCommands, mergedCommands],
  )

  const commandNames = useMemo(
    () => [
      ...new Set(
        commands
          .filter(c => !c.isHidden)
          .flatMap(c => [getCommandName(c), ...(c.aliases ?? [])]),
      ),
    ],
    [commands],
  )

  useIdeLogging(mcp.clients)
  useIdeSelection(mcp.clients, setIDESelection)

  // ── Message state (must come before streaming/query hooks) ──
  const {
    messages,
    messagesRef,
    setMessages,
    deferredMessages,
    userInputOnProcessing,
    setUserInputOnProcessing,
    userInputBaselineRef,
    conversationId,
    setConversationId,
    contentReplacementStateRef,
    awaitPendingHooks,
  } = useReplMessages({
    initialMessages,
    initialContentReplacements,
    pendingHookMessages,
    publishTranscript: feature('WEBUI')
      ? () => webuiAttachModule?.publishAttachTranscript()
      : undefined,
  })

  // ── Streaming state ──
  const [inProgressToolUseIDs, setInProgressToolUseIDs] = useState<Set<string>>(
    new Set(),
  )
  const [theme] = useTheme()
  const reducedMotion =
    useAppState(s => s.settings.prefersReducedMotion) ?? false
  const readFileState = useRef(
    createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE),
  )
  const bashTools = useRef(new Set<string>())
  const bashToolsProcessedIdx = useRef(0)
  const loadedNestedMemoryPathsRef = useRef(new Set<string>())
  const {
    streamMode,
    setStreamMode,
    streamModeRef,
    streamingToolUses,
    setStreamingToolUses,
    streamingThinking,
    setStreamingThinking,
    streamingText,
    setStreamingText,
    onStreamingText,
    visibleStreamingText,
    showStreamingText,
    responseLengthRef,
    setResponseLength,
    spinnerMessage,
    setSpinnerMessage,
    spinnerColor,
    setSpinnerColor,
    spinnerShimmerColor,
    setSpinnerShimmerColor,
    compactingStartTime,
    setCompactingStartTime,
    hasInterruptibleToolInProgressRef,
    tipPickedThisTurnRef,
    resetStreamingState,
    onlySleepToolActive,
    stopHookSpinnerSuffix,
  } = useReplStreaming({
    messagesRef,
    messages,
    inProgressToolUseIDs,
    setAppState,
    theme,
    reducedMotion,
    bashTools,
    bashToolsProcessedIdx,
    readFileState,
  })

  // ── Query lifecycle ──
  const {
    queryGuard,
    isQueryActive,
    isLoading,
    isExternalLoading,
    setIsExternalLoading,
    abortController,
    setAbortController,
    abortControllerRef,
    loadingStartTimeRef,
    totalPausedMsRef,
    pauseStartTimeRef,
    resetTimingRefs,
    swarmStartTimeRef,
    lastQueryCompletionTime,
    setLastQueryCompletionTime,
    resetLoadingState,
  } = useReplQueryLifecycle({
    resetStreamingState,
    setUserInputOnProcessing,
  })

  const restoreMessageSyncRef = useRef<(m: UserMessage) => void>(() => {})

  const focusedInputDialogRef = React.useRef<
    | 'message-selector'
    | 'tool-permission'
    | 'prompt'
    | 'elicitation'
    | 'ide-onboarding'
    | undefined
  >(undefined)

  // Terminal-compatibility notices, once per session.
  // tmux + `mouse off`: wheel won't scroll. We no longer mutate tmux's
  // session-scoped mouse option (it poisoned sibling panes); tmux users
  // already know this tradeoff from vim/less.
  // tmux -CC: alt-screen + mouse tracking is unrecoverable there and we no
  // longer have an inline fallback, so say so instead of degrading silently.
  useEffect(() => {
    const controlModeWarning = maybeGetTmuxControlModeWarning()
    if (controlModeWarning) {
      addNotification({
        key: 'tmux-control-mode-warning',
        text: controlModeWarning,
        priority: 'high',
      })
    }
    void maybeGetTmuxMouseHint().then(hint => {
      if (hint) {
        addNotification({
          key: 'tmux-mouse-hint',
          text: hint,
          priority: 'low',
        })
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const { toolJSX, setToolJSX, isShowingLocalJSXCommand } = useReplToolJSX()

  // ── Transcript state (scroll, search, unseen divider, frozen mode) ──
  const {
    screen,
    setScreen,
    editorStatus,
    scrollRef,
    modalScrollRef,
    scrollKeyTargetRef,
    lastUserScrollTsRef,
    cursor,
    setCursor,
    cursorNavRef,
    dividerYRef,
    jumpToNew,
    shiftDivider,
    unseenDivider,
    repinScroll,
    composedOnScroll,
    frozenTranscriptState,
    handleEnterTranscript,
    handleExitTranscript,
    transcriptMessages,
    transcriptStreamingToolUses,
    jumpRef,
    searchOpen,
    setSearchOpen,
    searchQuery,
    setSearchQuery,
    searchCount,
    setSearchCount,
    searchCurrent,
    setSearchCurrent,
    onSearchMatchesChange,
    setHighlight,
    scanElement,
    setPositions,
    globalKeybindingProps,
    showInjectedContext,
    RECENT_SCROLL_REPIN_WINDOW_MS,
  } = useReplTranscript({
    messages,
    deferredMessages,
    streamingToolUses,
    viewingAgentTaskId,
    tools,
  })
  useAwaySummary(messages, setMessages, isLoading)
  // ── Input state ──
  const {
    inputValue,
    inputValueRef,
    setInputValue,
    setInputValueRaw,
    insertTextRef,
    isPromptInputActive,
    setIsPromptInputActive,
    inputMode,
    setInputMode,
    stashedPrompt,
    setStashedPrompt,
    pastedContents,
    setPastedContents,
    submitCount,
    setSubmitCount,
    vimMode,
    setVimMode,
    showBashesDialog,
    setShowBashesDialog,
    isSearchingHistory,
    setIsSearchingHistory,
    isHelpOpen,
    setIsHelpOpen,
  } = useReplInput({
    repinScroll,
    lastUserScrollTsRef,
    recentScrollRepinWindowMs: RECENT_SCROLL_REPIN_WINDOW_MS,
    trySuggestBgPRIntercept,
  })
  const [isMessageSelectorVisible, setIsMessageSelectorVisible] =
    useState(false)
  const [messageSelectorPreselect, setMessageSelectorPreselect] = useState<
    UserMessage | undefined
  >(undefined)

  // theme, tipPicked, pickNewSpinnerTip, resetLoadingState → useReplStreaming + useReplQueryLifecycle

  // Session backgrounding — hook is below, after getToolUseContext

  const hasRunningTeammates = useMemo(
    () => getAllInProcessTeammateTasks(tasks).some(t => t.status === 'running'),
    [tasks],
  )

  // Show deferred turn duration message once all swarm teammates finish
  useEffect(() => {
    if (!hasRunningTeammates && swarmStartTimeRef.current !== null) {
      const totalMs = Date.now() - swarmStartTimeRef.current
      swarmStartTimeRef.current = null
      setMessages(prev => [
        ...prev,
        createTurnDurationMessage(
          totalMs,
          // Count only what recordTranscript will persist — ephemeral
          // progress ticks and non-ant attachments are filtered by
          // isLoggableMessage and never reach disk. Using raw prev.length
          // would make checkResumeConsistency report false delta<0 for
          // every turn that ran a progress-emitting tool.
          count(prev, isLoggableMessage),
        ),
      ])
    }
  }, [hasRunningTeammates, setMessages])

  // Show auto permissions warning once per session when entering auto mode.
  const safeYoloMessageShownRef = useRef(false)
  useEffect(() => {
    if (toolPermissionContext.mode !== 'auto') {
      return
    }
    if (safeYoloMessageShownRef.current) return
    const timer = setTimeout(
      (ref, setMessages) => {
        ref.current = true
        setMessages(prev => [
          ...prev,
          createSystemMessage(
            "Auto mode lets Claude handle permission prompts automatically — Claude checks each tool call for risky actions and prompt injection before executing. Actions Claude identifies as safe are executed, while actions Claude identifies as risky are blocked and Claude may try a different approach. Ideal for long-running tasks. Sessions are slightly more expensive. Claude can make mistakes that allow harmful commands to run, it's recommended to only use in isolated environments. Shift+Tab to change mode.",
            'warning',
          ),
        ])
      },
      800,
      safeYoloMessageShownRef,
      setMessages,
    )
    return () => clearTimeout(timer)
  }, [toolPermissionContext.mode, setMessages])

  // If worktree creation was slow and sparse-checkout isn't configured,
  // nudge the user toward settings.worktree.sparsePaths.
  const worktreeTipShownRef = useRef(false)
  useEffect(() => {
    if (worktreeTipShownRef.current) return
    const wt = getCurrentWorktreeSession()
    if (!wt?.creationDurationMs || wt.usedSparsePaths) return
    if (wt.creationDurationMs < 15_000) return
    worktreeTipShownRef.current = true
    const secs = Math.round(wt.creationDurationMs / 1000)
    setMessages(prev => [
      ...prev,
      createSystemMessage(
        `Worktree creation took ${secs}s. For large repos, set \`worktree.sparsePaths\` in .freecode/freecode.json to check out only the directories you need — e.g. \`{"worktree": {"sparsePaths": ["src", "packages/foo"]}}\`.`,
        'info',
      ),
    ])
  }, [setMessages])

  // onlySleepToolActive → useReplStreaming

  const {
    onBeforeQuery: mrOnBeforeQuery,
    onTurnComplete: mrOnTurnComplete,
    render: mrRender,
  } = useMoreRight({
    enabled: false,
    setMessages,
    inputValue,
    setInputValue,
    setToolJSX,
  })

  const { exitFlow, isExiting, handleExit } = useReplExit()
  // ── Dialog/permission/cancel state ──
  const {
    toolUseConfirmQueue,
    setToolUseConfirmQueue,
    permissionStickyFooter,
    setPermissionStickyFooter,
    promptQueue,
    setPromptQueue,
    isWaitingForApproval,
    hasActivePrompt,
    focusedInputDialog,
    hasSuppressedDialogs,
    onCancel,
    cancelRequestProps,
    handleQueuedCommandOnCancel,
    setToolPermissionContext,
    canUseTool,
    requestPrompt,
  } = useReplDialogs({
    toolJSX,
    isShowingLocalJSXCommand,
    isExiting,
    exitFlow,
    isMessageSelectorVisible,
    showIdeOnboarding,
    isPromptInputActive,
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
  })

  // ── Terminal title (needs isWaitingForApproval from dialogs hook) ──
  const {
    sessionTitle,
    autoTitle,
    setAutoTitle,
    autoTitleAttemptedRef,
    agentTitle,
    terminalTitle,
    titleIsAnimating,
    sessionStatus,
    showStatusInTerminalTab,
  } = useReplTerminalStatus({
    titleDisabled,
    mainThreadAgentDefinition,
    initialMessages,
    isLoading,
    isWaitingForApproval,
    isShowingLocalJSXCommand,
  })

  const showSpinner =
    (!toolJSX || toolJSX.showSpinner === true) &&
    toolUseConfirmQueue.length === 0 &&
    promptQueue.length === 0 &&
    // Show spinner during input processing, API call, while teammates are running,
    // or while pending task notifications are queued (prevents spinner bounce between consecutive notifications)
    (isLoading ||
      userInputOnProcessing ||
      hasRunningTeammates ||
      // Keep spinner visible while task notifications are queued for processing.
      // Without this, the spinner briefly disappears between consecutive notifications
      // (e.g., multiple background agents completing in rapid succession) because
      // isLoading goes false momentarily between processing each one.
      getCommandQueueLength() > 0) &&
    // Hide spinner when waiting for leader to approve permission request
    !pendingWorkerRequest &&
    !onlySleepToolActive &&
    // Hide spinner when streaming text is visible (the text IS the feedback),
    // but keep it when isBriefOnly suppresses the streaming text display
    (!visibleStreamingText || isBriefOnly)

  // hasActivePrompt → useReplDialogs

  // Initialize IDE integration
  useIDEIntegration({
    autoConnectIdeFlag,
    ideToInstallExtension,
    setDynamicMcpConfig,
    setShowIdeOnboarding,
    setIDEInstallationState: setIDEInstallationStatus,
  })

  useFileHistorySnapshotInit(
    initialFileHistorySnapshots,
    fileHistory,
    fileHistoryState =>
      setAppState(prev => ({
        ...prev,
        fileHistory: fileHistoryState,
      })),
  )

  // readFileState, bashTools, bashToolsProcessedIdx, loadedNestedMemoryPathsRef → declared with useReplStreaming above

  // Helper to restore read file state from messages (used for resume flows)
  // This allows Claude to edit files that were read in previous sessions
  const restoreReadFileState = useCallback(
    (messages: MessageType[], cwd: string) => {
      const extracted = extractReadFilesFromMessages(
        messages,
        cwd,
        READ_FILE_STATE_CACHE_SIZE,
      )
      readFileState.current = mergeFileStateCaches(
        readFileState.current,
        extracted,
      )
      for (const tool of extractBashToolsFromMessages(messages)) {
        bashTools.current.add(tool)
      }
    },
    [],
  )

  // Extract read file state from initialMessages on mount
  // This handles CLI flag resume (--resume-session) and ResumeConversation screen
  // where messages are passed as props rather than through the resume callback
  useEffect(() => {
    if (initialMessages && initialMessages.length > 0) {
      restoreReadFileState(initialMessages, getOriginalCwd())
    }
    // Only run on mount - initialMessages shouldn't change during component lifetime
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const { resume } = useReplSessionResume({
    setToolJSX,
    setMessages,
    setInputValue,
    setAbortController,
    setConversationId,
    setAutoTitle,
    autoTitleAttemptedRef,
    setMainThreadAgentDefinition,
    initialMainThreadAgentDefinition,
    agentDefinitions,
    mainLoopModel,
    mainThreadAgentDefinition,
    setAppState,
    store,
    contentReplacementStateRef,
    resetLoadingState,
    restoreReadFileState,
  })

  const { status: apiKeyStatus, reverify } = useApiKeyVerification()

  // exitFlow, isExiting, handleExit → useReplExit (called above)

  // Dialog focus, cancel, permission context, canUseTool, requestPrompt → useReplDialogs

  const { getToolUseContext } = useReplToolUseContext({
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
    requestPrompt: feature('HOOK_PROMPTS') ? requestPrompt : undefined,
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
  })

  const { handleBackgroundSession } = useReplBackgrounding({
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
  })

  const { onQuery, onQueryEvent, handleIncomingPrompt } = useReplQueryExecution(
    {
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
      proactiveActive: proactiveActive as boolean,
    },
  )

  // ── Submission (onSubmit, onAgentSubmit, processInitialMessage) ──
  const { onSubmit, onAgentSubmit, handleOpenRateLimitOptions } =
    useReplSubmission({
      initialMessage,
      isLoading,
      setMessages,
      setAppState,
      onQuery,
      mainLoopModel,
      repinScroll,
      onSubmit_deps: {
        queryGuard,
        isExternalLoading,
        inputMode,
        commands,
        setInputValue,
        setInputMode,
        setPastedContents,
        setSubmitCount,
        setIDESelection,
        setToolJSX,
        getToolUseContext,
        messagesRef,
        pastedContents,
        ideSelection,
        setUserInputOnProcessing,
        setAbortController,
        abortController,
        addNotification,
        stashedPrompt,
        setStashedPrompt,
        onBeforeQuery,
        canUseTool,
        awaitPendingHooks,
        inputValueRef,
        streamModeRef,
        hasInterruptibleToolInProgressRef,
        readFileState,
        resetTimingRefs,
        tipPickedThisTurnRef,
      },
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
    })
  // handleExit → useReplExit hook

  const handleShowMessageSelector = useCallback(() => {
    setIsMessageSelectorVisible(prev => !prev)
  }, [])

  // Rewind conversation state to just before `message`: slice messages,
  // reset conversation ID, microcompact state, permission mode, prompt suggestion.
  // Does NOT touch the prompt input. Index is computed from messagesRef (always
  // fresh via the setMessages wrapper) so callers don't need to worry about
  // stale closures.
  const rewindConversationTo = useCallback(
    (message: UserMessage) => {
      const prev = messagesRef.current
      const messageIndex = prev.lastIndexOf(message)
      if (messageIndex === -1) return

      setMessages(prev.slice(0, messageIndex))
      // Careful, this has to happen after setMessages
      setConversationId(randomUUID())
      // Restore state from the message we're rewinding to
      setAppState(prev => ({
        ...prev,
        // Restore permission mode from the message
        toolPermissionContext:
          message.permissionMode &&
          prev.toolPermissionContext.mode !== message.permissionMode
            ? {
                ...prev.toolPermissionContext,
                mode: message.permissionMode,
              }
            : prev.toolPermissionContext,
        // Clear stale prompt suggestion from previous conversation state
        promptSuggestion: {
          text: null,
          promptId: null,
          shownAt: 0,
          acceptedAt: 0,
          generationRequestId: null,
        },
      }))
    },
    [setMessages, setAppState],
  )

  // Synchronous rewind + input population. Used directly by auto-restore on
  // interrupt (so React batches with the abort's setMessages → single render,
  // no flicker). MessageSelector wraps this in setImmediate via handleRestoreMessage.
  const restoreMessageSync = useCallback(
    (message: UserMessage) => {
      rewindConversationTo(message)

      const r = textForResubmit(message)
      if (r) {
        setInputValue(r.text)
        setInputMode(r.mode)
      }

      // Restore pasted images
      if (
        Array.isArray(message.message.content) &&
        message.message.content.some(block => block.type === 'image')
      ) {
        const imageBlocks: Array<DomainUserImageBlock> =
          message.message.content.filter(
            (block): block is DomainUserImageBlock => block.type === 'image',
          )
        if (imageBlocks.length > 0) {
          const newPastedContents: Record<number, PastedContent> = {}
          imageBlocks.forEach((block, index) => {
            if (block.source.type === 'base64') {
              const id = message.imagePasteIds?.[index] ?? index + 1
              newPastedContents[id] = {
                id,
                type: 'image',
                content: block.source.data,
                mediaType: block.source.media_type,
              }
            }
          })
          setPastedContents(newPastedContents)
        }
      }
    },
    [rewindConversationTo, setInputValue],
  )
  restoreMessageSyncRef.current = restoreMessageSync

  // MessageSelector path: defer via setImmediate so the "Interrupted" message
  // renders to static output before rewind — otherwise it remains vestigial
  // at the top of the screen.
  const handleRestoreMessage = useCallback(
    async (message: UserMessage) => {
      setImmediate(
        (restore, message) => restore(message),
        restoreMessageSync,
        message,
      )
    },
    [restoreMessageSync],
  )

  // Not memoized — hook stores caps via ref, reads latest closure at dispatch.
  // 24-char prefix: deriveUUID preserves first 24, renderable uuid prefix-matches raw source.
  const findRawIndex = (uuid: string) => {
    const prefix = uuid.slice(0, 24)
    return messages.findIndex(m => m.uuid.slice(0, 24) === prefix)
  }
  const messageActionCaps: MessageActionCaps = {
    copy: text =>
      // setClipboard RETURNS OSC 52 — caller must stdout.write (tmux side-effects load-buffer, but that's tmux-only).
      void setClipboard(text).then(raw => {
        if (raw) process.stdout.write(raw)
        addNotification({
          // Same key as text-selection copy — repeated copies replace toast, don't queue.
          key: 'selection-copied',
          text: 'copied',
          color: 'success',
          priority: 'immediate',
          timeoutMs: 2000,
        })
      }),
    edit: async msg => {
      // Same skip-confirm check as /rewind: lossless → direct, else confirm dialog.
      const rawIdx = findRawIndex(msg.uuid)
      const raw = rawIdx >= 0 ? messages[rawIdx] : undefined
      if (!raw || !selectableUserMessagesFilter(raw)) return
      const noFileChanges = !(await fileHistoryHasAnyChanges(
        fileHistory,
        raw.uuid,
      ))
      const onlySynthetic = messagesAfterAreOnlySynthetic(messages, rawIdx)
      if (noFileChanges && onlySynthetic) {
        // rewindConversationTo's setMessages races stream appends — cancel first (idempotent).
        onCancel()
        // handleRestoreMessage also restores pasted images.
        void handleRestoreMessage(raw)
      } else {
        // Dialog path: onPreRestore (= onCancel) fires when user CONFIRMS, not on nevermind.
        setMessageSelectorPreselect(raw)
        setIsMessageSelectorVisible(true)
      }
    },
  }
  const { enter: enterMessageActions, handlers: messageActionHandlers } =
    useMessageActions(cursor, setCursor, cursorNavRef, messageActionCaps)

  async function onInit() {
    // Always verify API key on startup, so we can show the user an error in the
    // bottom right corner of the screen if the API key is invalid.
    void reverify()

    // Populate readFileState with CLAUDE.md files at startup
    const memoryFiles = await getMemoryFiles()
    if (memoryFiles.length > 0) {
      const fileList = memoryFiles
        .map(
          f =>
            `  [${f.type}] ${f.path} (${f.content.length} chars)${f.parent ? ` (included by ${f.parent})` : ''}`,
        )
        .join('\n')
      logForDebugging(
        `Loaded ${memoryFiles.length} CLAUDE.md/rules files:\n${fileList}`,
      )
    } else {
      logForDebugging('No CLAUDE.md/rules files found')
    }
    for (const file of memoryFiles) {
      // When the injected content doesn't match disk (stripped HTML comments,
      // stripped frontmatter, MEMORY.md truncation), cache the RAW disk bytes
      // with isPartialView so Edit/Write require a real Read first while
      // getChangedFiles + nested_memory dedup still work.
      readFileState.current.set(file.path, {
        content: file.contentDiffersFromDisk
          ? (file.rawContent ?? file.content)
          : file.content,
        timestamp: Date.now(),
        offset: undefined,
        limit: undefined,
        isPartialView: file.contentDiffersFromDisk,
      })
    }

    // Initial message handling is done via the initialMessage effect
  }

  // Register cost summary tracker
  useCostSummary()

  // Record transcripts locally, for debugging and conversation recovery
  // Don't record conversation if we only have initial messages; optimizes
  // the case where user resumes a conversation then quites before doing
  // anything else
  useLogMessages(messages, messages.length === initialMessages?.length)

  useAfterFirstRender()

  // Process queued commands when query completes and queue has items

  const executeQueuedInput = useCallback(
    async (queuedCommands: QueuedCommand[]) => {
      await handlePromptSubmit({
        helpers: {
          setCursorOffset: () => {},
          clearBuffer: () => {},
          resetHistory: () => {},
        },
        queryGuard,
        commands,
        onInputChange: () => {},
        setPastedContents: () => {},
        setToolJSX,
        getToolUseContext,
        messages,
        mainLoopModel,
        ideSelection,
        setUserInputOnProcessing,
        setAbortController,
        onQuery,
        setAppState,
        querySource: getQuerySourceForREPL(),
        onBeforeQuery,
        canUseTool,
        addNotification,
        setMessages,
        queuedCommands,
      })
    },
    [
      queryGuard,
      commands,
      setToolJSX,
      getToolUseContext,
      messages,
      mainLoopModel,
      ideSelection,
      setUserInputOnProcessing,
      canUseTool,
      setAbortController,
      onQuery,
      addNotification,
      setAppState,
      onBeforeQuery,
    ],
  )

  useQueueProcessor({
    executeQueuedInput,
    hasActiveLocalJsxUI: isShowingLocalJSXCommand,
    queryGuard,
  })

  // We'll use the global lastInteractionTime from state.ts

  // Update last interaction time when input changes.
  // Must be immediate because useEffect runs after the Ink render cycle flush.
  useEffect(() => {
    activityManager.recordUserActivity()
    updateLastInteractionTime(true)
  }, [inputValue, submitCount])

  useEffect(() => {
    if (submitCount === 1) {
      startBackgroundHousekeeping()
    }
  }, [submitCount])

  // Show notification when Claude is done responding and user is idle
  useEffect(() => {
    // Don't set up notification if Claude is busy
    if (isLoading) return

    // Only enable notifications after the first new interaction in this session
    if (submitCount === 0) return

    // No query has completed yet
    if (lastQueryCompletionTime === 0) return

    // Set timeout to check idle state
    const timer = setTimeout(
      (
        lastQueryCompletionTime,
        isLoading,
        toolJSX,
        focusedInputDialogRef,
        terminal,
      ) => {
        // Check if user has interacted since the response ended
        const lastUserInteraction = getLastInteractionTime()

        if (lastUserInteraction > lastQueryCompletionTime) {
          // User has interacted since Claude finished - they're not idle, don't notify
          return
        }

        // User hasn't interacted since response ended, check other conditions
        const idleTimeSinceResponse = Date.now() - lastQueryCompletionTime
        if (
          !isLoading &&
          !toolJSX &&
          // Use ref to get current dialog state, avoiding stale closure
          focusedInputDialogRef.current === undefined &&
          idleTimeSinceResponse >=
            (getInitialSettings().messageIdleNotifThresholdMs ?? 60000)
        ) {
          void sendNotification(
            {
              message: 'Claude is waiting for your input',
              notificationType: 'idle_prompt',
            },
            terminal,
          )
        }
      },
      getInitialSettings().messageIdleNotifThresholdMs ?? 60000,
      lastQueryCompletionTime,
      isLoading,
      toolJSX,
      focusedInputDialogRef,
      terminal,
    )

    return () => clearTimeout(timer)
  }, [isLoading, toolJSX, submitCount, lastQueryCompletionTime, terminal])

  // handleIncomingPrompt → useReplQueryExecution hook

  // Voice input integration (VOICE_MODE builds only)
  const voice = feature('VOICE_MODE')
    ? // biome-ignore lint/correctness/useHookAtTopLevel: feature() is a compile-time constant
      useVoiceIntegration({ setInputValueRaw, inputValueRef, insertTextRef })
    : {
        stripTrailing: () => 0,
        handleKeyEvent: () => {},
        resetAnchor: () => {},
        interimRange: null,
      }

  useInboxPoller({
    enabled: isAgentSwarmsEnabled(),
    isLoading,
    focusedInputDialog,
    onSubmitMessage: handleIncomingPrompt,
  })

  useMailboxBridge({ isLoading, onSubmitMessage: handleIncomingPrompt })

  // Mirror this session onto its attach socket so a browser can watch and
  // drive it. Every callback is a no-op when the WebUI is compiled out.
  useReplAttachBridge({
    messagesRef,
    getState: () =>
      toolUseConfirmQueue.length > 0
        ? 'requires_action'
        : isLoading
          ? 'running'
          : 'idle',
    // streamMode keeps its last value after a turn ends, so gate it on loading.
    getActivity: () => (isLoading ? streamMode : undefined),
    getIsCompacting: () => compactingStartTime !== null,
    getModel: () => mainLoopModel,
    getPermissionMode: () => toolPermissionContext.mode,
    getInProgressToolUseIds: () => inProgressToolUseIDs,
    todos: tasksV2,
    commandNames,
    onCancel,
    onSetPermissionMode: mode => {
      setAppState(prev => {
        const context = prev.toolPermissionContext
        // Not a bare assignment: the transition is what records `prePlanMode`
        // on the way into plan mode and restores it on the way out.
        const next = transitionPermissionMode(context.mode, mode, context)
        return {
          ...prev,
          toolPermissionContext: { ...next, mode },
        }
      })
    },
    onSetModel: model => {
      setAppState(prev => ({ ...prev, mainLoopModelForSession: model }))
    },
  })

  // Scheduled tasks from .freecode/scheduled_tasks.json (CronCreate/Delete/List)
  if (feature('AGENT_TRIGGERS')) {
    // Assistant mode bypasses the isLoading gate (the proactive tick →
    // Sleep → tick loop would otherwise starve the scheduler).
    // kairosEnabled is set once in initialState (main.tsx) and never mutated — no
    // subscription needed. The isKairosCronEnabled() runtime gate is checked
    // inside useScheduledTasks's effect (not here) since wrapping a hook call
    // in a dynamic condition would break rules-of-hooks.
    const assistantMode = store.getState().kairosEnabled
    // biome-ignore lint/correctness/useHookAtTopLevel: feature() is a compile-time constant
    useScheduledTasks!({ isLoading, assistantMode, setMessages })
  }

  // Note: Permission polling is now handled by useInboxPoller
  // - Workers receive permission responses via mailbox messages
  // - Leaders receive permission requests via mailbox messages

  if (feature('COORDINATOR_MODE')) {
    // Tasks mode: watch for tasks and auto-process them
    // eslint-disable-next-line react-hooks/rules-of-hooks
    // biome-ignore lint/correctness/useHookAtTopLevel: conditional for dead code elimination when COORDINATOR_MODE is off
    useTaskListWatcher({
      taskListId,
      isLoading,
      onSubmitTask: handleIncomingPrompt,
    })

    // Loop mode: auto-tick when enabled (via /job command)
    // eslint-disable-next-line react-hooks/rules-of-hooks
    // biome-ignore lint/correctness/useHookAtTopLevel: conditional for dead code elimination when COORDINATOR_MODE is off
    useProactive?.({
      // Suppress ticks while an initial message is pending — the initial
      // message will be processed asynchronously and a premature tick would
      // race with it, causing concurrent-query enqueue of expanded skill text.
      isLoading: isLoading || initialMessage !== null,
      queuedCommandsLength: queuedCommands.length,
      hasActiveLocalJsxUI: isShowingLocalJSXCommand,
      isInPlanMode: toolPermissionContext.mode === 'plan',
      onSubmitTick: (prompt: string) =>
        handleIncomingPrompt(prompt, { isMeta: true }),
      onQueueTick: (prompt: string) =>
        enqueue({ mode: 'prompt', value: prompt, isMeta: true }),
    })
  }

  // Abort the current operation when a 'now' priority message arrives
  // (e.g. from a chat UI client via UDS).
  useEffect(() => {
    if (queuedCommands.some(cmd => cmd.priority === 'now')) {
      abortControllerRef.current?.abort('interrupt')
    }
  }, [queuedCommands])

  // Initial load
  useEffect(() => {
    void onInit()

    // Cleanup on unmount
    return () => {
      void diagnosticTracker.shutdown()
    }
    // TODO: fix this
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Listen for suspend/resume events
  const { internal_eventEmitter } = useStdin()
  const [remountKey, setRemountKey] = useState(0)
  useEffect(() => {
    const handleSuspend = () => {
      // Print suspension instructions
      process.stdout.write(
        `\nClaude Code has been suspended. Run \`fg\` to bring Claude Code back.\nNote: ctrl + z now suspends Claude Code, ctrl + _ undoes input.\n`,
      )
    }

    const handleResume = () => {
      // Force complete component tree replacement instead of terminal clear
      // Ink now handles line count reset internally on SIGCONT
      setRemountKey(prev => prev + 1)
    }

    internal_eventEmitter?.on('suspend', handleSuspend)
    internal_eventEmitter?.on('resume', handleResume)
    return () => {
      internal_eventEmitter?.off('suspend', handleSuspend)
      internal_eventEmitter?.off('resume', handleResume)
    }
  }, [internal_eventEmitter])

  // stopHookSpinnerSuffix → useReplStreaming

  // Handle shift+down for teammate navigation and background task management.
  // Guard onOpenBackgroundTasks when a local-jsx dialog (e.g. /mcp) is open —
  // otherwise Shift+Down stacks BackgroundTasksDialog on top and deadlocks input.
  useBackgroundTaskNavigation({
    onOpenBackgroundTasks: isShowingLocalJSXCommand
      ? undefined
      : () => setShowBashesDialog(true),
  })
  // Auto-exit viewing mode when teammate completes or errors
  useTeammateViewAutoExit()

  if (screen === 'transcript') {
    // Virtual scroll replaces the 30-message cap: everything is scrollable
    // and memory is bounded by the viewport. Reusing scrollRef is safe —
    // normal-mode and transcript-mode are mutually exclusive (this early
    // return), so only one ScrollBox is ever mounted at a time.
    const transcriptMessagesElement = (
      <Messages
        messages={transcriptMessages}
        tools={tools}
        commands={commands}
        verbose={true}
        toolJSX={null}
        toolUseConfirmQueue={[]}
        inProgressToolUseIDs={inProgressToolUseIDs}
        isMessageSelectorVisible={false}
        conversationId={conversationId}
        screen={screen}
        agentDefinitions={agentDefinitions}
        streamingToolUses={transcriptStreamingToolUses}
        onOpenRateLimitOptions={handleOpenRateLimitOptions}
        isLoading={isLoading}
        streamingThinking={streamingThinking}
        scrollRef={scrollRef}
        jumpRef={jumpRef}
        onSearchMatchesChange={onSearchMatchesChange}
        scanElement={scanElement}
        setPositions={setPositions}
        showRequestOnlyUserContext={true}
      />
    )
    const transcriptToolJSX = toolJSX && (
      <Box flexDirection="column" width="100%">
        {toolJSX.jsx}
      </Box>
    )
    const transcriptReturn = (
      <ReplKeybindingShell
        titleIsAnimating={titleIsAnimating}
        terminalTitle={terminalTitle}
        titleDisabled={titleDisabled}
        showStatusInTerminalTab={showStatusInTerminalTab}
        globalKeybindingProps={globalKeybindingProps}
        voice={voice}
        toolJSX={toolJSX}
        onSubmit={onSubmit}
        scrollRef={scrollRef}
        scrollIsActive={true}
        scrollIsModal={!searchOpen}
        scrollOnScroll={() => jumpRef.current?.disarmSearch()}
        cancelRequestProps={cancelRequestProps}
      >
        <FullscreenLayout
          scrollRef={scrollRef}
          scrollable={
            <>
              {transcriptMessagesElement}
              {transcriptToolJSX}
            </>
          }
          bottom={
            searchOpen ? (
              <TranscriptSearchBar
                jumpRef={jumpRef}
                initialQuery=""
                count={searchCount}
                current={searchCurrent}
                onClose={q => {
                  setSearchQuery(searchCount > 0 ? q : '')
                  setSearchOpen(false)
                  if (!q) {
                    setSearchCount(0)
                    setSearchCurrent(0)
                    jumpRef.current?.setSearchQuery('')
                  }
                }}
                onCancel={() => {
                  setSearchOpen(false)
                  jumpRef.current?.setSearchQuery('')
                  jumpRef.current?.setSearchQuery(searchQuery)
                  setHighlight(searchQuery)
                }}
                setHighlight={setHighlight}
              />
            ) : (
              <TranscriptModeFooter
                status={editorStatus || undefined}
                searchBadge={
                  searchQuery && searchCount > 0
                    ? { current: searchCurrent, count: searchCount }
                    : undefined
                }
              />
            )
          }
        />
      </ReplKeybindingShell>
    )
    // FullscreenLayout needs <AlternateScreen>'s <Box height={rows}>
    // constraint — without it, ScrollBox's flexGrow has no ceiling, viewport =
    // content height, scrollTop pins at 0, and Ink's screen buffer sizes to the
    // full spacer (200×5k+ rows on long sessions). Same root type + props as
    // normal mode's wrap below so React reconciles and the alt buffer stays
    // entered across toggle.
    return (
      <AlternateScreen mouseTracking={isMouseTrackingEnabled()}>
        {transcriptReturn}
      </AlternateScreen>
    )
  }

  // Get viewed agent task (inlined from selectors for explicit data flow).
  // viewedAgentTask: teammate OR local_agent — drives the boolean checks
  // below. viewedTeammateTask: teammate-only narrowed, for teammate-specific
  // field access (inProgressToolUseIDs).
  const viewedTask = viewingAgentTaskId ? tasks[viewingAgentTaskId] : undefined
  const viewedTeammateTask =
    viewedTask && isInProcessTeammateTask(viewedTask) ? viewedTask : undefined
  const viewedAgentTask =
    viewedTeammateTask ??
    (viewedTask && isLocalAgentTask(viewedTask) ? viewedTask : undefined)

  // Bypass useDeferredValue when streaming text is showing so Messages renders
  // the final message in the same frame streaming text clears. Also bypass when
  // not loading — deferredMessages only matters during streaming (keeps input
  // responsive); after the turn ends, showing messages immediately prevents a
  // jitter gap where the spinner is gone but the answer hasn't appeared yet.
  // Only reducedMotion users keep the deferred path during loading.
  const usesSyncMessages = showStreamingText || !isLoading
  // When viewing an agent, never fall through to leader — empty until
  // bootstrap/stream fills. Closes the see-leader-type-agent footgun.
  const displayedMessages = viewedAgentTask
    ? (viewedAgentTask.messages ?? [])
    : usesSyncMessages
      ? messages
      : deferredMessages
  // Show the placeholder until the real user message appears in
  // displayedMessages. userInputOnProcessing stays set for the whole turn
  // (cleared in resetLoadingState); this length check hides it once
  // displayedMessages grows past the baseline captured at submit time.
  // Covers both gaps: before setMessages is called (processUserInput), and
  // while deferredMessages lags behind messages. Suppressed when viewing an
  // agent — displayedMessages is a different array there, and onAgentSubmit
  // doesn't use the placeholder anyway.
  const placeholderText =
    userInputOnProcessing &&
    !viewedAgentTask &&
    displayedMessages.length <= userInputBaselineRef.current
      ? userInputOnProcessing
      : undefined

  const toolPermissionOverlay =
    focusedInputDialog === 'tool-permission' ? (
      <PermissionRequest
        key={toolUseConfirmQueue[0]?.toolUseID}
        onDone={() => setToolUseConfirmQueue(([_, ...tail]) => tail)}
        onReject={handleQueuedCommandOnCancel}
        toolUseConfirm={toolUseConfirmQueue[0]!}
        toolUseContext={getToolUseContext(
          messages,
          messages,
          abortController ?? createAbortController(),
          mainLoopModel,
        )}
        verbose={verbose}
        workerBadge={toolUseConfirmQueue[0]?.workerBadge}
        setStickyFooter={setPermissionStickyFooter}
      />
    ) : null

  // ALL local-jsx slash commands float in the modal slot — FullscreenLayout
  // wraps them in an absolute-positioned bottom-anchored pane (▔ divider,
  // ModalContext). Pane/Dialog inside detect the context and skip their own
  // top-level frame. Commands that used to route through bottom (immediate:
  // /model, /mcp, /btw, ...) and scrollable (non-immediate: /config, /theme,
  // /diff, ...) both go here now.
  const toolJsxCentered = toolJSX?.isLocalJSXCommand === true
  // BackgroundTasksDialog (and its child ShellDetailDialog) also routes
  // through the modal slot so it gets the full-terminal budget
  // (rows - MODAL_TRANSCRIPT_PEEK) instead of the bottom slot's maxHeight=50%
  // cap. The 50% cap caused yoga to squish deep children to h=0 when the
  // dialog was tall (overlapping rows like "Output:" + position label) and
  // clipped the input guide below the viewport. PromptInput returns null in
  // this case so its input doesn't render behind the modal.
  const showBashesDialogInModal = !!showBashesDialog
  const centeredModal: React.ReactNode = toolJsxCentered ? (
    toolJSX!.jsx
  ) : showBashesDialogInModal ? (
    <BackgroundTasksDialog
      onDone={() => setShowBashesDialog(false)}
      toolUseContext={getToolUseContext(
        messages,
        [],
        new AbortController(),
        mainLoopModel,
      )}
      initialDetailTaskId={
        typeof showBashesDialog === 'string' ? showBashesDialog : undefined
      }
    />
  ) : null

  // <AlternateScreen> at the root: everything below is inside its
  // <Box height={rows}>. Handlers/contexts are zero-height so ScrollBox's
  // flexGrow in FullscreenLayout resolves against this Box. The transcript
  // early return above wraps its virtual-scroll branch the same way; only
  // the 30-cap dump branch stays unwrapped for native terminal scrollback.
  const mainReturn = (
    <ReplKeybindingShell
      titleIsAnimating={titleIsAnimating}
      terminalTitle={terminalTitle}
      titleDisabled={titleDisabled}
      showStatusInTerminalTab={showStatusInTerminalTab}
      globalKeybindingProps={globalKeybindingProps}
      voice={voice}
      toolJSX={toolJSX}
      onSubmit={onSubmit}
      scrollRef={scrollKeyTargetRef}
      scrollIsActive={
        centeredModal != null ||
        !focusedInputDialog ||
        focusedInputDialog === 'tool-permission'
      }
      scrollOnScroll={
        centeredModal || toolPermissionOverlay || viewedAgentTask
          ? undefined
          : composedOnScroll
      }
      cancelRequestProps={cancelRequestProps}
      messageActionHandlers={messageActionHandlers}
      disableMessageActions={disableMessageActions}
      cursor={cursor}
    >
      <MCPConnectionManager
        key={remountKey}
        dynamicMcpConfig={dynamicMcpConfig}
        isStrictMcpConfig={strictMcpConfig}
      >
        <FullscreenLayout
          scrollRef={scrollRef}
          overlay={toolPermissionOverlay}
          modal={centeredModal}
          modalScrollRef={modalScrollRef}
          dividerYRef={dividerYRef}
          hidePill={!!viewedAgentTask}
          hideSticky={!!viewedAgentTask}
          newMessageCount={unseenDivider?.count ?? 0}
          onPillClick={() => {
            setCursor(null)
            jumpToNew(scrollRef.current)
          }}
          scrollable={
            <>
              <TeammateViewHeader />
              <Messages
                key={viewingAgentTaskId ?? 'leader'}
                messages={displayedMessages}
                tools={tools}
                commands={commands}
                verbose={verbose}
                toolJSX={toolJSX}
                toolUseConfirmQueue={toolUseConfirmQueue}
                inProgressToolUseIDs={
                  viewedAgentTask
                    ? (viewedTeammateTask?.inProgressToolUseIDs ??
                      EMPTY_IN_PROGRESS_TOOL_USE_IDS)
                    : inProgressToolUseIDs
                }
                isMessageSelectorVisible={isMessageSelectorVisible}
                conversationId={conversationId}
                screen={screen}
                streamingToolUses={
                  viewedAgentTask
                    ? EMPTY_STREAMING_TOOL_USES
                    : streamingToolUses
                }
                agentDefinitions={agentDefinitions}
                hideLogo={!!viewedAgentTask}
                onOpenRateLimitOptions={handleOpenRateLimitOptions}
                isLoading={isLoading}
                streamingText={
                  isLoading && !viewedAgentTask ? visibleStreamingText : null
                }
                isBriefOnly={viewedAgentTask ? false : isBriefOnly}
                streamingThinking={
                  isLoading && !viewedAgentTask ? streamingThinking : null
                }
                unseenDivider={viewedAgentTask ? undefined : unseenDivider}
                scrollRef={scrollRef}
                trackStickyPrompt
                cursor={cursor}
                setCursor={setCursor}
                cursorNavRef={cursorNavRef}
                showRequestOnlyUserContext={
                  !viewedAgentTask && !viewedTeammateTask
                }
              />
              <AwsAuthStatusBox />
              {!disabled && placeholderText && !centeredModal && (
                <UserTextMessage
                  param={{ text: placeholderText, type: 'text' }}
                  addMargin={true}
                  verbose={verbose}
                  showInjectedContext={false}
                />
              )}
              {toolJSX &&
                !(toolJSX.isLocalJSXCommand && toolJSX.isImmediate) &&
                !toolJsxCentered && (
                  <Box flexDirection="column" width="100%">
                    {toolJSX.jsx}
                  </Box>
                )}
              <Box flexGrow={1} />
              {showSpinner && (
                <SpinnerWithVerb
                  mode={streamMode}
                  spinnerTip={spinnerTip}
                  responseLengthRef={responseLengthRef}
                  overrideMessage={spinnerMessage}
                  spinnerSuffix={stopHookSpinnerSuffix}
                  verbose={verbose}
                  loadingStartTimeRef={loadingStartTimeRef}
                  totalPausedMsRef={totalPausedMsRef}
                  pauseStartTimeRef={pauseStartTimeRef}
                  overrideColor={spinnerColor}
                  overrideShimmerColor={spinnerShimmerColor}
                  compactingStartTime={compactingStartTime}
                  hasActiveTools={inProgressToolUseIDs.size > 0}
                  leaderIsIdle={!isLoading}
                />
              )}
              {!showSpinner &&
                !isLoading &&
                !userInputOnProcessing &&
                !hasRunningTeammates &&
                isBriefOnly &&
                !viewedAgentTask && <BriefIdleStatus />}
              <PromptInputQueuedCommands />
            </>
          }
          bottom={
            <Box flexDirection="row" width="100%" alignItems="flex-end">
              <Box flexDirection="column" flexGrow={1}>
                <ReplDialogLayer
                  focusedInputDialog={focusedInputDialog}
                  setAppState={setAppState}
                  promptQueue={promptQueue}
                  setPromptQueue={setPromptQueue}
                  pendingWorkerRequest={pendingWorkerRequest}
                  elicitation={elicitation}
                  showIdeOnboarding={showIdeOnboarding}
                  setShowIdeOnboarding={setShowIdeOnboarding}
                  ideInstallationStatus={ideInstallationStatus}
                  exitFlow={exitFlow}
                  mrRender={mrRender}
                  permissionStickyFooter={permissionStickyFooter}
                  toolJSX={toolJSX}
                  toolJsxCentered={toolJsxCentered}
                  showSpinner={showSpinner}
                  showExpandedTodos={showExpandedTodos}
                  tasksV2={tasksV2}
                />

                {!toolJSX?.shouldHidePromptInput &&
                  !focusedInputDialog &&
                  !isExiting &&
                  !disabled &&
                  !cursor && (
                    <>
                      <PromptInput
                        debug={debug}
                        ideSelection={ideSelection}
                        hasSuppressedDialogs={!!hasSuppressedDialogs}
                        isLocalJSXCommandActive={isShowingLocalJSXCommand}
                        getToolUseContext={getToolUseContext}
                        toolPermissionContext={toolPermissionContext}
                        setToolPermissionContext={setToolPermissionContext}
                        apiKeyStatus={apiKeyStatus}
                        commands={commands}
                        agents={agentDefinitions.activeAgents}
                        isLoading={isLoading}
                        onExit={handleExit}
                        verbose={verbose}
                        messages={messages}
                        input={inputValue}
                        onInputChange={setInputValue}
                        mode={inputMode}
                        onModeChange={setInputMode}
                        stashedPrompt={stashedPrompt}
                        setStashedPrompt={setStashedPrompt}
                        submitCount={submitCount}
                        onShowMessageSelector={handleShowMessageSelector}
                        onMessageActionsEnter={
                          feature('MESSAGE_ACTIONS') && !disableMessageActions
                            ? enterMessageActions
                            : undefined
                        }
                        mcpClients={mcpClients}
                        pastedContents={pastedContents}
                        setPastedContents={setPastedContents}
                        vimMode={vimMode}
                        setVimMode={setVimMode}
                        showBashesDialog={showBashesDialog}
                        setShowBashesDialog={setShowBashesDialog}
                        onSubmit={onSubmit}
                        onAgentSubmit={onAgentSubmit}
                        isSearchingHistory={isSearchingHistory}
                        setIsSearchingHistory={setIsSearchingHistory}
                        helpOpen={isHelpOpen}
                        setHelpOpen={setIsHelpOpen}
                        insertTextRef={
                          feature('VOICE_MODE') ? insertTextRef : undefined
                        }
                        voiceInterimRange={voice.interimRange}
                        conversationId={conversationId}
                      />
                      <SessionBackgroundHint
                        onBackgroundSession={handleBackgroundSession}
                        isLoading={isLoading}
                      />
                    </>
                  )}
                {cursor && <MessageActionsBar cursor={cursor} />}
                {focusedInputDialog === 'message-selector' && (
                  <MessageSelector
                    messages={messages}
                    preselectedMessage={messageSelectorPreselect}
                    onPreRestore={onCancel}
                    onRestoreCode={async (message: UserMessage) => {
                      await fileHistoryRewind(
                        (
                          updater: (prev: FileHistoryState) => FileHistoryState,
                        ) => {
                          setAppState(prev => ({
                            ...prev,
                            fileHistory: updater(prev.fileHistory),
                          }))
                        },
                        message.uuid,
                      )
                    }}
                    onSummarize={async (
                      message: UserMessage,
                      feedback?: string,
                      direction: PartialCompactDirection = 'from',
                    ) => {
                      const compactMessages =
                        getMessagesAfterCompactBoundary(messages)

                      const messageIndex = compactMessages.indexOf(message)
                      if (messageIndex === -1) {
                        setMessages(prev => [
                          ...prev,
                          createSystemMessage(
                            'That message is no longer in the active context (pre-compact). Choose a more recent message.',
                            'warning',
                          ),
                        ])
                        return
                      }

                      const newAbortController = createAbortController()
                      const context = getToolUseContext(
                        compactMessages,
                        [],
                        newAbortController,
                        mainLoopModel,
                      )

                      const appState = context.getAppState()
                      const defaultSysPrompt = await getSystemPrompt(
                        context.options.tools,
                        context.options.mainLoopModel,
                        Array.from(
                          appState.toolPermissionContext.additionalWorkingDirectories.keys(),
                        ),
                        context.options.mcpClients,
                      )
                      const systemPrompt = buildEffectiveSystemPrompt({
                        mainThreadAgentDefinition: undefined,
                        toolUseContext: context,
                        customSystemPrompt: context.options.customSystemPrompt,
                        defaultSystemPrompt: defaultSysPrompt,
                        appendSystemPrompt: context.options.appendSystemPrompt,
                      })
                      const [userContext, systemContext] = await Promise.all([
                        getUserContext(),
                        getSystemContext(),
                      ])

                      const result = await partialCompactConversation(
                        compactMessages,
                        messageIndex,
                        context,
                        {
                          systemPrompt,
                          userContext,
                          systemContext,
                          toolUseContext: context,
                          forkContextMessages: compactMessages,
                        },
                        feedback,
                        direction,
                      )

                      const kept = result.messagesToKeep ?? []
                      const ordered =
                        direction === 'up_to'
                          ? [...result.summaryMessages, ...kept]
                          : [...kept, ...result.summaryMessages]
                      const postCompact = [
                        result.boundaryMarker,
                        ...ordered,
                        ...result.attachments,
                        ...result.hookResults,
                      ]
                      if (direction === 'from') {
                        setMessages(old => {
                          const rawIdx = old.findIndex(
                            m => m.uuid === message.uuid,
                          )
                          return [
                            ...old.slice(0, rawIdx === -1 ? 0 : rawIdx),
                            ...postCompact,
                          ]
                        })
                      } else {
                        setMessages(postCompact)
                      }
                      if (feature('KAIROS')) {
                        proactiveModule?.setContextBlocked(false)
                      }
                      setConversationId(randomUUID())
                      runPostCompactCleanup(context.options.querySource)

                      if (direction === 'from') {
                        const r = textForResubmit(message)
                        if (r) {
                          setInputValue(r.text)
                          setInputMode(r.mode)
                        }
                      }

                      const historyShortcut = getShortcutDisplay(
                        'app:toggleTranscript',
                        'Global',
                        'ctrl+o',
                      )
                      addNotification({
                        key: 'summarize-ctrl-o-hint',
                        text: `Conversation summarized (${historyShortcut} for history)`,
                        priority: 'medium',
                        timeoutMs: 8000,
                      })
                    }}
                    onRestoreMessage={handleRestoreMessage}
                    onClose={() => {
                      setIsMessageSelectorVisible(false)
                      setMessageSelectorPreselect(undefined)
                    }}
                  />
                )}
              </Box>
            </Box>
          }
        />
      </MCPConnectionManager>
    </ReplKeybindingShell>
  )
  return (
    <AlternateScreen mouseTracking={isMouseTrackingEnabled()}>
      {mainReturn}
    </AlternateScreen>
  )
}
