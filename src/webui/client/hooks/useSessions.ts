import { useCallback, useEffect, useRef, useState } from 'react'
import type { SessionListEntry } from '../../../sessiond/sessionList.js'
import {
  fetchSessions,
  startSession,
  type StartRequest,
  stopSession,
  type StartResult,
  type StopResult,
} from '../api.js'

const POLL_MS = 5000

/** How long a keystroke waits before it costs a request. */
const SEARCH_DEBOUNCE_MS = 200

export type Sessions = {
  entries: SessionListEntry[]
  refresh(): Promise<void>
  create(cwd: string): Promise<StartResult>
  resume(sessionId: string): Promise<StartResult>
  stop(pid: number): Promise<StopResult>
  /** The history search text (echoed so the input can be a controlled one). */
  query: string
  setQuery(q: string): void
}

/**
 * Owns the session list and the HTTP mutations on it.
 *
 * It does not touch the transcript store and does not attach the socket. The
 * caller sequences those, because only it knows what the user is looking at.
 */
export function useSessions(csrf: string | null): Sessions {
  const [entries, setEntries] = useState<SessionListEntry[]>([])
  const [query, setQueryRaw] = useState('')

  // The poll can outlive its own interval tick. Without a generation counter a
  // slow response overwrites a newer one.
  const generation = useRef(0)

  // What the last request actually carried. The input can run ahead of it by
  // one debounce; the poll must not answer a stale keystroke.
  const searched = useRef('')
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const refresh = useCallback(async () => {
    const mine = ++generation.current
    const next = await fetchSessions(searched.current || undefined)
    if (mine === generation.current) setEntries(next)
  }, [])

  const setQuery = useCallback(
    (q: string) => {
      setQueryRaw(q)
      if (debounceTimer.current) clearTimeout(debounceTimer.current)
      debounceTimer.current = setTimeout(() => {
        debounceTimer.current = null
        searched.current = q
        void refresh()
      }, SEARCH_DEBOUNCE_MS)
    },
    [refresh],
  )

  useEffect(
    () => () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current)
    },
    [],
  )

  useEffect(() => {
    if (!csrf) return
    void refresh()
    const timer = setInterval(() => void refresh(), POLL_MS)
    return () => clearInterval(timer)
  }, [csrf, refresh])

  const start = useCallback(
    async (request: StartRequest): Promise<StartResult> => {
      if (!csrf) return { ok: false, error: 'not authenticated' }
      const result = await startSession(request, csrf)
      await refresh()
      return result
    },
    [csrf, refresh],
  )

  const create = useCallback(
    (cwd: string): Promise<StartResult> => start({ cwd }),
    [start],
  )

  const resume = useCallback(
    (sessionId: string): Promise<StartResult> =>
      start({ resumeSessionId: sessionId }),
    [start],
  )

  const stop = useCallback(
    async (pid: number): Promise<StopResult> => {
      if (!csrf) return { ok: false, error: 'not authenticated' }
      const result = await stopSession(pid, csrf)
      await refresh()
      return result
    },
    [csrf, refresh],
  )

  return { entries, refresh, create, resume, stop, query, setQuery }
}
