/**
 * Runtime request/response types for the SDK control channel. Every
 * symbol here is `z.infer<>` of a matching schema in
 * src/structuredProtocol/controlSchemas.ts — this file is a thin TS-only
 * facade so consumers can `import type` without dragging Zod schemas into
 * their bundles.
 */

import type { z } from 'zod/v4'
import type {
  SDKControlInitializeRequestSchema,
  SDKControlInitializeResponseSchema,
  SDKControlMcpSetServersResponseSchema,
  SDKControlReloadPluginsResponseSchema,
  SDKControlRequestSchema,
  SDKControlResponseSchema,
  StdinMessageSchema,
  StdoutMessageSchema,
} from './controlSchemas.js'

export type SDKControlRequest = z.infer<typeof SDKControlRequestSchema>
export type SDKControlResponse = z.infer<typeof SDKControlResponseSchema>

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

/**
 * Union of every message the CLI may emit to stdout on the SDK channel.
 */
export type StdoutMessage = z.infer<typeof StdoutMessageSchema>

/**
 * Union of every message the CLI accepts on stdin from the SDK channel.
 */
export type StdinMessage = z.infer<typeof StdinMessageSchema>
