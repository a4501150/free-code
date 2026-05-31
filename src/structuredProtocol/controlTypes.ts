/**
 * Runtime request/response types for the SDK control channel. Every
 * symbol here is `z.infer<>` of a matching schema in
 * src/structuredProtocol/controlSchemas.ts — this file is a thin TS-only
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

export type SDKControlRequest = z.infer<
  typeof SDKControlRequestSchema
>
export type SDKControlResponse = z.infer<
  typeof SDKControlResponseSchema
>
export type SDKControlCancelRequest = z.infer<
  typeof SDKControlCancelRequestSchema
>
export type ControlSuccessResponse = z.infer<
  typeof ControlResponseSchema
>
export type ControlErrorResponse = z.infer<
  typeof ControlErrorResponseSchema
>

export type SDKControlPermissionRequest = z.infer<
  typeof SDKControlPermissionRequestSchema
>

export type SDKControlInitializeRequest = z.infer<
  typeof SDKControlInitializeRequestSchema
>
export type SDKControlInitializeResponse = z.infer<
  typeof SDKControlInitializeResponseSchema
>

export type SDKControlMcpSetServersResponse = z.infer<
  typeof SDKControlMcpSetServersResponseSchema
>

export type SDKControlReloadPluginsResponse = z.infer<
  typeof SDKControlReloadPluginsResponseSchema
>

export type SDKKeepAliveMessage = z.infer<
  typeof SDKKeepAliveMessageSchema
>

export type SDKUpdateEnvironmentVariablesMessage = z.infer<
  typeof SDKUpdateEnvironmentVariablesMessageSchema
>

/**
 * Union of every message the CLI may emit to stdout on the SDK channel.
 */
export type StdoutMessage = z.infer<typeof StdoutMessageSchema>

/**
 * Union of every message the CLI accepts on stdin from the SDK channel.
 */
export type StdinMessage = z.infer<typeof StdinMessageSchema>
