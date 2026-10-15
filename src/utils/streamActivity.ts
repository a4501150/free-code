/**
 * The phase of the turn currently streaming, for surfaces that cannot see the
 * stream themselves.
 *
 * The interactive REPL keeps its own `streamMode`, so it does not read this.
 * Print mode has no equivalent: `QueryEngine` yields `stream_event` only when
 * `includePartialMessages` is set, which a gateway-spawned session does not
 * pass, and turning it on would serialize every delta into a stdout pipe the
 * gateway discards.
 *
 * All fields live in session scope (`scopedStore`): unscoped code shares the
 * root instance; a session core running inside `runInSessionScope` gets its
 * own activity, compacting flag and in-progress tool set. The listener is
 * per-scope for the same reason — it is registered by the session's own
 * wire projector, from inside that session's scope.
 */

import { scopedStore } from '../bootstrap/state.js'
import type { SpinnerMode } from '../components/Spinner/types.js'
import type { DomainStreamEvent } from '../types/domain.js'
import { isAnyReasoningBlock, isToolUseBlock } from '../types/domainGuards.js'

/** The phases the TUI spinner names, so both surfaces say the same word. */
export type StreamActivity = SpinnerMode

type StreamActivityStore = {
  current: StreamActivity | undefined
  compacting: boolean
  onActivityChanged: (() => void) | undefined
  inProgressToolUseIds: Set<string>
}

const store = scopedStore<StreamActivityStore>(() => ({
  current: undefined,
  compacting: false,
  onActivityChanged: undefined,
  inProgressToolUseIds: new Set(),
}))

export function getStreamActivity(): StreamActivity | undefined {
  return store().current
}

export function setStreamActivityListener(cb: (() => void) | undefined): void {
  store().onActivityChanged = cb
}

export function getIsCompacting(): boolean {
  return store().compacting
}

export function setIsCompacting(value: boolean): void {
  const st = store()
  const changed = st.compacting !== value
  st.compacting = value
  if (changed) st.onActivityChanged?.()
}

export function getInProgressToolUseIds(): ReadonlySet<string> {
  return store().inProgressToolUseIds
}

/** Mirrors the phase transitions in `handleMessageFromStream`. */
export function recordStreamActivity(event: DomainStreamEvent): void {
  const st = store()
  switch (event.type) {
    case 'message_start':
      st.current = 'requesting'
      return
    case 'content_block_start':
      // A domain content_block widens to `{ type: string }`, so a bare
      // comparison against a wire type would compile and never match.
      st.current = isAnyReasoningBlock(event.content_block)
        ? 'thinking'
        : isToolUseBlock(event.content_block)
          ? 'tool-input'
          : 'responding'
      return
    case 'message_stop':
      // The assistant has stopped talking. Anything still to come this turn is
      // a tool running.
      st.current = 'tool-use'
      return
    default:
  }
}
