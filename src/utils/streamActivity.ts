/**
 * The phase of the turn currently streaming, for surfaces that cannot see the
 * stream themselves.
 *
 * The interactive REPL keeps its own `streamMode`, so it does not read this.
 * Print mode has no equivalent: `QueryEngine` yields `stream_event` only when
 * `includePartialMessages` is set, which a gateway-spawned session does not
 * pass, and turning it on would serialize every delta into a stdout pipe the
 * gateway discards.
 */

import type { SpinnerMode } from '../components/Spinner/types.js'
import type { DomainStreamEvent } from '../types/domain.js'
import { isAnyReasoningBlock, isToolUseBlock } from '../types/domainGuards.js'

/** The phases the TUI spinner names, so both surfaces say the same word. */
export type StreamActivity = SpinnerMode

let current: StreamActivity | undefined

export function getStreamActivity(): StreamActivity | undefined {
  return current
}

export function clearStreamActivity(): void {
  current = undefined
}

let compacting = false
let onActivityChanged: (() => void) | undefined

export function setStreamActivityListener(cb: (() => void) | undefined): void {
  onActivityChanged = cb
}

export function getIsCompacting(): boolean {
  return compacting
}

export function setIsCompacting(value: boolean): void {
  const changed = compacting !== value
  compacting = value
  if (changed) onActivityChanged?.()
}

let inProgressToolUseIds: Set<string> = new Set()

export function getInProgressToolUseIds(): ReadonlySet<string> {
  return inProgressToolUseIds
}

export function setInProgressToolUseIds(
  updater: (prev: Set<string>) => Set<string>,
): void {
  inProgressToolUseIds = updater(inProgressToolUseIds)
}

/** Mirrors the phase transitions in `handleMessageFromStream`. */
export function recordStreamActivity(event: DomainStreamEvent): void {
  switch (event.type) {
    case 'message_start':
      current = 'requesting'
      return
    case 'content_block_start':
      // A domain content_block widens to `{ type: string }`, so a bare
      // comparison against a wire type would compile and never match.
      current = isAnyReasoningBlock(event.content_block)
        ? 'thinking'
        : isToolUseBlock(event.content_block)
          ? 'tool-input'
          : 'responding'
      return
    case 'message_stop':
      // The assistant has stopped talking. Anything still to come this turn is
      // a tool running.
      current = 'tool-use'
      return
    default:
  }
}
