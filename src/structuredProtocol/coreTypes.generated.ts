/**
 * Schema-derived SDK type aliases.
 *
 * Every symbol below is `z.infer<ReturnType<typeof XSchema>>` of a matching
 * schema in src/structuredProtocol/coreSchemas.ts — this file is a thin TS-only
 * facade so consumers can `import type` without dragging Zod into their
 * bundles. Follows the same pattern as controlTypes.ts.
 */

import type { z } from 'zod/v4'
import type {
  AsyncHookJSONOutputSchema,
  ConfigChangeHookInputSchema,
  CwdChangedHookInputSchema,
  ElicitationHookInputSchema,
  ElicitationResultHookInputSchema,
  ExitReasonSchema,
  FileChangedHookInputSchema,
  HookEventSchema,
  HookInputSchema,
  HookJSONOutputSchema,
  InstructionsLoadedHookInputSchema,
  McpServerConfigForProcessTransportSchema,
  McpServerStatusSchema,
  ModelInfoSchema,
  ModelUsageSchema,
  NotificationHookInputSchema,
  PermissionDeniedHookInputSchema,
  PermissionModeSchema,
  PermissionRequestHookInputSchema,
  PermissionUpdateSchema,
  PostCompactHookInputSchema,
  PostToolUseFailureHookInputSchema,
  PostToolUseHookInputSchema,
  PreCompactHookInputSchema,
  PreToolUseHookInputSchema,
  RewindFilesResultSchema,
  SDKAssistantMessageErrorSchema,
  SDKAssistantMessageSchema,
  SDKCompactBoundaryMessageSchema,
  SDKMessageSchema,
  SDKPartialAssistantMessageSchema,
  SDKPermissionDenialSchema,
  SDKRateLimitInfoSchema,
  SDKResultMessageSchema,
  SDKSessionInfoSchema,
  SDKStatusMessageSchema,
  SDKStatusSchema,
  SDKSystemMessageSchema,
  SDKToolProgressMessageSchema,
  SDKUserMessageReplaySchema,
  SDKUserMessageSchema,
  SessionEndHookInputSchema,
  SessionStartHookInputSchema,
  SetupHookInputSchema,
  StopFailureHookInputSchema,
  StopHookInputSchema,
  SubagentStartHookInputSchema,
  SubagentStopHookInputSchema,
  SyncHookJSONOutputSchema,
  TaskCompletedHookInputSchema,
  TaskCreatedHookInputSchema,
  TeammateIdleHookInputSchema,
  UserPromptSubmitHookInputSchema,
  WorktreeCreateHookInputSchema,
  WorktreeRemoveHookInputSchema,
} from './coreSchemas.js'

// ---------------------------------------------------------------------------
// Primitive enums / shared scalars
// ---------------------------------------------------------------------------

export type PermissionMode = z.infer<ReturnType<typeof PermissionModeSchema>>

export type ExitReason = z.infer<ReturnType<typeof ExitReasonSchema>>

export type HookEvent = z.infer<ReturnType<typeof HookEventSchema>>

export type ModelUsage = z.infer<ReturnType<typeof ModelUsageSchema>>

export type PermissionUpdate = z.infer<
  ReturnType<typeof PermissionUpdateSchema>
>

// SDKAssistantMessageError is the *reason* enum on the wire; it has always
// been a string like 'rate_limit' or 'server_error' despite past types
// modelling it as an envelope. Alias kept for callers that still import
// the old name.
export type SDKAssistantErrorReason = z.infer<
  ReturnType<typeof SDKAssistantMessageErrorSchema>
>
export type SDKAssistantMessageError = SDKAssistantErrorReason

// ---------------------------------------------------------------------------
// SDK message variants
// ---------------------------------------------------------------------------

export type SDKStatus = z.infer<ReturnType<typeof SDKStatusSchema>>

export type SDKRateLimitInfo = z.infer<
  ReturnType<typeof SDKRateLimitInfoSchema>
>

export type SDKAssistantMessage = z.infer<
  ReturnType<typeof SDKAssistantMessageSchema>
>

export type SDKPartialAssistantMessage = z.infer<
  ReturnType<typeof SDKPartialAssistantMessageSchema>
>

export type SDKUserMessage = z.infer<ReturnType<typeof SDKUserMessageSchema>>

export type SDKUserMessageReplay = z.infer<
  ReturnType<typeof SDKUserMessageReplaySchema>
>

export type SDKResultMessage = z.infer<
  ReturnType<typeof SDKResultMessageSchema>
>

export type SDKSystemMessage = z.infer<
  ReturnType<typeof SDKSystemMessageSchema>
>

export type SDKCompactBoundaryMessage = z.infer<
  ReturnType<typeof SDKCompactBoundaryMessageSchema>
>

export type SDKStatusMessage = z.infer<
  ReturnType<typeof SDKStatusMessageSchema>
>

export type SDKToolProgressMessage = z.infer<
  ReturnType<typeof SDKToolProgressMessageSchema>
>

export type SDKPermissionDenial = z.infer<
  ReturnType<typeof SDKPermissionDenialSchema>
>

export type SDKSessionInfo = z.infer<ReturnType<typeof SDKSessionInfoSchema>>

export type SDKMessage = z.infer<ReturnType<typeof SDKMessageSchema>>

// ---------------------------------------------------------------------------
// Hook input variants
// ---------------------------------------------------------------------------

export type PreToolUseHookInput = z.infer<
  ReturnType<typeof PreToolUseHookInputSchema>
>
export type PostToolUseHookInput = z.infer<
  ReturnType<typeof PostToolUseHookInputSchema>
>
export type PostToolUseFailureHookInput = z.infer<
  ReturnType<typeof PostToolUseFailureHookInputSchema>
>
export type PermissionDeniedHookInput = z.infer<
  ReturnType<typeof PermissionDeniedHookInputSchema>
>
export type PermissionRequestHookInput = z.infer<
  ReturnType<typeof PermissionRequestHookInputSchema>
>
export type NotificationHookInput = z.infer<
  ReturnType<typeof NotificationHookInputSchema>
>
export type UserPromptSubmitHookInput = z.infer<
  ReturnType<typeof UserPromptSubmitHookInputSchema>
>
export type SessionStartHookInput = z.infer<
  ReturnType<typeof SessionStartHookInputSchema>
>
export type SessionEndHookInput = z.infer<
  ReturnType<typeof SessionEndHookInputSchema>
>
export type SetupHookInput = z.infer<ReturnType<typeof SetupHookInputSchema>>
export type StopHookInput = z.infer<ReturnType<typeof StopHookInputSchema>>
export type StopFailureHookInput = z.infer<
  ReturnType<typeof StopFailureHookInputSchema>
>
export type SubagentStartHookInput = z.infer<
  ReturnType<typeof SubagentStartHookInputSchema>
>
export type SubagentStopHookInput = z.infer<
  ReturnType<typeof SubagentStopHookInputSchema>
>
export type PreCompactHookInput = z.infer<
  ReturnType<typeof PreCompactHookInputSchema>
>
export type PostCompactHookInput = z.infer<
  ReturnType<typeof PostCompactHookInputSchema>
>
export type TeammateIdleHookInput = z.infer<
  ReturnType<typeof TeammateIdleHookInputSchema>
>
export type TaskCreatedHookInput = z.infer<
  ReturnType<typeof TaskCreatedHookInputSchema>
>
export type TaskCompletedHookInput = z.infer<
  ReturnType<typeof TaskCompletedHookInputSchema>
>
export type ElicitationHookInput = z.infer<
  ReturnType<typeof ElicitationHookInputSchema>
>
export type ElicitationResultHookInput = z.infer<
  ReturnType<typeof ElicitationResultHookInputSchema>
>
export type ConfigChangeHookInput = z.infer<
  ReturnType<typeof ConfigChangeHookInputSchema>
>
export type InstructionsLoadedHookInput = z.infer<
  ReturnType<typeof InstructionsLoadedHookInputSchema>
>
export type WorktreeCreateHookInput = z.infer<
  ReturnType<typeof WorktreeCreateHookInputSchema>
>
export type WorktreeRemoveHookInput = z.infer<
  ReturnType<typeof WorktreeRemoveHookInputSchema>
>
export type CwdChangedHookInput = z.infer<
  ReturnType<typeof CwdChangedHookInputSchema>
>
export type FileChangedHookInput = z.infer<
  ReturnType<typeof FileChangedHookInputSchema>
>

export type HookInput = z.infer<ReturnType<typeof HookInputSchema>>

// ---------------------------------------------------------------------------
// Hook output
// ---------------------------------------------------------------------------

export type HookJSONOutput = z.infer<ReturnType<typeof HookJSONOutputSchema>>
export type SyncHookJSONOutput = z.infer<
  ReturnType<typeof SyncHookJSONOutputSchema>
>
export type AsyncHookJSONOutput = z.infer<
  ReturnType<typeof AsyncHookJSONOutputSchema>
>

// ---------------------------------------------------------------------------
// Permission + MCP
// ---------------------------------------------------------------------------

export type PermissionResult =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; message?: string }
  | {
      behavior: 'ask'
      updatedInput?: Record<string, unknown>
      message?: string
    }

export type ModelInfo = z.infer<ReturnType<typeof ModelInfoSchema>>
export type McpServerConfigForProcessTransport = z.infer<
  ReturnType<typeof McpServerConfigForProcessTransportSchema>
>
export type McpServerStatus = z.infer<ReturnType<typeof McpServerStatusSchema>>
export type RewindFilesResult = z.infer<
  ReturnType<typeof RewindFilesResultSchema>
>

// ---------------------------------------------------------------------------
// Legacy shapes retained for type-only consumers that hit `[key: string]`
// escape hatches. Runtime validation uses the Zod schemas above.
// ---------------------------------------------------------------------------

export type SDKBaseMessage = {
  type: string
  subtype?: string
  uuid?: string
  session_id?: string
  [key: string]: unknown
}
