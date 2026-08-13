import { z } from 'zod'

export const ATTACH_PROTOCOL_VERSION = 1

/** A single NDJSON line above this is a protocol error, not a big message. */
export const MAX_ATTACH_LINE_BYTES = 1024 * 1024

export const AttachHelloSchema = z.object({
  kind: z.literal('hello'),
  token: z.string().min(1),
  protocolVersion: z.literal(ATTACH_PROTOCOL_VERSION),
})

/**
 * Commands a browser may cause. This is a deliberate allowlist and must never
 * be widened to `StdinMessageSchema`, which carries
 * `update_environment_variables` and `apply_flag_settings`.
 */
export const AttachRequestBodySchema = z.discriminatedUnion('kind', [
  AttachHelloSchema,
])

export const AttachRequestSchema = z.object({
  type: z.literal('request'),
  requestId: z.string().min(1),
  request: AttachRequestBodySchema,
})

export type AttachRequest = z.infer<typeof AttachRequestSchema>

export type AttachResponse = {
  type: 'response'
  requestId: string
  ok: boolean
  result?: unknown
  error?: { code: string; message: string }
}

export type AttachEventEnvelope = {
  type: 'event'
  processNonce: string
  sessionId: string
  sessionEpoch: number
  seq: number
  event: { kind: string; [key: string]: unknown }
}

export type AttachOutbound = AttachResponse | AttachEventEnvelope
