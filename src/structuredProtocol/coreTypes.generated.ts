/**
 * Schema-derived SDK type aliases.
 *
 * Every symbol below is `z.infer<typeof XSchema>` of a matching
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

export type PermissionMode = z.infer<typeof PermissionModeSchema>

export type ExitReason = z.infer<typeof ExitReasonSchema>

export type HookEvent = z.infer<typeof HookEventSchema>

export type ModelUsage = z.infer<typeof ModelUsageSchema>

export type PermissionUpdate = z.infer<typeof PermissionUpdateSchema>

// SDKAssistantMessageError is the *reason* enum on the wire; it has always
// been a string like 'rate_limit' or 'server_error' despite past types
// modelling it as an envelope. Alias kept for callers that still import
// the old name.
export type SDKAssistantErrorReason = z.infer<
  typeof SDKAssistantMessageErrorSchema
>
export type SDKAssistantMessageError = SDKAssistantErrorReason

// ---------------------------------------------------------------------------
// SDK message variants
// ---------------------------------------------------------------------------

export type SDKStatus = z.infer<typeof SDKStatusSchema>

export type SDKRateLimitInfo = z.infer<typeof SDKRateLimitInfoSchema>

export type SDKAssistantMessage = z.infer<typeof SDKAssistantMessageSchema>

export type SDKPartialAssistantMessage = z.infer<
  typeof SDKPartialAssistantMessageSchema
>

export type SDKUserMessage = z.infer<typeof SDKUserMessageSchema>

export type SDKUserMessageReplay = z.infer<typeof SDKUserMessageReplaySchema>

export type SDKResultMessage = z.infer<typeof SDKResultMessageSchema>

export type SDKSystemMessage = z.infer<typeof SDKSystemMessageSchema>

export type SDKCompactBoundaryMessage = z.infer<
  typeof SDKCompactBoundaryMessageSchema
>

export type SDKStatusMessage = z.infer<typeof SDKStatusMessageSchema>

export type SDKToolProgressMessage = z.infer<
  typeof SDKToolProgressMessageSchema
>

export type SDKPermissionDenial = z.infer<typeof SDKPermissionDenialSchema>

export type SDKSessionInfo = z.infer<typeof SDKSessionInfoSchema>

export type SDKMessage = z.infer<typeof SDKMessageSchema>

// ---------------------------------------------------------------------------
// Hook input variants
// ---------------------------------------------------------------------------

export type PreToolUseHookInput = z.infer<typeof PreToolUseHookInputSchema>
export type PostToolUseHookInput = z.infer<typeof PostToolUseHookInputSchema>
export type PostToolUseFailureHookInput = z.infer<
  typeof PostToolUseFailureHookInputSchema
>
export type PermissionDeniedHookInput = z.infer<
  typeof PermissionDeniedHookInputSchema
>
export type PermissionRequestHookInput = z.infer<
  typeof PermissionRequestHookInputSchema
>
export type NotificationHookInput = z.infer<typeof NotificationHookInputSchema>
export type UserPromptSubmitHookInput = z.infer<
  typeof UserPromptSubmitHookInputSchema
>
export type SessionStartHookInput = z.infer<typeof SessionStartHookInputSchema>
export type SessionEndHookInput = z.infer<typeof SessionEndHookInputSchema>
export type SetupHookInput = z.infer<typeof SetupHookInputSchema>
export type StopHookInput = z.infer<typeof StopHookInputSchema>
export type StopFailureHookInput = z.infer<typeof StopFailureHookInputSchema>
export type SubagentStartHookInput = z.infer<
  typeof SubagentStartHookInputSchema
>
export type SubagentStopHookInput = z.infer<typeof SubagentStopHookInputSchema>
export type PreCompactHookInput = z.infer<typeof PreCompactHookInputSchema>
export type PostCompactHookInput = z.infer<typeof PostCompactHookInputSchema>
export type TeammateIdleHookInput = z.infer<typeof TeammateIdleHookInputSchema>
export type TaskCreatedHookInput = z.infer<typeof TaskCreatedHookInputSchema>
export type TaskCompletedHookInput = z.infer<
  typeof TaskCompletedHookInputSchema
>
export type ElicitationHookInput = z.infer<typeof ElicitationHookInputSchema>
export type ElicitationResultHookInput = z.infer<
  typeof ElicitationResultHookInputSchema
>
export type ConfigChangeHookInput = z.infer<typeof ConfigChangeHookInputSchema>
export type InstructionsLoadedHookInput = z.infer<
  typeof InstructionsLoadedHookInputSchema
>
export type WorktreeCreateHookInput = z.infer<
  typeof WorktreeCreateHookInputSchema
>
export type WorktreeRemoveHookInput = z.infer<
  typeof WorktreeRemoveHookInputSchema
>
export type CwdChangedHookInput = z.infer<typeof CwdChangedHookInputSchema>
export type FileChangedHookInput = z.infer<typeof FileChangedHookInputSchema>

export type HookInput = z.infer<typeof HookInputSchema>

// ---------------------------------------------------------------------------
// Hook output
// ---------------------------------------------------------------------------

export type HookJSONOutput = z.infer<typeof HookJSONOutputSchema>
export type SyncHookJSONOutput = z.infer<typeof SyncHookJSONOutputSchema>
export type AsyncHookJSONOutput = z.infer<typeof AsyncHookJSONOutputSchema>

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

export type ModelInfo = z.infer<typeof ModelInfoSchema>
export type McpServerConfigForProcessTransport = z.infer<
  typeof McpServerConfigForProcessTransportSchema
>
export type McpServerStatus = z.infer<typeof McpServerStatusSchema>
export type RewindFilesResult = z.infer<typeof RewindFilesResultSchema>

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
