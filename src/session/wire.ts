/**
 * The session wire protocol — the single trunk between a session and its UIs.
 *
 * Direction and transport:
 * - server -> client: an event stream (SSE). One envelope per event carrying a
 *   monotonic per-session `seq`. Reconnect replays from `Last-Event-ID`; when
 *   the journal has expired the client re-snapshots (see `resync_required`).
 * - client -> server: commands, one per HTTP POST. Bodies parse against
 *   `WireCommandSchema`; results are JSON per the route table below.
 *
 * Route table (paths under a session):
 *   GET  /events                      — the SSE stream below
 *   POST /prompt                      — WireCommand kind `prompt`
 *   POST /cancel                      — kind `cancel`
 *   POST /request_respond             — kind `request_respond`
 *   POST /model                       — kind `model_set`
 *   POST /mode                        — kind `mode_set`
 *   POST /rpc                         — kind `rpc`
 *   GET  /image?itemId=...            — WireImagePayload
 *   GET  /agents/:agentId/transcript  — WireTranscriptSnapshot (sidechain)
 *
 * This replaces the v1 attach protocol (`attachSchemas.ts` +
 * `transcriptWire.ts`). Host and clients are one codebase at one version:
 * `WIRE_VERSION` is bumped in lockstep, and every consumer switches on `kind`
 * with a default branch that IGNORES unknown members — never zod-parse a
 * whole event union — so additive kinds are forward-safe within a release.
 *
 * The `-p`/SDK `SDKMessage` stdout contract is separate and untouched.
 */

import { z } from 'zod'

export const WIRE_VERSION = 2

/** Events retained for a reconnecting client before it must re-snapshot. */
export const MAX_WIRE_REPLAY_EVENTS = 2048

/** Images one prompt may carry. */
export const MAX_PROMPT_IMAGES = 4

/** Base64 characters per uploaded image. The browser targets well under this. */
export const MAX_PROMPT_IMAGE_BASE64 = 1_000_000

export const WireImageSchema = z.object({
  mediaType: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp']),
  data: z.string().min(1).max(MAX_PROMPT_IMAGE_BASE64),
})
export type WireImage = z.infer<typeof WireImageSchema>

/** The `GET /image` result. Fetched on demand, never pushed with the transcript. */
export type WireImagePayload = {
  mediaType: string
  data: string
}

/**
 * Modes a client may request. The full set travels on the wire; the SERVER
 * polices which ones a given client may set (a remote browser token refuses
 * `bypassPermissions` and `dontAsk` — a mode that stops asking is exactly
 * what an attacker holding a remote token would choose), and the client
 * renders what the catalog gives it.
 */
export const WirePermissionModeSchema = z.enum([
  'default',
  'acceptEdits',
  'plan',
  'bypassPermissions',
  'dontAsk',
])
export type WirePermissionMode = z.infer<typeof WirePermissionModeSchema>

// ---------------------------------------------------------------------------
// Transcript

/**
 * A live transcript comes wholly through the stream. Never splice a disk
 * snapshot to a stream tail — queued writes, mutable assistant messages, DAG
 * branches and UI reordering make the merge lossy.
 *
 * Internal `Message` objects carry live tools, process-local metadata and
 * binary content, so they are never sent as-is. Each message is flattened
 * into one item per content block, and every item carries a content hash so a
 * client can apply a patch idempotently.
 */
export type WireItemKind =
  | 'user'
  | 'assistant'
  | 'reasoning'
  | 'tool_use'
  | 'tool_result'
  | 'attachment'
  | 'progress'
  | 'system'

/**
 * Structured attachment display. `type` is the internal attachment discriminator
 * (`src/utils/attachments.ts`); `display` is a one-line summary that renders
 * everywhere; `data`, when present, is the JSON-safe subset of the attachment
 * for clients that have a richer renderer. New attachment types reach every
 * client as `display` alone the moment they ship — `data` is progressive
 * enhancement, so its shape may vary by `type` without a schema change.
 */
export type WireAttachmentPayload = {
  type: string
  display: string
  data?: unknown
  /**
   * The full system-reminder text this attachment injects (the same bodies
   * the classic REPL transcript expands into), when the attachment injects
   * any. Lets a remote client render the collapsed `System reminder · type
   * (n lines)` row with the real line count instead of guessing from
   * `display`. Absent means the body could not be derived; `display` still
   * renders.
   */
  reminder?: string
}

export type WireItem = {
  id: string
  kind: WireItemKind
  /** Content fingerprint. A client replaces an item when this changes. */
  rev: string
  timestamp: string
  text?: string
  /** True for messages the UI shows dimmed or hides from the model. */
  isMeta?: boolean
  isSidechain?: boolean
  agentId?: string
  /**
   * Set on a user image block. Metadata only: the bytes stay in the session
   * and travel over `GET /image` when the reader asks for them.
   */
  image?: { mediaType: string; bytes: number }
  /**
   * user — set when the row is a slash-command invocation (the synthetic
   * `<command-name>` message). `text` carries the tagless form
   * (`/name args`) for plain renderers; a client that owns the classic
   * transcript components rebuilds the synthetic message from name/args
   * and paints the REPL's own `❯ /name args` row instead. Absent for
   * ordinary prompts; readers that do not render command rows ignore it.
   */
  commandInput?: { name: string; args?: string }
  /** assistant */
  model?: string
  /** Provider message ID, shared by sibling tool calls from one response. */
  messageId?: string
  /** tool_use */
  toolName?: string
  toolUseId?: string
  toolInput?: unknown
  /** tool_result */
  isError?: boolean
  /**
   * tool_result — the tool's structured result, the same JSON-safe value
   * the internal message carries (it round-trips through the transcript
   * file on resume). Tools render their result bodies from this; clients
   * that do not render bodies ignore it.
   */
  toolUseResult?: unknown
  /**
   * reasoning — thinking time measured host-side (recorded at
   * content_block_stop), which lets a remote row say `thought for Xs`
   * like the REPL's. Absent when the host never measured one.
   */
  durationMs?: number
  /** progress — live tool/hook activity, keyed so a UI can hang it on its tool */
  progress?: { toolUseId: string; toolName?: string; data?: unknown }
  /** attachment */
  attachment?: WireAttachmentPayload
  /** system */
  subtype?: string
  level?: string
}

export type WireTranscriptSnapshot = {
  items: WireItem[]
  order: string[]
}

export type WireTranscriptPatch =
  | {
      type: 'delta'
      upsert: WireItem[]
      remove: string[]
      /** Present when the new order is the old order plus a suffix. */
      orderAppend?: string[]
      /** Present when the order changed in a way an append cannot express. */
      order?: string[]
    }
  | { type: 'replace'; snapshot: WireTranscriptSnapshot }

/**
 * Cumulative streaming draft for the running turn: the in-flight preview a
 * client paints while the transcript is still silent. Every field is a whole
 * snapshot (never a delta), so a dropped frame costs a stale preview until
 * the next frame, never a corrupt one.
 *
 * Lifetime: the draft is transient, part of the running turn, not the
 * transcript. A client CLEARS the text preview on any `transcript` patch
 * (those rows have landed), keeps tool-call partials until `toolUseId`
 * shows up as a committed `tool_use` item (the card the partial stood in
 * for has arrived; blocks still streaming must not vanish for blocks that
 * committed beside them), and clears everything on `stream` null, on
 * `resync_required` and on `session_changed`. The server flushes the final
 * draft state before the turn's transcript patch, so a reader that shows
 * the draft never loses the ending between frames.
 */
export type WireStreamDraft = {
  /** Cumulative reasoning text for the running turn. */
  thinking?: string
  /** Cumulative visible assistant text for the running turn. */
  text?: string
  /** Tool-call inputs still streaming, in block order. */
  tools: Array<{ toolName?: string; toolUseId?: string; partialJson: string }>
}

/** A host-surfaced message (settings errors, rate limits, plugin status). */
export type WireNotification = {
  level: 'info' | 'warn' | 'error'
  text: string
}

// ---------------------------------------------------------------------------
// User requests (every surface where the session waits on a human)

export type WireQuestionOption = {
  label: string
  description?: string
  /** Side-by-side comparison content shown when this option is focused. */
  preview?: string
}

export type WireQuestion = {
  question: string
  header: string
  options: WireQuestionOption[]
  multiSelect?: boolean
}

export type WirePermissionDecision =
  | {
      behavior: 'allow'
      /** Empty means "use the tool input as-is", per the phone-client contract. */
      updatedInput?: Record<string, unknown>
      /** Persist the decision for the rest of this session only. */
      persist?: boolean
      /**
       * Switch the permission mode as part of answering (plan approval is
       * "allow the ExitPlanMode call AND leave plan mode" — one round trip).
       */
      setMode?: WirePermissionMode
      /**
       * User feedback threaded through an approval (plan approval's
       * "approve with this feedback"). The tool receives it alongside the
       * allow, the same way the terminal dialog passes it.
       */
      feedback?: string
    }
  | {
      behavior: 'deny'
      message?: string
    }

/**
 * One union for every blocking user interaction. `ui` specializes a
 * permission prompt into the rich form the tool defines (plan diff, multiple
 * choice question); a bare permission renders allow/deny with the raw input.
 */
export type WireRequest =
  | {
      requestId: string
      kind: 'permission'
      openedAt: number
      toolName: string
      toolUseId: string
      description: string
      input: Record<string, unknown>
      title?: string
      blockedPath?: string
      agentId?: string
      ui?:
        | { kind: 'plan'; planFilePath: string; planContent: string }
        | { kind: 'question'; questions: WireQuestion[] }
    }
  | {
      requestId: string
      kind: 'hook_prompt'
      openedAt: number
      message: string
      options: Array<{ key: string; label: string; description?: string }>
    }
  | {
      requestId: string
      kind: 'elicitation'
      openedAt: number
      serverName: string
      /** MCP `ElicitRequestParams`, passed through as JSON. */
      params: unknown
      /** True while a URL elicitation awaits the user's browser step. */
      waiting?: boolean
    }

export type WireRequestResponse =
  | { kind: 'permission'; decision: WirePermissionDecision }
  | { kind: 'hook_prompt'; selected: string }
  | {
      kind: 'elicitation'
      action: 'accept' | 'decline' | 'cancel'
      /** MCP `ElicitResult.content` — the accepted form values. */
      content?: unknown
    }

/** Closed-out outcome, so every UI can retire the same dialog shell. */
export type WireRequestOutcome = 'resolved' | 'cancelled' | 'expired'

// ---------------------------------------------------------------------------
// Session state

export type WireSessionState = 'idle' | 'running' | 'requires_action'

/**
 * What a running turn is doing right now. Named after the TUI spinner phases
 * so every surface says the same word. Absent when nothing is streaming.
 */
export type WireSessionActivity =
  | 'requesting'
  | 'thinking'
  | 'responding'
  | 'tool-use'
  | 'tool-input'
  | 'compacting'

/**
 * Context budget for the current window.
 *
 * `usedPercent` measures the last API response's input context against the
 * model window, which is what the statusline reports. `compactPercentLeft`
 * measures headroom against the auto-compact threshold instead, and is absent
 * when auto-compact is off, because nothing will then compact.
 */
export type WireSessionContext = {
  usedTokens: number
  maxTokens: number
  usedPercent: number
  compactPercentLeft?: number
}

export type WireSessionMeta = {
  sessionId: string
  sessionEpoch: number
  cwd: string
  startedAt: number
  /** Absent or null means the account/config default. */
  model?: string | null
  permissionMode?: WirePermissionMode
  state: WireSessionState
  activity?: WireSessionActivity
  context?: WireSessionContext
  /** Total cost in USD for the session, not the turn. */
  costUsd?: number
  linesAdded?: number
  linesRemoved?: number
  /** Tool-use IDs currently executing, so a UI can show running state. */
  inProgressToolUseIds?: string[]
}

export type WireTodo = {
  content: string
  status: string
  activeForm?: string
}

/**
 * A command sitting in the session queue. Unlike v1 these are addressable:
 * `rpc` `queue_edit`/`queue_remove` act on `id`, so a client can fix or drop
 * a queued prompt instead of watching it scroll.
 */
export type WirePendingCommand = {
  id: string
  text: string
  isMeta?: boolean
}

/** Background work (agents, shells) shown in the task panel. */
export type WireTask = {
  id: string
  kind: string
  description: string
  status: string
  /** Wall-clock start; lets a remote panel show a running duration. */
  startTime?: number
  /** Set once the task reaches a terminal status. */
  endTime?: number
  /** The shell's command line; present for shells. */
  command?: string
  /** Last lines of output, present for shells; the panel tails without a fetch. */
  outputTail?: string
}

/**
 * Choices the session currently offers. Static-ish, so it rides the snapshot
 * and a `catalog` event, not every meta update.
 */
export type WireCatalog = {
  /** `value` null is the account default. */
  models: Array<{ value: string | null; label: string }>
  commands: Array<{
    name: string
    description?: string
    argHint?: string
  }>
  permissionModes: WirePermissionMode[]
}

// ---------------------------------------------------------------------------
// Server -> client events

export type WireEvent =
  | {
      kind: 'snapshot'
      meta: WireSessionMeta
      transcript: WireTranscriptSnapshot
      requests: WireRequest[]
      todos: WireTodo[]
      pendingCommands: WirePendingCommand[]
      tasks: WireTask[]
      catalog: WireCatalog
    }
  | { kind: 'transcript'; patch: WireTranscriptPatch }
  | { kind: 'meta'; meta: WireSessionMeta }
  /**
   * In-flight preview for the running turn; null draft means the preview
   * ended without a committed row yet (e.g. an aborted turn). Cleared client
   * side by the next `transcript` patch — see WireStreamDraft.
   */
  | { kind: 'stream'; draft: WireStreamDraft | null }
  | { kind: 'notify'; notification: WireNotification }
  | { kind: 'request_opened'; request: WireRequest }
  | { kind: 'request_closed'; requestId: string; outcome: WireRequestOutcome }
  | { kind: 'todos'; todos: WireTodo[] }
  | { kind: 'queue'; commands: WirePendingCommand[] }
  | { kind: 'tasks'; tasks: WireTask[] }
  | { kind: 'catalog'; catalog: WireCatalog }
  | { kind: 'session_changed'; sessionId: string; sessionEpoch: number }
  | { kind: 'resync_required' }

/**
 * The SSE `data:` payload. Clients parse `seq`/`v`, then dispatch on
 * `event.kind` with a default branch that ignores unknown kinds.
 */
export type WireEventEnvelope = {
  v: number
  seq: number
  event: WireEvent
}

// ---------------------------------------------------------------------------
// Client -> server commands

export const WirePermissionDecisionSchema = z.discriminatedUnion('behavior', [
  z.object({
    behavior: z.literal('allow'),
    updatedInput: z.record(z.string(), z.unknown()).optional(),
    persist: z.boolean().optional(),
    setMode: WirePermissionModeSchema.optional(),
    feedback: z.string().max(4000).optional(),
  }),
  z.object({
    behavior: z.literal('deny'),
    message: z.string().max(2000).optional(),
  }),
])

export const WireRequestResponseSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('permission'),
    decision: WirePermissionDecisionSchema,
  }),
  z.object({
    kind: z.literal('hook_prompt'),
    selected: z.string().min(1).max(200),
  }),
  z.object({
    kind: z.literal('elicitation'),
    action: z.enum(['accept', 'decline', 'cancel']),
    content: z.unknown().optional(),
  }),
])

/**
 * Commands a client may cause. An allowlist: parameters ride as bodies, and
 * anything that changes session behavior without a body is an `rpc` method —
 * both are policed server-side against the client's token, never by trust.
 */
export const WireCommandSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('prompt'),
    commandId: z.string().min(1).max(200),
    // Empty only when `images` carries the whole prompt; the route rejects a
    // prompt that is empty on both counts.
    content: z.string().max(200_000),
    images: z.array(WireImageSchema).max(MAX_PROMPT_IMAGES).optional(),
    delivery: z.enum(['next', 'interrupt']),
    sessionEpoch: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal('cancel'),
  }),
  z.object({
    kind: z.literal('request_respond'),
    requestId: z.string().min(1).max(200),
    response: WireRequestResponseSchema,
  }),
  z.object({
    kind: z.literal('model_set'),
    /** null returns to the account/config default. */
    model: z.string().min(1).max(200).nullable(),
  }),
  z.object({
    kind: z.literal('mode_set'),
    mode: WirePermissionModeSchema,
  }),
  z.object({
    kind: z.literal('rpc'),
    method: z.enum([
      'compact',
      'clear',
      'rewind',
      'queue_edit',
      'queue_remove',
      'resume',
    ]),
    /** Method-specific params, validated by the route, not here. */
    params: z.record(z.string(), z.unknown()).optional(),
  }),
])

export type WireCommand = z.infer<typeof WireCommandSchema>
