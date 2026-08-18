import type { DomainUserContentBlock } from '../../types/domain.js'
import type { Message } from '../../types/message.js'
import type {
  WebPermissionMode,
  WebSessionActivity,
  WebSessionState,
  WebSubmitImage,
  WebTodo,
} from '../protocol/attachSchemas.js'

/**
 * The seam between the attach socket and the process that owns the session.
 *
 * The interactive REPL and the headless loop register different
 * implementations, so the socket protocol and everything the gateway and
 * browser see stay identical across both process kinds.
 */
export type AttachRuntime = {
  /** The authoritative transcript. Called synchronously; must not copy lazily. */
  getMessages(): readonly Message[]
  getState(): WebSessionState
  /** The phase of a streaming turn. Undefined when nothing is streaming. */
  getActivity(): WebSessionActivity | undefined
  getModel(): string | undefined
  getPermissionMode(): string | undefined
  getTodos(): WebTodo[]
  getCommands(): string[]

  /**
   * Queue a prompt. `interrupt` aborts the running turn and runs this next, as
   * one atomic queue operation rather than a cancel followed by a submit, which
   * would race.
   */
  submit(
    content: string,
    delivery: 'next' | 'interrupt',
    commandId: string,
    images?: readonly WebSubmitImage[],
  ): void

  /** Cancel the running turn without queueing anything. */
  interrupt(): void

  setPermissionMode(mode: WebPermissionMode): void
  setModel(model: string): void
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
  images: readonly WebSubmitImage[] | undefined,
): string | DomainUserContentBlock[] {
  if (!images?.length) return content
  const blocks: DomainUserContentBlock[] = images.map(image => ({
    type: 'image',
    source: { type: 'base64', media_type: image.mediaType, data: image.data },
  }))
  if (content) blocks.push({ type: 'text', text: content })
  return blocks
}
