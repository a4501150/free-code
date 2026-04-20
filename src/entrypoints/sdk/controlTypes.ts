/**
 * Runtime request/response types for the SDK control channel. Every
 * symbol here is `z.infer<>` of a matching schema in
 * src/entrypoints/sdk/controlSchemas.ts — this file is a thin TS-only
 * facade so consumers can `import type` without dragging Zod schemas into
 * their bundles.
 */

import type { z } from 'zod/v4'
import type {
  ControlErrorResponseSchema,
  ControlResponseSchema,
  SDKControlCancelRequestSchema,
  SDKControlInitializeRequestSchema,
  SDKControlInitializeResponseSchema,
  SDKControlMcpSetServersResponseSchema,
  SDKControlPermissionRequestSchema,
  SDKControlReloadPluginsResponseSchema,
  SDKControlRequestSchema,
  SDKControlResponseSchema,
  SDKKeepAliveMessageSchema,
  SDKUpdateEnvironmentVariablesMessageSchema,
  StdinMessageSchema,
  StdoutMessageSchema,
} from './controlSchemas.js'

export type SDKControlRequest = z.infer<ReturnType<typeof SDKControlRequestSchema>>
export type SDKControlResponse = z.infer<ReturnType<typeof SDKControlResponseSchema>>
export type SDKControlCancelRequest = z.infer<
  ReturnType<typeof SDKControlCancelRequestSchema>
>
export type ControlSuccessResponse = z.infer<ReturnType<typeof ControlResponseSchema>>
export type ControlErrorResponse = z.infer<
  ReturnType<typeof ControlErrorResponseSchema>
>

export type SDKControlPermissionRequest = z.infer<
  ReturnType<typeof SDKControlPermissionRequestSchema>
>

export type SDKControlInitializeRequest = z.infer<
  ReturnType<typeof SDKControlInitializeRequestSchema>
>
export type SDKControlInitializeResponse = z.infer<
  ReturnType<typeof SDKControlInitializeResponseSchema>
>

export type SDKControlMcpSetServersResponse = z.infer<
  ReturnType<typeof SDKControlMcpSetServersResponseSchema>
>

export type SDKControlReloadPluginsResponse = z.infer<
  ReturnType<typeof SDKControlReloadPluginsResponseSchema>
>

export type SDKKeepAliveMessage = z.infer<ReturnType<typeof SDKKeepAliveMessageSchema>>

export type SDKUpdateEnvironmentVariablesMessage = z.infer<
  ReturnType<typeof SDKUpdateEnvironmentVariablesMessageSchema>
>

/**
 * Union of every message the CLI may emit to stdout on the SDK channel.
 */
export type StdoutMessage = z.infer<ReturnType<typeof StdoutMessageSchema>>

/**
 * Union of every message the CLI accepts on stdin from the SDK channel.
 */
export type StdinMessage = z.infer<ReturnType<typeof StdinMessageSchema>>
