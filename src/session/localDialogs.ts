/**
 * The in-process channel for local-jsx slash-command dialogs (/help, /model,
 * the /debug-tool-call picker, …).
 *
 * A local-jsx command builds React and hands it to `setToolJSX`; the classic
 * REPL renders that JSX in its modal slot. A hosted session has no terminal
 * dialog of its own — but when the viewer IS the session's process (the
 * hosted launcher), the JSX needs a handoff, not a serialization: this store
 * is where the session's input pipeline writes and the AttachedSession viewer
 * reads. The mirror of the classic `useReplToolJSX` fold — the local-command
 * latch, the `clearLocalJSX` release — minus React, so `hosted.ts` can own it
 * without importing the render runtime.
 *
 * Same-process only. A remote attach never receives the JSX (it is opaque
 * over the wire), so there the command's transcript results still arrive
 * while the dialog itself stays with the hosting terminal — the same rule
 * the /tasks mirror draws.
 */
import type { ReactNode } from 'react'

export type LocalDialog = {
  jsx: ReactNode
  shouldHidePromptInput: boolean
  showSpinner?: boolean
  isLocalJSXCommand?: boolean
  isImmediate?: boolean
}

type SetToolJSXArgs = {
  jsx: ReactNode | null
  shouldHidePromptInput: boolean
  showSpinner?: boolean
  isLocalJSXCommand?: boolean
  isImmediate?: boolean
  clearLocalJSX?: boolean
} | null

export type LocalDialogStore = {
  subscribe(listener: () => void): () => void
  snapshot(): LocalDialog | null
  /**
   * The session-side `setToolJSX`: accepts the REPL's args shape verbatim
   * and applies the REPL's clear/replace rules verbatim.
   */
  set(args: SetToolJSXArgs): void
}

export function createLocalDialogStore(): LocalDialogStore {
  let dialog: LocalDialog | null = null
  // Mirrors useReplToolJSX's localJSXCommandRef: while a local-jsx command
  // holds the slot, non-clear writes are dropped — a stray progress update
  // must not evict the dialog the user is looking at.
  let localCommandHeld = false
  const listeners = new Set<() => void>()

  function notify(): void {
    for (const listener of listeners) listener()
  }

  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    snapshot() {
      return dialog
    },
    set(args) {
      if (args?.isLocalJSXCommand) {
        const { clearLocalJSX: _clear, jsx, ...rest } = args
        localCommandHeld = true
        dialog = jsx == null ? null : { jsx, ...rest }
        notify()
        return
      }
      if (localCommandHeld) {
        if (args?.clearLocalJSX) {
          localCommandHeld = false
          dialog = null
          notify()
        }
        return
      }
      if (!args || args.clearLocalJSX || args.jsx == null) {
        if (dialog !== null) {
          dialog = null
          notify()
        }
        return
      }
      const { clearLocalJSX: _clear, jsx, ...rest } = args
      dialog = { jsx, ...rest }
      notify()
    },
  }
}
