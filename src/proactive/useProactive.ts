/**
 * React hook for delivering periodic <tick> prompts in proactive mode.
 *
 * When proactive mode is active and not blocked, fires tick prompts on a
 * configurable interval. The tick prompt is an XML string that the LLM
 * receives as a periodic check-in signal.
 */

import { useEffect, useRef } from 'react'
import { TICK_TAG } from '../constants/xml.js'
import {
  isContextBlocked,
  isProactiveActive,
  isProactivePaused,
} from './index.js'

/** Default tick interval in milliseconds (60 seconds). */
const TICK_INTERVAL_MS = 60_000

interface UseProactiveOptions {
  /** Whether a query/response is currently in progress. */
  isLoading: boolean
  /** Number of commands waiting in the queue. */
  queuedCommandsLength: number
  /** Whether a local JSX command UI is showing. */
  hasActiveLocalJsxUI: boolean
  /** Whether plan mode is active. */
  isInPlanMode: boolean
  /** Submit a tick prompt directly (when idle). */
  onSubmitTick: (prompt: string) => void
  /** Queue a tick prompt (when busy). */
  onQueueTick: (prompt: string) => void
}

function buildTickPrompt(): string {
  const ts = new Date().toISOString()
  return `<${TICK_TAG} timestamp="${ts}" />`
}

export function useProactive(opts: UseProactiveOptions): void {
  const {
    isLoading,
    queuedCommandsLength,
    hasActiveLocalJsxUI,
    isInPlanMode,
    onSubmitTick,
    onQueueTick,
  } = opts

  // Refs to avoid stale closures in the interval callback
  const isLoadingRef = useRef(isLoading)
  const queuedRef = useRef(queuedCommandsLength)
  const hasUIRef = useRef(hasActiveLocalJsxUI)
  const planRef = useRef(isInPlanMode)
  const submitRef = useRef(onSubmitTick)
  const queueRef = useRef(onQueueTick)

  isLoadingRef.current = isLoading
  queuedRef.current = queuedCommandsLength
  hasUIRef.current = hasActiveLocalJsxUI
  planRef.current = isInPlanMode
  submitRef.current = onSubmitTick
  queueRef.current = onQueueTick

  useEffect(() => {
    if (!isProactiveActive()) return

    const timer = setInterval(() => {
      // Don't tick if proactive mode was deactivated/paused
      if (!isProactiveActive() || isProactivePaused()) return

      // Don't tick if context is blocked (compaction, etc.)
      if (isContextBlocked()) return

      // Don't tick if a local JSX command is showing or plan mode is active
      if (hasUIRef.current || planRef.current) return

      const tick = buildTickPrompt()

      if (isLoadingRef.current || queuedRef.current > 0) {
        // Busy: queue the tick so it's processed after current work
        queueRef.current(tick)
      } else {
        // Idle: submit directly
        submitRef.current(tick)
      }
    }, TICK_INTERVAL_MS)

    return () => clearInterval(timer)
    // Re-create interval when proactive mode toggles. The isLoading dep
    // is intentionally excluded — we read it via ref to avoid resetting
    // the interval timer on every loading state change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isProactiveActive()])
}
