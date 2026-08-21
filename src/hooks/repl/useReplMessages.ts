import { feature } from 'bun:bundle'
import { useState, useRef, useCallback, useDeferredValue } from 'react'
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

export function useReplMessages({
  initialMessages,
  initialContentReplacements,
  pendingHookMessages,
  publishTranscript,
}: {
  initialMessages?: MessageType[]
  initialContentReplacements?: ContentReplacementRecord[]
  pendingHookMessages?: Promise<HookResultMessage[]>
  publishTranscript?: () => void
}) {
  const [messages, rawSetMessages] = useState<MessageType[]>(
    initialMessages ?? [],
  )
  const messagesRef = useRef(messages)

  const [userInputOnProcessing, setUserInputOnProcessingRaw] = useState<
    string | undefined
  >(undefined)
  const userInputBaselineRef = useRef(0)
  const userMessagePendingRef = useRef(false)

  // Wrap setMessages so messagesRef is always current the instant the
  // call returns — not when React later processes the batch. Apply the
  // updater eagerly against the ref, then hand React the computed value
  // (not the function). rawSetMessages batching becomes last-write-wins,
  // and the last write is correct because each call composes against the
  // already-updated ref. This is the Zustand pattern: ref is source of
  // truth, React state is the render projection.
  const setMessages = useCallback(
    (action: React.SetStateAction<MessageType[]>) => {
      const prev = messagesRef.current
      const next =
        typeof action === 'function' ? action(messagesRef.current) : action
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
      rawSetMessages(next)
      if (feature('WEBUI')) {
        publishTranscript?.()
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
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
