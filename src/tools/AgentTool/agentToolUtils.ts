import { clearInvokedSkillsForAgent } from '../../bootstrap/state.js'
import {
  ALL_AGENT_DISALLOWED_TOOLS,
  ASYNC_AGENT_ALLOWED_TOOLS,
  CUSTOM_AGENT_DISALLOWED_TOOLS,
} from '../../constants/tools.js'
import { startAgentSummarization } from '../../services/AgentSummary/agentSummary.js'
import { clearDumpState } from '../../services/api/dumpPrompts.js'
import type { AppState } from '../../state/AppStateStore.js'
import type {
  Tool,
  ToolPermissionContext,
  Tools,
  ToolUseContext,
} from '../../Tool.js'
import { toolMatchesName } from '../../Tool.js'
import {
  appendRetainedAgentMessage,
  completeAgentTask as completeAsyncAgent,
  createActivityDescriptionResolver,
  createProgressTracker,
  enqueueAgentNotification,
  failAgentTask as failAsyncAgent,
  getProgressUpdate,
  getTokenCountFromTracker,
  killAsyncAgent,
  type ProgressTracker,
  updateAgentProgress as updateAsyncAgentProgress,
  updateProgressFromMessage,
  updateProgressFromUsage,
} from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { asAgentId } from '../../types/ids.js'
import type {
  AssistantMessage,
  Message as MessageType,
  StreamEvent,
} from '../../types/message.js'
import { logForDebugging } from '../../utils/debug.js'
import { AbortError, errorMessage } from '../../utils/errors.js'
import type { CacheSafeParams } from '../../utils/forkedAgent.js'
import {
  extractTextContent,
  getLastAssistantMessage,
} from '../../utils/messages.js'
import type { PermissionMode } from '../../utils/permissions/PermissionMode.js'
import { permissionRuleValueFromString } from '../../utils/permissions/permissionRuleParser.js'
import {
  buildTranscriptForClassifier,
  classifyYoloAction,
} from '../../utils/permissions/yoloClassifier.js'
import { emitTaskProgress as emitTaskProgressEvent } from '../../utils/task/structuredProgress.js'
import { getTokenCountFromUsage } from '../../utils/tokens.js'
import { EXIT_PLAN_MODE_TOOL_NAME } from '../ExitPlanModeTool/constants.js'
import {
  END_TURN_REMINDER,
  isEndTurnToolUse,
} from '../EndTurnTool/constants.js'
import { AGENT_TOOL_NAME, LEGACY_AGENT_TOOL_NAME } from './constants.js'
import type { AgentDefinition } from './loadAgentsDir.js'
export type ResolvedAgentTools = {
  hasWildcard: boolean
  validTools: string[]
  invalidTools: string[]
  resolvedTools: Tools
  allowedAgentTypes?: string[]
}

export function filterToolsForAgent({
  tools,
  isBuiltIn,
  isAsync = false,
  permissionMode,
}: {
  tools: Tools
  isBuiltIn: boolean
  isAsync?: boolean
  permissionMode?: PermissionMode
}): Tools {
  return tools.filter(tool => {
    // Allow MCP tools for all agents
    if (tool.name.startsWith('mcp__')) {
      return true
    }
    // Allow ExitPlanMode for agents in plan mode
    // This bypasses both the ALL_AGENT_DISALLOWED_TOOLS and async tool filters
    if (
      toolMatchesName(tool, EXIT_PLAN_MODE_TOOL_NAME) &&
      permissionMode === 'plan'
    ) {
      return true
    }
    if (ALL_AGENT_DISALLOWED_TOOLS.has(tool.name)) {
      return false
    }
    if (!isBuiltIn && CUSTOM_AGENT_DISALLOWED_TOOLS.has(tool.name)) {
      return false
    }
    if (isAsync && !ASYNC_AGENT_ALLOWED_TOOLS.has(tool.name)) {
      return false
    }
    return true
  })
}

/**
 * Resolves and validates agent tools against available tools
 * Handles wildcard expansion and validation in one place
 */
export function resolveAgentTools(
  agentDefinition: Pick<
    AgentDefinition,
    'tools' | 'disallowedTools' | 'source' | 'permissionMode'
  >,
  availableTools: Tools,
  isAsync = false,
  isMainThread = false,
): ResolvedAgentTools {
  const {
    tools: agentTools,
    disallowedTools,
    source,
    permissionMode,
  } = agentDefinition
  // When isMainThread is true, skip filterToolsForAgent entirely — the main
  // thread's tool pool is already properly assembled by useMergedTools(), so
  // the sub-agent disallow lists shouldn't apply.
  const filteredAvailableTools = isMainThread
    ? availableTools
    : filterToolsForAgent({
        tools: availableTools,
        isBuiltIn: source === 'built-in',
        isAsync,
        permissionMode,
      })

  // Create a set of disallowed tool names for quick lookup
  const disallowedToolSet = new Set(
    disallowedTools?.map(toolSpec => {
      const { toolName } = permissionRuleValueFromString(toolSpec)
      return toolName
    }) ?? [],
  )

  // Filter available tools based on disallowed list
  const allowedAvailableTools = filteredAvailableTools.filter(
    tool => !disallowedToolSet.has(tool.name),
  )

  // If tools is undefined or ['*'], allow all tools (after filtering disallowed)
  const hasWildcard =
    agentTools === undefined ||
    (agentTools.length === 1 && agentTools[0] === '*')
  if (hasWildcard) {
    return {
      hasWildcard: true,
      validTools: [],
      invalidTools: [],
      resolvedTools: allowedAvailableTools,
    }
  }

  const availableToolMap = new Map<string, Tool>()
  for (const tool of allowedAvailableTools) {
    availableToolMap.set(tool.name, tool)
  }

  const validTools: string[] = []
  const invalidTools: string[] = []
  const resolved: Tool[] = []
  const resolvedToolsSet = new Set<Tool>()
  let allowedAgentTypes: string[] | undefined

  for (const toolSpec of agentTools) {
    // Parse the tool spec to extract the base tool name and any permission pattern
    const { toolName, ruleContent } = permissionRuleValueFromString(toolSpec)

    // Special case: Agent tool carries allowedAgentTypes metadata in its spec
    if (toolName === AGENT_TOOL_NAME) {
      if (ruleContent) {
        // Parse comma-separated agent types: "worker, researcher" → ["worker", "researcher"]
        allowedAgentTypes = ruleContent.split(',').map(s => s.trim())
      }
      // For sub-agents, Agent is excluded by filterToolsForAgent — mark the spec
      // valid for allowedAgentTypes tracking but skip tool resolution.
      if (!isMainThread) {
        validTools.push(toolSpec)
        continue
      }
      // For main thread, filtering was skipped so Agent is in availableToolMap —
      // fall through to normal resolution below.
    }

    const tool = availableToolMap.get(toolName)
    if (tool) {
      validTools.push(toolSpec)
      if (!resolvedToolsSet.has(tool)) {
        resolved.push(tool)
        resolvedToolsSet.add(tool)
      }
    } else {
      invalidTools.push(toolSpec)
    }
  }

  return {
    hasWildcard: false,
    validTools,
    invalidTools,
    resolvedTools: resolved,
    allowedAgentTypes,
  }
}

import type { AgentToolResult } from './agentToolSchemas.js'
import { withAgentStoppedStatus } from './agentToolResult.js'
export {
  agentToolResultSchema,
  type AgentToolResult,
} from './agentToolSchemas.js'

export function countToolUses(messages: MessageType[]): number {
  let count = 0
  for (const m of messages) {
    if (m.type === 'assistant') {
      for (const block of m.message.content) {
        // EndTurn is the completion protocol, not a tool call — counting it
        // would report one extra tool use to the parent (<usage> trailer,
        // "Done (N tool uses)") for every strict-end_turn run.
        if (block.type === 'tool_use' && !isEndTurnToolUse(block)) {
          count++
        }
      }
    }
  }
  return count
}

/**
 * Text of a user message, whichever content shape it stores (string or
 * blocks). Used to recognize the harness's end-turn nudge in a run.
 */
function userMessageText(m: MessageType): string | undefined {
  if (m.type !== 'user') return undefined
  const content = m.message.content
  if (typeof content === 'string') return content
  const block = content[0]
  return block?.type === 'text' ? block.text : undefined
}

/**
 * Index of the last end-turn nudge (the exact END_TURN_REMINDER meta user
 * message) in the run, or -1. The owned-tasks reminder shares the wrapper
 * tag but not the exact text and must not match: a reply to it is a
 * genuine choice to keep waiting, not protocol noise.
 */
function lastEndReminderIndex(messages: MessageType[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (
      m.type === 'user' &&
      m.isMeta === true &&
      userMessageText(m) === END_TURN_REMINDER
    ) {
      return i
    }
  }
  return -1
}

/**
 * Whether any real (non-EndTurn) tool use happened after index `from` —
 * the difference between a post-nudge ack and a genuine new report.
 */
function hasRealWorkAfter(messages: MessageType[], from: number): boolean {
  for (let i = from + 1; i < messages.length; i++) {
    const m = messages[i]!
    if (m.type !== 'assistant') continue
    for (const block of m.message.content) {
      if (block.type === 'tool_use' && !isEndTurnToolUse(block)) return true
    }
  }
  return false
}

/**
 * Search bound for the result text: the last end-turn nudge when the run
 * ended in a nudge reply with no real work after it — the post-nudge text
 * is then an ack or a restatement, protocol noise rather than the result —
 * else the end of the run (last text wins).
 */
function resultSearchBound(messages: MessageType[]): number {
  const reminderIdx = lastEndReminderIndex(messages)
  if (reminderIdx >= 0 && !hasRealWorkAfter(messages, reminderIdx)) {
    return reminderIdx
  }
  return messages.length
}

/**
 * The agent's result text blocks: the last assistant text before the
 * search bound, walking back past pure-tool_use messages. When the bound
 * is a nudge and no text exists before it, the post-nudge text still
 * reports something rather than nothing.
 */
function selectResultTextBlocks(
  messages: MessageType[],
): Array<{ type: 'text'; text: string }> {
  const bound = resultSearchBound(messages)
  const blocks = lastTextBlocksBefore(messages, bound)
  if (blocks !== undefined) return blocks
  if (bound < messages.length) {
    return lastTextBlocksBefore(messages, messages.length) ?? []
  }
  return []
}

function lastTextBlocksBefore(
  messages: MessageType[],
  bound: number,
): Array<{ type: 'text'; text: string }> | undefined {
  for (let i = bound - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.type !== 'assistant') continue
    const textBlocks = m.message.content.filter(_ => _.type === 'text')
    if (textBlocks.length > 0) {
      return textBlocks as Array<{ type: 'text'; text: string }>
    }
  }
  return undefined
}

export function finalizeAgentTool(
  agentMessages: MessageType[],
  agentId: string,
  metadata: {
    prompt: string
    resolvedAgentModel: string
    isBuiltInAgent: boolean
    startTime: number
    agentType: string
    isAsync: boolean
  },
  tracker: ProgressTracker,
): AgentToolResult {
  const {
    prompt,
    resolvedAgentModel,
    isBuiltInAgent,
    startTime,
    agentType,
    isAsync,
  } = metadata

  const lastAssistantMessage = getLastAssistantMessage(agentMessages)
  if (lastAssistantMessage === undefined) {
    throw new Error('No assistant messages found')
  }
  // Extract text content from the agent's response: the last assistant
  // text, walking back past pure-tool_use tails (loop exited mid-turn, or
  // an EndTurn-only final message) and past post-nudge ack text (see
  // selectResultTextBlocks).
  const content = selectResultTextBlocks(agentMessages)

  // Use the tracker's cumulative counts rather than the last assistant
  // message's `usage`. For long-running subagents this reports the true
  // total tokens spent across all turns, not just the final turn. Synthetic
  // error tails (e.g. max_output_tokens) carry zeroed usage that would
  // otherwise make the tool report "0 tokens" for a full run.
  const totalTokens = getTokenCountFromTracker(tracker)
  const totalToolUseCount = countToolUses(agentMessages)

  // Detect a truthful stop reason from either a synthetic API-error tail
  // OR the real assistant message's `stop_reason`. The harness no longer
  // injects a synthetic error for max_tokens / model_context_window_exceeded
  // (see Issue 1) — those stop reasons now flow through on the real
  // assistant turn and must be mapped directly. The parent tool_result and
  // UI use this to render "Stopped: ..." instead of "Done". Also walk back
  // past any synthetic tail to pick up the real last turn's usage payload.
  const stopReason = lastAssistantMessage.message.stop_reason
  const errorReason = lastAssistantMessage.isApiErrorMessage
    ? (lastAssistantMessage.error ?? 'unknown')
    : stopReason === 'max_tokens'
      ? 'max_output_tokens'
      : stopReason === 'model_context_window_exceeded'
        ? 'context_window_exceeded'
        : undefined
  let usageSource: AssistantMessage = lastAssistantMessage
  if (lastAssistantMessage.isApiErrorMessage) {
    const realLast = agentMessages.findLast(
      (m): m is AssistantMessage =>
        m.type === 'assistant' && !m.isApiErrorMessage,
    )
    if (realLast) usageSource = realLast
  }

  // Signal to inference that this subagent's cache chain can be evicted.
  const lastRequestId = lastAssistantMessage.requestId

  return {
    agentId,
    agentType,
    content,
    totalDurationMs: Date.now() - startTime,
    totalTokens,
    totalToolUseCount,
    errorReason,
    usage: usageSource.message.usage as any,
  }
}

/**
 * Returns the name of the last tool_use block in an assistant message,
 * or undefined if the message is not an assistant message with tool_use.
 */
export function getLastToolUseName(message: MessageType): string | undefined {
  if (message.type !== 'assistant') return undefined
  const block = message.message.content.findLast(b => b.type === 'tool_use')
  return block?.type === 'tool_use' ? block.name : undefined
}

export function emitTaskProgress(
  tracker: ProgressTracker,
  taskId: string,
  toolUseId: string | undefined,
  description: string,
  startTime: number,
  lastToolName: string | undefined,
): void {
  const progress = getProgressUpdate(tracker)
  emitTaskProgressEvent({
    taskId,
    toolUseId,
    description: progress.lastActivity?.activityDescription ?? description,
    startTime,
    totalTokens: progress.tokenCount,
    toolUses: progress.toolUseCount,
    lastToolName,
  })
}

export async function classifyHandoffIfNeeded({
  agentMessages,
  tools,
  toolPermissionContext,
  abortSignal,
  subagentType,
  totalToolUseCount,
}: {
  agentMessages: MessageType[]
  tools: Tools
  toolPermissionContext: AppState['toolPermissionContext']
  abortSignal: AbortSignal
  subagentType: string
  totalToolUseCount: number
}): Promise<string | null> {
  if (toolPermissionContext.mode !== 'auto') return null

  const agentTranscript = buildTranscriptForClassifier(agentMessages, tools)
  if (!agentTranscript) return null

  const classifierResult = await classifyYoloAction(
    agentMessages,
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: "Sub-agent has finished and is handing back control to the main agent. Review the sub-agent's work based on the block rules and let the main agent know if any file is dangerous (the main agent will see the reason).",
        },
      ],
    },
    tools,
    toolPermissionContext as ToolPermissionContext,
    abortSignal,
  )

  const handoffDecision = classifierResult.unavailable
    ? 'unavailable'
    : classifierResult.shouldBlock
      ? 'blocked'
      : 'allowed'

  if (classifierResult.shouldBlock) {
    // When classifier is unavailable, still propagate the sub-agent's
    // results but with a warning so the parent agent can verify the work.
    if (classifierResult.unavailable) {
      logForDebugging(
        'Handoff classifier unavailable, allowing sub-agent output with warning',
        { level: 'warn' },
      )
      return `Note: The safety classifier was unavailable when reviewing this sub-agent's work. Please carefully verify the sub-agent's actions and output before acting on them.`
    }

    logForDebugging(
      `Handoff classifier flagged sub-agent output: ${classifierResult.reason}`,
      { level: 'warn' },
    )
    return `SECURITY WARNING: This sub-agent performed actions that may violate security policy. Reason: ${classifierResult.reason}. Review the sub-agent's actions carefully before acting on its output.`
  }

  return null
}

/**
 * Extract a partial result string from an agent's accumulated messages.
 * Used when an async agent is killed to preserve what it accomplished.
 * Applies the same post-nudge skip as selectResultTextBlocks: text acked in
 * reply to the end-turn nudge (with no real work after it) is protocol
 * noise, and the partial result is the report from before the nudge.
 * Returns undefined if no text content is found.
 */
export function extractPartialResult(
  messages: MessageType[],
): string | undefined {
  const bound = resultSearchBound(messages)
  const text = lastTextBefore(messages, bound)
  if (text !== undefined) return text
  if (bound < messages.length) {
    return lastTextBefore(messages, messages.length)
  }
  return undefined
}

function lastTextBefore(
  messages: MessageType[],
  bound: number,
): string | undefined {
  for (let i = bound - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.type !== 'assistant') continue
    const text = extractTextContent(m.message.content, '\n')
    if (text) return text
  }
  return undefined
}

type SetAppState = (f: (prev: AppState) => AppState) => void

/**
 * Drives a background agent from spawn to terminal notification.
 * Shared between AgentTool's async-from-start path and resumeAgentBackground.
 */
export async function runAsyncAgentLifecycle({
  taskId,
  abortController,
  makeStream,
  metadata,
  description,
  toolUseContext,
  rootSetAppState,
  agentIdForCleanup,
  enableSummarization,
  getWorktreeResult,
}: {
  taskId: string
  abortController: AbortController
  makeStream: (
    onCacheSafeParams: ((p: CacheSafeParams) => void) | undefined,
  ) => AsyncGenerator<MessageType | StreamEvent, void>
  metadata: Parameters<typeof finalizeAgentTool>[2]
  description: string
  toolUseContext: ToolUseContext
  rootSetAppState: SetAppState
  agentIdForCleanup: string
  enableSummarization: boolean
  getWorktreeResult: () => Promise<{
    worktreePath?: string
    worktreeBranch?: string
  }>
}): Promise<void> {
  let stopSummarization: (() => void) | undefined
  const agentMessages: MessageType[] = []
  try {
    const tracker = createProgressTracker()
    const resolveActivity = createActivityDescriptionResolver(
      toolUseContext.options.tools,
    )
    const onCacheSafeParams = enableSummarization
      ? (params: CacheSafeParams) => {
          const { stop } = startAgentSummarization(
            taskId,
            asAgentId(taskId),
            params,
            rootSetAppState,
          )
          stopSummarization = stop
        }
      : undefined
    for await (const value of makeStream(onCacheSafeParams)) {
      // Forward final usage from non-Anthropic providers' message_delta
      // stream events to the tracker. Don't record to transcript or count
      // tool uses (claude.ts mutates the assistant message's usage in place,
      // so transcript reflects the final value at finalize time).
      if (
        'type' in value &&
        value.type === 'stream_event' &&
        'event' in value &&
        value.event?.type === 'message_delta' &&
        value.event.usage
      ) {
        updateProgressFromUsage(tracker, value.event.usage)
        updateAsyncAgentProgress(
          taskId,
          getProgressUpdate(tracker),
          rootSetAppState,
        )
        emitTaskProgress(
          tracker,
          taskId,
          toolUseContext.toolUseId,
          description,
          metadata.startTime,
          undefined,
        )
        continue
      }

      const message = value as MessageType
      agentMessages.push(message)
      appendRetainedAgentMessage(taskId, message, rootSetAppState)
      updateProgressFromMessage(
        tracker,
        message,
        resolveActivity,
        toolUseContext.options.tools,
      )
      updateAsyncAgentProgress(
        taskId,
        getProgressUpdate(tracker),
        rootSetAppState,
      )
      const lastToolName = getLastToolUseName(message)
      if (lastToolName) {
        emitTaskProgress(
          tracker,
          taskId,
          toolUseContext.toolUseId,
          description,
          metadata.startTime,
          lastToolName,
        )
      }
    }

    stopSummarization?.()

    const agentResult = finalizeAgentTool(
      agentMessages,
      taskId,
      metadata,
      tracker,
    )

    // Mark task completed FIRST so TaskOutput(block=true) unblocks
    // immediately. classifyHandoffIfNeeded (API call) and getWorktreeResult
    // (git exec) are notification embellishments that can hang — they must
    // not gate the status transition (gh-20236).
    completeAsyncAgent(agentResult, rootSetAppState)

    let finalMessage = extractTextContent(
      withAgentStoppedStatus(agentResult),
      '\n',
    )

    const handoffWarning = await classifyHandoffIfNeeded({
      agentMessages,
      tools: toolUseContext.options.tools,
      toolPermissionContext: toolUseContext.getAppState().toolPermissionContext,
      abortSignal: abortController.signal,
      subagentType: metadata.agentType,
      totalToolUseCount: agentResult.totalToolUseCount,
    })
    if (handoffWarning) {
      finalMessage = `${handoffWarning}\n\n${finalMessage}`
    }

    const worktreeResult = await getWorktreeResult()

    enqueueAgentNotification({
      taskId,
      description,
      status: 'completed',
      setAppState: rootSetAppState,
      finalMessage,
      usage: {
        totalTokens: getTokenCountFromTracker(tracker),
        toolUses: agentResult.totalToolUseCount,
        durationMs: agentResult.totalDurationMs,
      },
      toolUseId: toolUseContext.toolUseId,
      ...worktreeResult,
    })
  } catch (error) {
    stopSummarization?.()
    if (error instanceof AbortError) {
      // killAsyncAgent is a no-op if BackgroundTaskStop already set status='killed' —
      // but only this catch handler has agentMessages, so the notification
      // must fire unconditionally. Transition status BEFORE worktree cleanup
      // so TaskOutput unblocks even if git hangs (gh-20236).
      killAsyncAgent(taskId, rootSetAppState)
      const worktreeResult = await getWorktreeResult()
      const partialResult = extractPartialResult(agentMessages)
      enqueueAgentNotification({
        taskId,
        description,
        status: 'killed',
        setAppState: rootSetAppState,
        toolUseId: toolUseContext.toolUseId,
        finalMessage: partialResult,
        ...worktreeResult,
      })
      return
    }
    const msg = errorMessage(error)
    failAsyncAgent(taskId, msg, rootSetAppState)
    const worktreeResult = await getWorktreeResult()
    enqueueAgentNotification({
      taskId,
      description,
      status: 'failed',
      error: msg,
      setAppState: rootSetAppState,
      toolUseId: toolUseContext.toolUseId,
      ...worktreeResult,
    })
  } finally {
    clearInvokedSkillsForAgent(agentIdForCleanup)
    clearDumpState(agentIdForCleanup)
  }
}
