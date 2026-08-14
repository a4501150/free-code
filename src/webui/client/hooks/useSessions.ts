import { useCallback, useEffect, useRef, useState } from 'react'
import type { SessionListEntry } from '../../gateway/sessionHub.js'
import {
  createSession,
  fetchSessions,
  stopSession,
  type CreateResult,
  type StopResult,
} from '../api.js'

const POLL_MS = 5000

export type Sessions = {
  entries: SessionListEntry[]
  refresh(): Promise<void>
  create(cwd: string): Promise<CreateResult>
  stop(pid: number): Promise<StopResult>
}

/**
 * Owns the session list and the HTTP mutations on it.
 *
 * It does not touch the transcript store and does not attach the socket. The
 * caller sequences those, because only it knows what the user is looking at.
 */
export function useSessions(csrf: string | null): Sessions {
  const [entries, setEntries] = useState<SessionListEntry[]>([])

  // The poll can outlive its own interval tick. Without a generation counter a
  // slow response overwrites a newer one.
  const generation = useRef(0)

  const refresh = useCallback(async () => {
    const mine = ++generation.current
    const next = await fetchSessions()
    if (mine === generation.current) setEntries(next)
  }, [])

  useEffect(() => {
    if (!csrf) return
    void refresh()
    const timer = setInterval(() => void refresh(), POLL_MS)
    return () => clearInterval(timer)
  }, [csrf, refresh])

  const create = useCallback(
    async (cwd: string): Promise<CreateResult> => {
      if (!csrf) return { ok: false, error: 'not authenticated' }
      const result = await createSession(cwd, csrf)
      await refresh()
      return result
    },
    [csrf, refresh],
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

  return { entries, refresh, create, stop }
}
