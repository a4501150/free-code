/**
 * Internal REPL message union and its constituent variants. These types
 * are broader than — and distinct from — the SDK's wire-format messages:
 * they carry UI-only state (progress events, tombstones, synthetic
 * attachments, collapsed groups) that never leaves the process.
 *
 * Shapes were reconstructed from every construction site in
 * src/utils/messages.ts, src/utils/attachments.ts, src/query.ts,
 * src/QueryEngine.ts, src/remote/sdkMessageAdapter.ts and their
 * consumers. Keep them in sync with those files.
 */

import type {
  BetaContentBlock,
  BetaMessage,
  BetaRawMessageStreamEvent,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import type { APIError } from '@anthropic-ai/sdk'
import type { SDKAssistantErrorReason } from '../entrypoints/agentSdkTypes.js'
import type { Attachment } from '../utils/attachments.js'
import type { ToolProgressData } from './tools.js'
import type { PermissionMode } from './permissions.js'
import type { QueueOperation, QueueOperationMessage } from './messageQueueTypes.js'
import type { HookProgress } from './hooks.js'
import type { UUID } from 'crypto'

// Re-export so downstream imports of these symbols from types/message.js
// resolve transparently (many files import QueueOperation{,Message} through
// types/message rather than types/messageQueueTypes).
export type { QueueOperation, QueueOperationMessage }

// ---------------------------------------------------------------------------
// Level + origin

/** Severity of a SystemMessage — drives color/dim rendering. */
export type SystemMessageLevel = 'info' | 'warning' | 'error'

/**
 * Provenance of a user-visible message that was not typed by the human.
 * Human-typed input has no origin.
 */
export type MessageOrigin =
  | { kind: 'task-notification' }
  | { kind: 'coordinator' }
  | { kind: 'channel'; server: string }
  | { kind: 'proactive' }
  | { kind: 'scheduled_task'; taskId?: string }
  | { kind: 'plan_verification' }
  | { kind: 'sdk' }

// ---------------------------------------------------------------------------
// Compact metadata

/** Which side of the timeline a partial compact covers. */
export type PartialCompactDirection = 'from' | 'up_to'

/** Serialized compact metadata attached to SystemCompactBoundaryMessage. */
export type CompactMetadata = {
  trigger: 'manual' | 'auto'
  preTokens: number
  userContext?: string
  messagesSummarized?: number
  direction?: PartialCompactDirection
  preservedSegment?: {
    headUuid: UUID
    anchorUuid: UUID
    tailUuid: UUID
  }
  preCompactDiscoveredTools?: string[]
}

/** Info about a single stop hook invocation, aggregated into the summary. */
export type StopHookInfo = {
  command: string
  promptText?: string
  durationMs?: number
}

// ---------------------------------------------------------------------------
// Core message variants

/**
 * An assistant turn wrapping the SDK's `BetaMessage`. API-error assistant
 * messages reuse the same shape with `isApiErrorMessage: true` and the
 * synthetic-model marker.
 */
export type AssistantMessage = {
  type: 'assistant'
  uuid: UUID
  timestamp: string
  message: BetaMessage
  requestId?: string | undefined
  isMeta?: boolean
  isVirtual?: true
  isApiErrorMessage?: boolean
  apiError?: {
    status?: number
    message?: string
    [key: string]: unknown
  }
  error?: SDKAssistantErrorReason
  errorDetails?: string
  advisorModel?: string
  isSidechain?: boolean
  agentId?: string
  caller?: string
  [extraField: string]: unknown
}

/** A user turn — either human input or a synthetic placeholder. */
export type UserMessage = {
  type: 'user'
  uuid: UUID
  timestamp: string
  message: {
    role: 'user'
    content: string | ContentBlockParam[]
  }
  isMeta?: true | boolean
  isVisibleInTranscriptOnly?: true | boolean
  isVirtual?: true | boolean
  isCompactSummary?: true | boolean
  summarizeMetadata?: {
    messagesSummarized: number
    userContext?: string
    direction?: PartialCompactDirection
  }
  toolUseResult?: unknown
  mcpMeta?: {
    _meta?: Record<string, unknown>
    structuredContent?: Record<string, unknown>
  }
  imagePasteIds?: number[]
  sourceToolUseID?: string
  sourceToolAssistantUUID?: UUID
  permissionMode?: PermissionMode
  origin?: MessageOrigin
  isSidechain?: boolean
  agentId?: string
  [extraField: string]: unknown
}

/** An attachment message — injected data (files, hook context, etc.). */
export type AttachmentMessage<A extends Attachment = Attachment> = {
  type: 'attachment'
  uuid: UUID
  timestamp: string
  attachment: A
}

// ---------------------------------------------------------------------------
// System-message variants. All share the same header shape and differ by
// `subtype`. Construction sites live in src/utils/messages.ts.

type SystemBase = {
  type: 'system'
  uuid: UUID
  timestamp: string
  isMeta?: boolean
  toolUseID?: string
  level?: SystemMessageLevel
  preventContinuation?: boolean
  logicalParentUuid?: UUID
  /**
   * Populated by most subtypes; absent on `api_metrics`, `file_snapshot`,
   * `agents_killed`, `turn_duration`, `memory_saved`, `stop_hook_summary`,
   * `api_error`. Kept optional at the base so downstream code can read
   * `message.content` generically and null-check.
   */
  content?: string
}

export type SystemInformationalMessage = SystemBase & {
  subtype: 'informational'
  content: string
  level: SystemMessageLevel
}

export type SystemPermissionRetryMessage = SystemBase & {
  subtype: 'permission_retry'
  content: string
  commands: string[]
  level: 'info'
}

export type SystemScheduledTaskFireMessage = SystemBase & {
  subtype: 'scheduled_task_fire'
  content: string
}

export type SystemStopHookSummaryMessage = SystemBase & {
  subtype: 'stop_hook_summary'
  hookCount: number
  hookInfos: StopHookInfo[]
  hookErrors: string[]
  preventedContinuation: boolean
  stopReason?: string
  hasOutput: boolean
  level: SystemMessageLevel
  hookLabel?: string
  totalDurationMs?: number
}

export type SystemTurnDurationMessage = SystemBase & {
  subtype: 'turn_duration'
  durationMs: number
  budgetTokens?: number
  budgetLimit?: number
  budgetNudges?: number
  messageCount?: number
}

export type SystemAwaySummaryMessage = SystemBase & {
  subtype: 'away_summary'
  content: string
}

export type SystemMemorySavedMessage = SystemBase & {
  subtype: 'memory_saved'
  writtenPaths: string[]
  verb?: string
  teamCount?: number
}

export type SystemAgentsKilledMessage = SystemBase & {
  subtype: 'agents_killed'
}

export type SystemApiMetricsMessage = SystemBase & {
  subtype: 'api_metrics'
  ttftMs: number
  otps: number
  isP50?: boolean
  hookDurationMs?: number
  turnDurationMs?: number
  toolDurationMs?: number
  classifierDurationMs?: number
  toolCount?: number
  hookCount?: number
  classifierCount?: number
  configWriteCount?: number
}

export type SystemLocalCommandMessage = SystemBase & {
  subtype: 'local_command'
  content: string
  level: 'info'
}

export type SystemCompactBoundaryMessage = SystemBase & {
  subtype: 'compact_boundary'
  content: string
  level: 'info'
  compactMetadata: CompactMetadata
}

export type SystemMicrocompactBoundaryMessage = SystemBase & {
  subtype: 'microcompact_boundary'
  content: string
  level: 'info'
  microcompactMetadata: {
    trigger: 'auto'
    preTokens: number
    tokensSaved: number
    compactedToolIds: string[]
    clearedAttachmentUUIDs: string[]
  }
}

export type SystemAPIErrorMessage = SystemBase & {
  subtype: 'api_error'
  level: 'error'
  error: APIError
  cause?: Error
  retryInMs: number
  retryAttempt: number
  maxRetries: number
}

export type SystemFileSnapshotMessage = SystemBase & {
  subtype: 'file_snapshot'
  snapshotPath?: string
  paths?: string[]
  snapshotFiles?: Array<{ key: string; path?: string; content: string }>
}

export type SystemThinkingMessage = SystemBase & {
  subtype: 'thinking'
  content: string
}

/** Discriminated union of every SystemMessage variant. */
export type SystemMessage =
  | SystemInformationalMessage
  | SystemPermissionRetryMessage
  | SystemScheduledTaskFireMessage
  | SystemStopHookSummaryMessage
  | SystemTurnDurationMessage
  | SystemAwaySummaryMessage
  | SystemMemorySavedMessage
  | SystemAgentsKilledMessage
  | SystemApiMetricsMessage
  | SystemLocalCommandMessage
  | SystemCompactBoundaryMessage
  | SystemMicrocompactBoundaryMessage
  | SystemAPIErrorMessage
  | SystemFileSnapshotMessage
  | SystemThinkingMessage

// ---------------------------------------------------------------------------
// Progress, tombstones, tool-use summaries, hook results

/**
 * An intermediate progress event emitted while a tool is running.
 * Generic over the payload so each tool can narrow `data`.
 */
export type ProgressMessage<P = ToolProgressData | HookProgress> = {
  type: 'progress'
  uuid: UUID
  timestamp: string
  toolUseID: string
  parentToolUseID?: string
  data: P
}

/**
 * Tombstone for an assistant partial that must NOT be re-sent to the
 * model (e.g. aborted thinking blocks with invalid signatures).
 */
export type TombstoneMessage = {
  type: 'tombstone'
  message: AssistantMessage
}

/** Summary emitted to SDK consumers after a batch of tool uses completes. */
export type ToolUseSummaryMessage = {
  type: 'tool_use_summary'
  uuid: UUID
  timestamp: string
  summary: string
  precedingToolUseIds: string[]
}

/**
 * Message returned by an executed hook callback — can surface as a
 * system message, attachment, or user turn depending on the hook.
 */
export type HookResultMessage =
  | AttachmentMessage
  | ProgressMessage
  | SystemMessage
  | UserMessage

// ---------------------------------------------------------------------------
// Streaming / request lifecycle events yielded by the query generator

export type StreamEvent = {
  type: 'stream_event'
  event: BetaRawMessageStreamEvent
  /** Time-to-first-token (ms) populated on message_start events. */
  ttftMs?: number
}

export type RequestStartEvent = {
  type: 'stream_request_start'
}

// ---------------------------------------------------------------------------
// Master Message union
//
// This is the REPL's canonical in-memory message representation — everything
// the UI renders or the query loop produces is one of these.

export type Message =
  | UserMessage
  | AssistantMessage
  | AttachmentMessage
  | SystemMessage
  | ProgressMessage

// ---------------------------------------------------------------------------
// Normalized messages — user/assistant messages split so every message
// carries exactly one content block. Other Message subtypes pass through
// unchanged (see normalizeMessages in src/utils/messages.ts).

export type NormalizedAssistantMessage = AssistantMessage & {
  message: BetaMessage & { content: [BetaContentBlock] }
}

export type NormalizedUserMessage = UserMessage & {
  message: {
    role: 'user'
    content: [ContentBlockParam]
  }
}

export type NormalizedMessage =
  | NormalizedUserMessage
  | NormalizedAssistantMessage
  | AttachmentMessage
  | SystemMessage
  | ProgressMessage

// ---------------------------------------------------------------------------
// Grouped / collapsed UI-only messages

/**
 * Several consecutive tool uses of the same tool collapsed into one
 * renderable row.
 */
export type GroupedToolUseMessage = {
  type: 'grouped_tool_use'
  toolName: string
  /** All original tool_use normalized messages in display order. */
  messages: NormalizedAssistantMessage[]
  /** Matching tool_result messages (subset by id). */
  results: NormalizedUserMessage[]
  /** Representative row (first message in the group) used for rendering. */
  displayMessage: NormalizedAssistantMessage
  uuid: string
  timestamp: string
  messageId: string
}

/**
 * A run of consecutive Read/Search operations collapsed into a single
 * summary row. See src/utils/collapseReadSearch.ts for constructor.
 */
export type CollapsedReadSearchGroup = {
  type: 'collapsed_read_search'
  searchCount: number
  readCount: number
  listCount: number
  replCount: number
  memorySearchCount: number
  memoryReadCount: number
  memoryWriteCount: number
  readFilePaths: string[]
  searchArgs: string[]
  latestDisplayHint?: string
  messages: NormalizedMessage[]
  displayMessage: NormalizedMessage
  uuid: UUID
  timestamp: string
  teamMemorySearchCount?: number
  teamMemoryReadCount?: number
  teamMemoryWriteCount?: number
  mcpCallCount?: number
  mcpServerNames?: string[]
  bashCount?: number
  gitOpBashCount?: number
  commits?: { sha: string; kind: string }[]
  pushes?: { branch: string }[]
  branches?: { ref: string; action: string }[]
  prs?: { number: number; url?: string; action: string }[]
  hookTotalMs?: number
  hookCount?: number
  hookInfos?: StopHookInfo[]
  relevantMemories?: { path: string; content: string; mtimeMs: number }[]
}

/**
 * The subset of messages that the collapse pass considers candidates for
 * grouping. A superset of what the UI actually collapses.
 */
export type CollapsibleMessage =
  | NormalizedAssistantMessage
  | NormalizedUserMessage
  | GroupedToolUseMessage

/**
 * Everything renderable in the message list after grouping + collapse
 * passes have run.
 */
export type RenderableMessage =
  | NormalizedMessage
  | GroupedToolUseMessage
  | CollapsedReadSearchGroup
