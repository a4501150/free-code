import type { Message } from '../../types/message.js'
import type {
  WebPermissionMode,
  WebSessionState,
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
  getModel(): string | undefined
  getPermissionMode(): string | undefined
  getTodos(): WebTodo[]

  /**
   * Queue a prompt. `interrupt` aborts the running turn and runs this next, as
   * one atomic queue operation rather than a cancel followed by a submit, which
   * would race.
   */
  submit(
    content: string,
    delivery: 'next' | 'interrupt',
    commandId: string,
  ): void

  /** Cancel the running turn without queueing anything. */
  interrupt(): void

  setPermissionMode(mode: WebPermissionMode): void
  setModel(model: string): void
}
