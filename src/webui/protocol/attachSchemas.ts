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

/**
 * Largest `get_task_output` tail the browser may ask for. JSON-escaping a
 * tail of mostly newlines at most doubles it, which still clears
 * `MAX_ATTACH_LINE_BYTES` with room for the rest of the response frame.
 */
export const MAX_TASK_OUTPUT_TAIL_BYTES = 3 * 1024 * 1024

/** Default tail when a viewer asks without a size: what the TUI dialog shows. */
export const DEFAULT_TASK_OUTPUT_TAIL_BYTES = 1024 * 1024

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
    /**
     * A transcript item id, `${message.uuid}:${blockIndex}`, with a trailing
     * `:${partIndex}` for an image nested inside a tool_result.
     */
    itemId: z.string().min(1).max(200),
  }),
  z.object({
    kind: z.literal('list_tasks'),
  }),
  z.object({
    kind: z.literal('get_task_transcript'),
    taskId: z.string().min(1).max(200),
  }),
  z.object({
    kind: z.literal('get_task_output'),
    taskId: z.string().min(1).max(200),
    /** Tail size to read; the host clamps it under the wire line limit. */
    tailBytes: z
      .number()
      .int()
      .positive()
      .max(MAX_TASK_OUTPUT_TAIL_BYTES)
      .optional(),
  }),
  z.object({
    kind: z.literal('subscribe_task'),
    taskId: z.string().min(1).max(200),
    /**
     * Byte offset the client's seed ended at, for shell/monitor output
     * streaming: appends start here, so the seed read and the live stream
     * can neither overlap nor leave a gap. Ignored for agent transcripts,
     * and treated as the current end of file when a shell viewer seeded
     * nothing.
     */
    fromOffset: z.number().int().nonnegative().optional(),
  }),
  z.object({
    kind: z.literal('unsubscribe_task'),
    taskId: z.string().min(1).max(200),
  }),
  z.object({
    kind: z.literal('kill_task'),
    taskId: z.string().min(1).max(200),
  }),
])

export type AttachRequestBody = z.infer<typeof AttachRequestBodySchema>

export const AttachRequestSchema = z.object({
  type: z.literal('request'),
  requestId: z.string().min(1).max(200),
  request: AttachRequestBodySchema,
})

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

/**
 * What a running turn is doing right now. Named after the TUI spinner phases so
 * both surfaces say the same word. Absent when nothing is streaming.
 */
export type WebSessionActivity =
  | 'requesting'
  | 'thinking'
  | 'responding'
  | 'tool-use'
  | 'tool-input'
  | 'compacting'

/**
 * Context budget for the current window.
 *
 * `usedPercent` measures the last API response's input context against the model
 * window, which is what the statusline reports. `compactPercentLeft` measures
 * headroom against the auto-compact threshold instead, and is absent when
 * auto-compact is off, because nothing will then compact.
 */
export type WebSessionContext = {
  usedTokens: number
  maxTokens: number
  usedPercent: number
  compactPercentLeft?: number
}

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
  activity?: WebSessionActivity
  context?: WebSessionContext
  /** Total cost in USD for the process, not the turn. */
  costUsd?: number
  linesAdded?: number
  linesRemoved?: number
  /** Tool-use IDs currently executing, so the browser can show running state. */
  inProgressToolUseIds?: string[]
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

export type WebPendingCommand = {
  id: string
  text: string
}

/**
 * A background task as the browser sees it: the display fields of
 * `TaskStateBase` and its variants, with nothing that would drag live
 * objects (messages, abort controllers) across the socket.
 */
export type WebTaskSummary = {
  id: string
  taskType:
    | 'local_agent'
    | 'remote_agent'
    | 'local_bash'
    | 'monitor_mcp'
    | 'dream'
  status: 'pending' | 'running' | 'completed' | 'failed' | 'killed'
  description: string
  /** Steering name from the agent-name registry, when the agent registered one. */
  name?: string
  /** local_agent / remote_agent */
  agentType?: string
  model?: string
  /** Epoch ms. */
  startTime: number
  endTime?: number
  /** local_bash: the shell command line, so the browser can echo it back. */
  command?: string
  /** The tool use that spawned the task, so a ToolCard can point at it. */
  toolUseId?: string
  /** local_bash: the shell's exit code once it has one. */
  exitCode?: number
  /** local_agent progress, absent until the agent records any. */
  toolUseCount?: number
  tokenCount?: number
  /** Messages queued for the agent via SendMessage, not yet drained. */
  pendingCount?: number
}

/** The `get_task_transcript` answer. `done` means the task is terminal. */
export type WebTaskTranscript = {
  items: import('./transcriptWire.js').WebTranscriptItem[]
  done: boolean
}

/**
 * The `get_task_output` answer: the tail of a shell/monitor's output file,
 * with the same "[NKB of earlier output omitted]" prefix convention the TUI
 * dialog and `getTaskOutput` use. `offset` is where the (un-prefixed) content
 * starts in the file; `bytesTotal` is where it ends — subscribe with that as
 * `fromOffset` so the live stream carries only bytes the seed did not show.
 */
export type WebTaskOutput = {
  content: string
  offset: number
  bytesTotal: number
  /** True once the task is terminal: no further appends will arrive. */
  done: boolean
}

export type AttachEventBody =
  | {
      kind: 'snapshot'
      meta: WebSessionMeta
      transcript: WebTranscriptSnapshot
      permissions: WebPermissionRequest[]
      todos: WebTodo[]
      pendingCommands: WebPendingCommand[]
      /** Static for the process, so it rides the snapshot and not every meta. */
      models: WebModelOption[]
      commands: string[]
      tasks?: WebTaskSummary[]
    }
  | { kind: 'transcript'; patch: TranscriptPatch }
  | { kind: 'meta'; meta: WebSessionMeta }
  | { kind: 'tasks'; tasks: WebTaskSummary[] }
  /**
   * Transcript deltas for one background task, for connections that sent
   * `subscribe_task`. The client routes these into the per-task view; the
   * main transcript never sees them.
   */
  | { kind: 'task_transcript'; taskId: string; patch: TranscriptPatch }
  /**
   * Output-file appends for one shell/monitor task, for connections that
   * sent `subscribe_task` with a `fromOffset`. `done` means the task is
   * terminal (or has vanished from the session) and no further frames for
   * it will follow.
   */
  | {
      kind: 'task_output'
      taskId: string
      append: string
      fromOffset: number
      toOffset: number
      done: boolean
    }
  | { kind: 'permission_opened'; request: WebPermissionRequest }
  | { kind: 'permission_closed'; requestId: string; outcome: string }
  | { kind: 'todos'; todos: WebTodo[] }
  | { kind: 'pending_commands'; commands: WebPendingCommand[] }
  | { kind: 'session_changed'; sessionId: string; sessionEpoch: number }
  | { kind: 'resync_required' }

export type AttachEventEnvelope = {
  type: 'event'
  seq: number
  event: AttachEventBody
}

export type AttachOutbound = AttachResponse | AttachEventEnvelope
