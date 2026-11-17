import { promises as fsp } from 'fs'
import { getSdkAgentProgressSummariesEnabled } from '../../bootstrap/state.js'
import { isCoordinatorMode } from '../../coordinator/coordinatorMode.js'
import type { ToolUseContext, CanUseToolFn } from '../../Tool.js'
import type { AppState } from '../../state/AppStateStore.js'
import {
  isLocalAgentTask,
  queuePendingMessage,
  registerAsyncAgent,
  updateAgentStreamingThinking,
} from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { isMainSessionTask } from '../../tasks/LocalMainSessionTask.js'
import { errorMessage } from '../../utils/errors.js'
import { assembleToolPool } from './assembleToolPool.js'
import { asAgentId } from '../../types/ids.js'
import { runWithAgentContext } from '../../utils/agentContext.js'
import { runWithCwdOverride } from '../../utils/cwd.js'
import { logForDebugging } from '../../utils/debug.js'
import {
  createUserMessage,
  filterOrphanedThinkingOnlyMessages,
  filterUnresolvedToolUses,
  filterWhitespaceOnlyAssistantMessages,
} from '../../utils/messages.js'
import { getAgentModel } from '../../utils/model/agent.js'
import { getQuerySourceForAgent } from '../../utils/promptCategory.js'
import {
  getAgentTranscript,
  readAgentMetadata,
} from '../../utils/sessionStorage.js'
import { getTaskOutputPath } from '../../utils/task/diskOutput.js'
import { reconstructForSubagentResume } from '../../utils/toolResultStorage.js'
import { runAsyncAgentLifecycle } from './agentToolUtils.js'
import { GENERAL_PURPOSE_AGENT } from './built-in/generalPurposeAgent.js'
import type { AgentDefinition } from './loadAgentsDir.js'
import { isBuiltInAgent } from './loadAgentsDir.js'
import { runAgent } from './runAgent.js'

export type ResumeAgentResult = {
  agentId: string
  description: string
  outputFile: string
}
export async function resumeAgentBackground({
  agentId,
  prompt,
  toolUseContext,
  canUseTool,
  invokingRequestId,
}: {
  agentId: string
  prompt: string
  toolUseContext: ToolUseContext
  canUseTool: CanUseToolFn
  invokingRequestId?: string
}): Promise<ResumeAgentResult> {
  const startTime = Date.now()
  const appState = toolUseContext.getAppState()
  // setAppStateForTasks reaches the root store so task registration,
  // progress and kill stay visible even inside nested contexts.
  const rootSetAppState =
    toolUseContext.setAppStateForTasks ?? toolUseContext.setAppState
  const permissionMode = appState.toolPermissionContext.mode

  const [transcript, meta] = await Promise.all([
    getAgentTranscript(asAgentId(agentId)),
    readAgentMetadata(asAgentId(agentId)),
  ])
  if (!transcript) {
    throw new Error(`No transcript found for agent ID: ${agentId}`)
  }
  const resumedMessages = filterWhitespaceOnlyAssistantMessages(
    filterOrphanedThinkingOnlyMessages(
      filterUnresolvedToolUses(transcript.messages),
    ),
  )
  const resumedReplacementState = reconstructForSubagentResume(
    toolUseContext.contentReplacementState,
    resumedMessages,
    transcript.contentReplacements,
  )
  // Best-effort: if the original worktree was removed externally, fall back
  // to parent cwd rather than crashing on chdir later.
  const resumedWorktreePath = meta?.worktreePath
    ? await fsp.stat(meta.worktreePath).then(
        s => (s.isDirectory() ? meta.worktreePath : undefined),
        () => {
          logForDebugging(
            `Resumed worktree ${meta.worktreePath} no longer exists; falling back to parent cwd`,
          )
          return undefined
        },
      )
    : undefined
  if (resumedWorktreePath) {
    // Bump mtime so stale-worktree cleanup doesn't delete a just-resumed worktree (#22355)
    const now = new Date()
    await fsp.utimes(resumedWorktreePath, now, now)
  }

  // Skip filterDeniedAgents re-gating — original spawn already passed permission checks
  let selectedAgent: AgentDefinition
  if (meta?.agentType) {
    const found = toolUseContext.options.agentDefinitions.activeAgents.find(
      a => a.agentType === meta.agentType,
    )
    selectedAgent = found ?? GENERAL_PURPOSE_AGENT
  } else {
    selectedAgent = GENERAL_PURPOSE_AGENT
  }

  const uiDescription = meta?.description ?? '(resumed)'

  // Preserve the original parent across resume — the resumer may be a
  // different agent (or the main session) than the original spawner.
  // Metadata wins; in-memory task state covers agents spawned before the
  // first resume wrote the new field.
  const prevTask = appState.tasks[agentId]
  const resumedParentAgentId =
    meta?.parentAgentId ??
    (isLocalAgentTask(prevTask) ? prevTask.parentAgentId : undefined)

  // Resolve model for analytics metadata (runAgent resolves its own internally)
  const resolvedAgentModel = getAgentModel(
    selectedAgent.model,
    toolUseContext.options.mainLoopModel,
    {
      permissionMode,
      roleConfiguredModel: selectedAgent.roleConfiguredModel,
    },
  )

  const workerPermissionContext = {
    ...appState.toolPermissionContext,
    mode: selectedAgent.permissionMode ?? 'acceptEdits',
  }
  const workerTools = assembleToolPool(
    workerPermissionContext,
    appState.mcp.tools,
  )

  const runAgentParams: Parameters<typeof runAgent>[0] = {
    agentDefinition: selectedAgent,
    promptMessages: [
      ...resumedMessages,
      createUserMessage({ content: prompt }),
    ],
    toolUseContext,
    canUseTool,
    isAsync: true,
    querySource: getQuerySourceForAgent(
      selectedAgent.agentType,
      isBuiltInAgent(selectedAgent),
    ),
    model: undefined,
    override: undefined,
    availableTools: workerTools,
    // Re-persist so metadata survives runAgent's writeAgentMetadata overwrite
    worktreePath: resumedWorktreePath,
    description: meta?.description,
    parentAgentId: resumedParentAgentId,
    contentReplacementState: resumedReplacementState,
  }

  // Skip name-registry write — original entry persists from the initial spawn
  const agentBackgroundTask = registerAsyncAgent({
    agentId,
    description: uiDescription,
    prompt,
    selectedAgent,
    setAppState: rootSetAppState,
    toolUseId: toolUseContext.toolUseId,
    parentAgentId: resumedParentAgentId,
    model: resolvedAgentModel,
  })

  const metadata = {
    prompt,
    resolvedAgentModel,
    isBuiltInAgent: isBuiltInAgent(selectedAgent),
    startTime,
    agentType: selectedAgent.agentType,
    isAsync: true,
  }

  const asyncAgentContext = {
    agentId,
    agentType: 'subagent' as const,
    subagentName: selectedAgent.agentType,
    isBuiltIn: isBuiltInAgent(selectedAgent),
    invokingRequestId,
    invocationKind: 'resume' as const,
    invocationEmitted: false,
  }

  const wrapWithCwd = <T>(fn: () => T): T =>
    resumedWorktreePath ? runWithCwdOverride(resumedWorktreePath, fn) : fn()

  void runWithAgentContext(asyncAgentContext, () =>
    wrapWithCwd(() =>
      runAsyncAgentLifecycle({
        taskId: agentBackgroundTask.agentId,
        abortController: agentBackgroundTask.abortController!,
        makeStream: onCacheSafeParams =>
          runAgent({
            ...runAgentParams,
            override: {
              ...runAgentParams.override,
              agentId: asAgentId(agentBackgroundTask.agentId),
              abortController: agentBackgroundTask.abortController!,
            },
            onCacheSafeParams,
            onStreamingThinking: updater =>
              updateAgentStreamingThinking(
                agentBackgroundTask.agentId,
                updater,
                rootSetAppState,
              ),
          }),
        metadata,
        description: uiDescription,
        toolUseContext,
        rootSetAppState,
        agentIdForCleanup: agentId,
        enableSummarization:
          isCoordinatorMode() || getSdkAgentProgressSummariesEnabled(),
        getWorktreeResult: async () =>
          resumedWorktreePath ? { worktreePath: resumedWorktreePath } : {},
      }),
    ),
  )

  return {
    agentId,
    description: uiDescription,
    outputFile: getTaskOutputPath(agentId),
  }
}

/**
 * Deliver a message to one in-process subagent, shared by SendMessageTool and
 * the attach runtimes (a WebUI composer pointed at a subagent transcript).
 *
 * A running agent gets the message queued for its next tool round; a stopped
 * or evicted agent is auto-resumed from its transcript with the message as
 * prompt. The task store is re-read per call — an await (resume) may have
 * changed it since the caller's snapshot.
 */
export async function messageAgentTask(opts: {
  agentId: string
  /** Display name for result texts (registry name or description). */
  label: string
  message: string
  getAppState: () => AppState
  setAppStateForTasks: (f: (prev: AppState) => AppState) => void
  toolUseContext: ToolUseContext
  canUseTool: CanUseToolFn
  invokingRequestId?: string
}): Promise<{ success: boolean; message: string }> {
  const task = opts.getAppState().tasks[opts.agentId]
  if (isLocalAgentTask(task) && !isMainSessionTask(task)) {
    if (task.status === 'running') {
      queuePendingMessage(opts.agentId, opts.message, opts.setAppStateForTasks)
      return {
        success: true,
        message: `Message queued for delivery to ${opts.label} at its next tool round.`,
      }
    }
    // task exists but stopped — auto-resume
    try {
      const result = await resumeAgentBackground({
        agentId: opts.agentId,
        prompt: opts.message,
        toolUseContext: opts.toolUseContext,
        canUseTool: opts.canUseTool,
        invokingRequestId: opts.invokingRequestId,
      })
      return {
        success: true,
        message: `Agent "${opts.label}" was stopped (${task.status}); resumed it in the background with your message. You'll be notified when it finishes. Output: ${result.outputFile}`,
      }
    } catch (e) {
      return {
        success: false,
        message: `Agent "${opts.label}" is stopped (${task.status}) and could not be resumed: ${errorMessage(e)}`,
      }
    }
  }
  // task evicted from state — try resume from disk transcript.
  // agentId is either a registered name or a format-matching raw ID
  // (toAgentId validates the createAgentId format, so unknown names
  // never reach this block).
  try {
    const result = await resumeAgentBackground({
      agentId: opts.agentId,
      prompt: opts.message,
      toolUseContext: opts.toolUseContext,
      canUseTool: opts.canUseTool,
      invokingRequestId: opts.invokingRequestId,
    })
    return {
      success: true,
      message: `Agent "${opts.label}" had no active task; resumed from transcript in the background with your message. You'll be notified when it finishes. Output: ${result.outputFile}`,
    }
  } catch (e) {
    return {
      success: false,
      message: `Agent "${opts.label}" is registered but has no transcript to resume. It may have been cleaned up. (${errorMessage(e)})`,
    }
  }
}
