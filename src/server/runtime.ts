/**
 * The seam between the wire surface and the process that owns a session.
 *
 * Successor of `webui/attach/runtime.ts` (v1 AttachRuntime), widened to the v2
 * request/rpc surface: the interactive REPL and the headless loop register
 * different implementations, so the surface, the gateway and the browser see
 * one protocol across both process kinds.
 *
 * All reads must be synchronous and cheap — the surface calls them on the
 * publish path while a turn is streaming. `submit`/`cancel`/`setModel`/`setMode`
 * are fire-and-forget: the command was accepted, the visible effect arrives as
 * events.
 */

import type { DomainUserContentBlock } from '../types/domain.js'
import type { Message } from '../types/message.js'
import type {
  WireCatalog,
  WireImage,
  WirePendingCommand,
  WirePermissionMode,
  WireTask,
  WireTodo,
  WireTranscriptSnapshot,
  WireSessionActivity,
  WireSessionState,
} from '../session/wire.js'

export type SessionRuntime = {
  /** The authoritative transcript. Called synchronously; must not copy lazily. */
  getMessages(): readonly Message[]
  getState(): WireSessionState
  /** The phase of a streaming turn. Undefined when nothing is streaming. */
  getActivity(): WireSessionActivity | undefined
  getIsCompacting(): boolean
  /** Undefined means the account/config default. */
  getModel(): string | undefined
  getPermissionMode(): WirePermissionMode | undefined
  getTodos(): WireTodo[]
  getTasks(): WireTask[]
  getPendingCommands(): WirePendingCommand[]
  getCatalog(): WireCatalog
  getInProgressToolUseIds(): ReadonlySet<string>
  /**
   * Sidechain drill-down; absent means this process serves none yet. May be
   * async — the common case reads the sidechain JSONL — and the route waits.
   */
  getAgentTranscript?(
    agentId: string,
  ): WireTranscriptSnapshot | null | Promise<WireTranscriptSnapshot | null>

  /**
   * Queue a prompt. `interrupt` aborts the running turn and runs this next, as
   * one atomic queue operation rather than a cancel followed by a submit, which
   * would race.
   */
  submit(
    content: string,
    delivery: 'next' | 'interrupt',
    commandId: string,
    images?: readonly WireImage[],
  ): void

  /** Cancel the running turn without queueing anything. */
  cancel(): void

  /** null returns to the account/config default. */
  setModel(model: string | null): void
  setMode(mode: WirePermissionMode): void

  /**
   * Lifecycle methods (`compact`, `clear`, `rewind`, `queue_edit`,
   * `queue_remove`, `resume`). The surface answers 501 when a host omits it.
   */
  rpc?(
    method: string,
    params?: Record<string, unknown>,
  ): unknown | Promise<unknown>
}

/**
 * Builds what a submit puts on the queue.
 *
 * Images lead and the prompt text trails, which two readers depend on:
 * `processUserInputBase` takes the prompt string from the last block when it is
 * text, and `isSlashCommand` reads the first text block.
 *
 * Content blocks rather than the `pastedContents` sidecar, because
 * `executeUserInput` passes that sidecar only for the first command of a batch,
 * so a second queued image prompt would lose its images.
 */
export function buildSubmitValue(
  content: string,
  images: readonly WireImage[] | undefined,
): string | DomainUserContentBlock[] {
  if (!images?.length) return content
  const blocks: DomainUserContentBlock[] = images.map(image => ({
    type: 'image',
    source: { type: 'base64', media_type: image.mediaType, data: image.data },
  }))
  if (content) blocks.push({ type: 'text', text: content })
  return blocks
}
