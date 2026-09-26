import { createSignal } from './signal.js'

export type ClaudeCodeHintType = 'plugin'

export type ClaudeCodeHint = {
  /** Spec version declared by the emitter. Unknown versions are dropped. */
  v: number
  /** Hint discriminator. v1 defines only `plugin`. */
  type: ClaudeCodeHintType
  /**
   * Hint payload. For `type: 'plugin'`: a `name@marketplace` slug
   * matching the form accepted by `parsePluginIdentifier`.
   */
  value: string
  /**
   * First token of the shell command that produced this hint. Shown in the
   * install prompt so the user can spot a mismatch between the tool that
   * emitted the hint and the plugin it recommends.
   */
  sourceCommand: string
}

/** Spec versions this harness understands. */
const SUPPORTED_VERSIONS = new Set([1])

/** Hint types this harness understands at the supported versions. */
const SUPPORTED_TYPES = new Set<string>(['plugin'])

/**
 * Outer tag match. Anchored to whole lines (multiline mode) so that a
 * hint marker buried in a larger line — e.g. a log statement quoting the
 * tag — is ignored. Leading and trailing whitespace on the line is
 * tolerated since some SDKs pad stderr.
 */
const HINT_TAG_RE = /^[ \t]*<claude-code-hint\s+([^>]*?)\s*\/>[ \t]*$/gm

/**
 * Attribute matcher. Accepts `key="value"` and `key=value` (terminated by
 * whitespace or `/>` closing sequence). Values containing whitespace or `"` must use the quoted
 * form. The quoted form does not support escape sequences; raise the spec
 * version if that becomes necessary.
 */
const ATTR_RE = /(\w+)=(?:"([^"]*)"|([^\s/>]+))/g

function parseAttrs(tagBody: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  for (const m of tagBody.matchAll(ATTR_RE)) {
    attrs[m[1]!] = m[2] ?? m[3] ?? ''
  }
  return attrs
}

function firstCommandToken(command: string): string {
  const trimmed = command.trim()
  const spaceIdx = trimmed.search(/\s/)
  return spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)
}

// ============================================================================
// Pending-hint store (useSyncExternalStore interface)
//
// Single-slot: write wins if the slot is already full (a CLI that emits on
// every invocation would otherwise pile up). The dialog is shown at most
// once per session; after that, setPendingHint becomes a no-op.
//
// Callers should gate before writing (installed? already shown? cap hit?).
// This module stays plugin-agnostic so future hint types can reuse
// the same store.
// ============================================================================

let pendingHint: ClaudeCodeHint | null = null
let shownThisSession = false
const pendingHintChanged = createSignal()
const notify = pendingHintChanged.emit

/** Raw store write. Callers should gate first (see module comment). */
export function setPendingHint(hint: ClaudeCodeHint): void {
  if (shownThisSession) return
  pendingHint = hint
  notify()
}
