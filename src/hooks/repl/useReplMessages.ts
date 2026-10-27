import {
  useState,
  useRef,
  useCallback,
  useEffect,
  useDeferredValue,
} from 'react'
import type {
  Message as MessageType,
  HookResultMessage,
} from '../../types/message.js'
import { isHumanTurn } from '../../utils/messagePredicates.js'
import { logForDebugging } from '../../utils/debug.js'
import { randomUUID } from 'crypto'
import {
  provisionContentReplacementState,
  type ContentReplacementRecord,
} from '../../utils/toolResultStorage.js'
import { useDeferredHookMessages } from '../useDeferredHookMessages.js'
import type { SessionCore } from '../../session/SessionCore.js'

const TRANSCRIPT_EVENT_TYPES = new Set<string>([
  'transcript_appended',
  'transcript_progress_replaced',
  'transcript_replaced',
  'transcript_removed',
])

/**
 * The React projection of the session core's transcript.
 *
 * The core (created by the host hook and owning the transcript array) is
 * the truth; this hook holds the render state, the synchronous ref readers
 * kept by half the REPL screen, and the optimistic-prompt bookkeeping that
 * tells "your message is on screen, the reply has not started" apart from a
 * finished turn. Every transcript write — the core's own loop or a host
 * call through the `setMessages` facade — lands on the core first and
 * arrives back here as an announced event, so no path can render a state
 * the core does not hold.
 */
export function useReplMessages({
  core,
  initialMessages,
  initialContentReplacements,
  pendingHookMessages,
}: {
  core: SessionCore
  initialMessages?: MessageType[]
  initialContentReplacements?: ContentReplacementRecord[]
  pendingHookMessages?: Promise<HookResultMessage[]>
}) {
  const [messages, rawSetMessages] = useState<MessageType[]>(
    () => core.getMessages() as MessageType[],
  )
  const messagesRef = useRef(messages)

  const [userInputOnProcessing, setUserInputOnProcessingRaw] = useState<
    string | undefined
  >(undefined)
  const userInputBaselineRef = useRef(0)
  const userMessagePendingRef = useRef(false)
  const projectedRef = useRef(messages)

  useEffect(() => {
    return core.subscribe(event => {
      if (!TRANSCRIPT_EVENT_TYPES.has(event.type)) return
      const next = core.getMessages() as MessageType[]
      const prev = projectedRef.current
      // One transcript write can announce several events (an append batch,
      // a replacement plus its removals); the projection updates once, on
      // the first, and the rest see an unchanged array.
      if (next === prev) return
      messagesRef.current = next
      if (next.length < userInputBaselineRef.current) {
        userInputBaselineRef.current = 0
      } else if (next.length > prev.length && userMessagePendingRef.current) {
        const delta = next.length - prev.length
        const added =
          prev.length === 0 || next[0] === prev[0]
            ? next.slice(-delta)
            : next.slice(0, delta)
        if (added.some(isHumanTurn)) {
          userMessagePendingRef.current = false
        } else {
          userInputBaselineRef.current = next.length
        }
      }
      projectedRef.current = next
      rawSetMessages(next)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [core])

  // The host-side write facade, unchanged in shape for its many callers:
  // resolve the updater against the core's live transcript and hand the
  // whole result back to the core, which announces it (so this hook's own
  // subscriber performs the render update).
  const setMessages = useCallback(
    (action: React.SetStateAction<MessageType[]>) => {
      const prev = core.getMessages() as MessageType[]
      const next = typeof action === 'function' ? action(prev) : action
      core.replaceMessages(next, 'edit')
    },
    [core],
  )

  const setUserInputOnProcessing = useCallback((input: string | undefined) => {
    if (input !== undefined) {
      userInputBaselineRef.current = messagesRef.current.length
      userMessagePendingRef.current = true
    } else {
      userMessagePendingRef.current = false
    }
    setUserInputOnProcessingRaw(input)
  }, [])

  const [conversationId, setConversationId] = useState(randomUUID())

  const bumpConversationId = useCallback(() => {
    setConversationId(randomUUID())
  }, [])

  // Lazy init for content replacement state
  const [contentReplacementStateRef] = useState(() => ({
    current: provisionContentReplacementState(
      initialMessages,
      initialContentReplacements,
    ),
  }))

  // Deferred SessionStart hook messages
  const awaitPendingHooks = useDeferredHookMessages(
    pendingHookMessages,
    setMessages,
  )

  // Deferred messages for the Messages component
  const deferredMessages = useDeferredValue(messages)
  const deferredBehind = messages.length - deferredMessages.length
  if (deferredBehind > 0) {
    logForDebugging(
      `[useDeferredValue] Messages deferred by ${deferredBehind} (${deferredMessages.length}→${messages.length})`,
    )
  }

  return {
    core,
    messages,
    messagesRef,
    setMessages,
    deferredMessages,
    userInputOnProcessing,
    setUserInputOnProcessing,
    userInputBaselineRef,
    conversationId,
    setConversationId,
    bumpConversationId,
    contentReplacementStateRef,
    awaitPendingHooks,
  }
}
