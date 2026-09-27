/**
 * The session core's event vocabulary.
 *
 * Every mutation the core makes to session-visible state is announced here,
 * in one emit per mutation. UIs subscribe (the TUI via a store projection,
 * remote clients via the wire's `transcript`/`meta`/… events, which are
 * serialized from these) and none of them poll.
 *
 * Granularity rule: an event describes WHAT changed, not what a particular
 * UI should do. "scrollToBottom after compaction" is a TUI reaction to
 * `transcript_replaced`, not an event type.
 */

import type { Message, ProgressMessage, UserMessage } from '../types/message.js'
import type { StreamingToolUse, StreamingThinking } from '../utils/messages.js'
import type { SpinnerMode } from '../components/Spinner/types.js'
import type { SessionId } from '../types/ids.js'
import type {
  WireRequest,
  WireRequestOutcome,
  WireSessionMeta,
  WireTodo,
  WirePendingCommand,
  WireTask,
  WireCatalog,
} from './wire.js'

export type SessionEvent =
  /** A message appended at the transcript tail. */
  | { type: 'transcript_appended'; message: Message }
  /**
   * The last item was replaced in place — ephemeral tool progress replacing
   * its predecessor (same parent tool, same progress kind).
   */
  | { type: 'transcript_progress_replaced'; message: ProgressMessage }
  /**
   * The transcript was rewritten whole: compaction (boundary truncation),
   * rewind, or session switch. `reason` lets UIs react differentially
   * (the TUI pins scroll on compact, keeps it on rewind).
   */
  | {
      type: 'transcript_replaced'
      messages: Message[]
      reason: 'compact' | 'rewind' | 'switch' | 'restore'
    }
  /** A message removed from the middle (tombstoned assistant partial). */
  | { type: 'transcript_removed'; uuid: Message['uuid'] }
  /**
   * A turn transition. The transcript is already updated when this fires,
   * so a snapshot-consistent UI can render the finished turn at once.
   */
  | { type: 'turn_started' }
  | { type: 'turn_finished'; aborted: boolean }
  /** Streaming phase; mirrors the TUI spinner's `SpinnerMode` names. */
  | { type: 'activity'; activity: SpinnerMode | undefined }
  /** Cumulative assistant text delta for the running turn. */
  | { type: 'response_length_delta'; chars: number }
  | { type: 'streaming_text'; text: string | null }
  | { type: 'streaming_tool_uses'; toolUses: StreamingToolUse[] }
  | { type: 'streaming_thinking'; thinking: StreamingThinking | null }
  /** Auto-compaction / manual /compact phase for the meters and spinner. */
  | { type: 'compacting'; startedAt: number | null }
  /**
   * Bumped whenever the transcript's identity as a conversation changes
   * (compact boundary, manual summarize, resume) so renderers reset memoized
   * message keys.
   */
  | { type: 'conversation_id'; id: string }
  /** A user message was cancelled and pulled back for editing. */
  | { type: 'user_message_restored'; message: UserMessage }
  // --- session surface state (each maps 1:1 to a wire event) ---
  | { type: 'meta'; meta: WireSessionMeta }
  | { type: 'request_opened'; request: WireRequest }
  | {
      type: 'request_closed'
      requestId: string
      outcome: WireRequestOutcome
    }
  | { type: 'todos'; todos: WireTodo[] }
  | { type: 'queue'; commands: WirePendingCommand[] }
  | { type: 'tasks'; tasks: WireTask[] }
  | { type: 'catalog'; catalog: WireCatalog }
  | { type: 'session_changed'; sessionId: SessionId; sessionEpoch: number }

export type SessionEventSubscriber = (event: SessionEvent) => void

/** Minimal emit/subscribe bus — same shape as `createSignal`, typed union. */
export function createSessionEventBus() {
  const subscribers = new Set<SessionEventSubscriber>()
  return {
    emit(event: SessionEvent): void {
      for (const cb of subscribers) cb(event)
    },
    subscribe(cb: SessionEventSubscriber): () => void {
      subscribers.add(cb)
      return () => {
        subscribers.delete(cb)
      }
    },
  }
}
