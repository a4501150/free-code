import { z } from 'zod'
import type {
  TranscriptPatch,
  WebTranscriptSnapshot,
} from './transcriptWire.js'

export const ATTACH_PROTOCOL_VERSION = 1

/**
 * A single NDJSON line above this is a protocol error, not a big message.
 *
 * Large enough for a four-image upload and for a `get_image` answer holding an
 * image at the API's 5 MB base64 ceiling (`src/constants/apiLimits.ts`).
 */
export const MAX_ATTACH_LINE_BYTES = 8 * 1024 * 1024

/** Events retained for a reconnecting client before it must re-snapshot. */
export const MAX_ATTACH_REPLAY_EVENTS = 2048

/** Images one submit may carry. */
export const MAX_SUBMIT_IMAGES = 4

/** Base64 characters per uploaded image. The browser targets well under this. */
export const MAX_SUBMIT_IMAGE_BASE64 = 1_000_000

export const WebSubmitImageSchema = z.object({
  mediaType: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp']),
  data: z.string().min(1).max(MAX_SUBMIT_IMAGE_BASE64),
})

export type WebSubmitImage = z.infer<typeof WebSubmitImageSchema>

/**
 * Permission modes a browser may select. Deliberately excludes
 * `bypassPermissions`: the browser is reachable from the public internet
 * behind one password, and a mode that stops asking is exactly what an
 * attacker holding that password would choose.
 */
export const WebPermissionModeSchema = z.enum([
  'default',
  'acceptEdits',
  'plan',
])
export type WebPermissionMode = z.infer<typeof WebPermissionModeSchema>

export const WebPermissionDecisionSchema = z.discriminatedUnion('behavior', [
  z.object({
    behavior: z.literal('allow'),
    /** Empty means "use the tool input as-is", per the phone-client contract. */
    updatedInput: z.record(z.string(), z.unknown()).optional(),
    /** Persist the decision for the rest of this session only. */
    persist: z.boolean().optional(),
  }),
  z.object({
    behavior: z.literal('deny'),
    message: z.string().max(2000).optional(),
  }),
])
export type WebPermissionDecision = z.infer<typeof WebPermissionDecisionSchema>

/**
 * Commands a browser may cause.
 *
 * This is an allowlist and must never be widened to `StdinMessageSchema`,
 * which carries `update_environment_variables`, `apply_flag_settings`,
 * `mcp_set_servers` and `rewind_files`.
 */
export const AttachRequestBodySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('hello'),
    token: z.string().min(1),
    protocolVersion: z.literal(ATTACH_PROTOCOL_VERSION),
  }),
  z.object({
    kind: z.literal('subscribe'),
    afterSeq: z.number().int().nonnegative().optional(),
  }),
  z.object({
    kind: z.literal('submit'),
    commandId: z.string().min(1).max(200),
    // Empty only when `images` carries the whole prompt. A refined member
    // cannot sit in a discriminated union, so `attachHost` rejects a submit
    // that is empty on both counts.
    content: z.string().max(200_000),
    images: z.array(WebSubmitImageSchema).max(MAX_SUBMIT_IMAGES).optional(),
    delivery: z.enum(['next', 'interrupt']),
    sessionEpoch: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal('interrupt'),
  }),
  z.object({
    kind: z.literal('permission_decision'),
    requestId: z.string().min(1),
    decision: WebPermissionDecisionSchema,
  }),
  z.object({
    kind: z.literal('set_permission_mode'),
    mode: WebPermissionModeSchema,
  }),
  z.object({
    kind: z.literal('set_model'),
    model: z.string().min(1).max(200),
  }),
  z.object({
    kind: z.literal('get_image'),
    /** A transcript item id, which is `${message.uuid}:${blockIndex}`. */
    itemId: z.string().min(1).max(200),
  }),
])

export type AttachRequestBody = z.infer<typeof AttachRequestBodySchema>

export const AttachRequestSchema = z.object({
  type: z.literal('request'),
  requestId: z.string().min(1).max(200),
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

/** The `get_image` result. Fetched on demand, never pushed with the transcript. */
export type WebImagePayload = {
  mediaType: string
  data: string
}

export type WebSessionState = 'idle' | 'running' | 'requires_action'

export type WebPermissionRequest = {
  requestId: string
  toolName: string
  toolUseId: string
  description: string
  input: Record<string, unknown>
  title?: string
  blockedPath?: string
  agentId?: string
  openedAt: number
}

export type WebSessionMeta = {
  pid: number
  processNonce: string
  sessionId: string
  sessionEpoch: number
  cwd: string
  entrypoint?: string
  startedAt: number
  model?: string
  permissionMode?: string
  state: WebSessionState
  /** Total cost in USD for the process, not the turn. */
  costUsd?: number
  linesAdded?: number
  linesRemoved?: number
}

export type WebTodo = {
  content: string
  status: string
  activeForm?: string
}

export type WebModelOption = {
  value: string
  label: string
}

export type AttachEventBody =
  | {
      kind: 'snapshot'
      meta: WebSessionMeta
      transcript: WebTranscriptSnapshot
      permissions: WebPermissionRequest[]
      todos: WebTodo[]
      /** Static for the process, so it rides the snapshot and not every meta. */
      models: WebModelOption[]
    }
  | { kind: 'transcript'; patch: TranscriptPatch }
  | { kind: 'meta'; meta: WebSessionMeta }
  | { kind: 'permission_opened'; request: WebPermissionRequest }
  | { kind: 'permission_closed'; requestId: string; outcome: string }
  | { kind: 'todos'; todos: WebTodo[] }
  | { kind: 'session_changed'; sessionId: string; sessionEpoch: number }
  | { kind: 'resync_required' }

export type AttachEventEnvelope = {
  type: 'event'
  seq: number
  event: AttachEventBody
}

export type AttachOutbound = AttachResponse | AttachEventEnvelope
