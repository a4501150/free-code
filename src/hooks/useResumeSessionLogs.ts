import * as React from 'react'

import type { LogOption } from '../types/logs.js'
import { logError } from '../utils/log.js'
import {
  enrichLogs,
  loadAllProjectsMessageLogsProgressive,
  loadSameRepoMessageLogsProgressive,
  type SessionLogResult,
} from '../utils/sessionStorage.js'

type Options = {
  /**
   * Git worktree paths of the current repository. Loading waits until the
   * paths are resolved (pass null while getWorktreePaths is still running).
   */
  worktreePaths: string[] | null
  /** Called when a load fails; defaults to logError. */
  onError?: (error: unknown) => void
}

/**
 * Progressive session-log loading shared by the resume entry points
 * (/resume command and --resume startup screen): current-project loads with
 * progressive enrichment, Ctrl+A all-projects loads, and incremental
 * load-more as the user scrolls near the end of the list.
 */
export function useResumeSessionLogs({ worktreePaths, onError }: Options): {
  logs: LogOption[]
  loading: boolean
  showAllProjects: boolean
  loadMoreLogs: (count: number) => void
  toggleAllProjects: () => void
  /** Re-run the current scope's load (e.g. after a rename). */
  reload: () => void
} {
  const [logs, setLogs] = React.useState<LogOption[]>([])
  const [loading, setLoading] = React.useState(true)
  const [showAllProjects, setShowAllProjects] = React.useState(false)
  const sessionLogResultRef = React.useRef<SessionLogResult | null>(null)
  // Mirror of logs.length so loadMoreLogs can compute value indices outside
  // the setLogs updater (keeping it pure per React's contract).
  const logCountRef = React.useRef(0)
  // Ref keeps onError out of loadLogs' deps: a fresh inline callback at the
  // call site must not re-trigger the load effect.
  const onErrorRef = React.useRef(onError)
  onErrorRef.current = onError
  // Sequence guard: a slow load (or in-flight load-more) from a previous
  // scope must not win over the most recent one.
  const loadSeqRef = React.useRef(0)
  const enrichInFlightRef = React.useRef(false)

  const loadLogs = React.useCallback(
    (allProjects: boolean) => {
      if (worktreePaths === null) {
        return
      }
      const seq = ++loadSeqRef.current
      setLoading(true)
      const promise = allProjects
        ? loadAllProjectsMessageLogsProgressive()
        : loadSameRepoMessageLogsProgressive(worktreePaths)
      promise
        .then(result => {
          if (seq !== loadSeqRef.current) {
            return
          }
          sessionLogResultRef.current = result
          logCountRef.current = result.logs.length
          setLogs(result.logs)
        })
        .catch(error => {
          if (seq !== loadSeqRef.current) {
            return
          }
          if (onErrorRef.current) {
            onErrorRef.current(error)
          } else {
            logError(error)
          }
        })
        .finally(() => {
          if (seq === loadSeqRef.current) {
            setLoading(false)
          }
        })
    },
    [worktreePaths],
  )

  // Initial load (and reload when worktree paths resolve late).
  React.useEffect(() => {
    loadLogs(false)
  }, [loadLogs])

  const loadMoreLogs = React.useCallback((count: number) => {
    const ref = sessionLogResultRef.current
    if (
      !ref ||
      enrichInFlightRef.current ||
      ref.nextIndex >= ref.allStatLogs.length
    ) {
      return
    }

    const seq = loadSeqRef.current
    enrichInFlightRef.current = true

    async function enrichMore(
      statLogsRef: SessionLogResult,
      count: number,
    ): Promise<void> {
      const result = await enrichLogs(
        statLogsRef.allStatLogs,
        statLogsRef.nextIndex,
        count,
      )
      if (seq !== loadSeqRef.current) {
        return
      }
      statLogsRef.nextIndex = result.nextIndex
      if (result.logs.length > 0) {
        // enrichLogs returns fresh unshared objects — safe to mutate in
        // place. Offset comes from logCountRef so the setLogs updater
        // stays pure.
        const offset = logCountRef.current
        result.logs.forEach((log, i) => {
          log.value = offset + i
        })
        setLogs(prev => prev.concat(result.logs))
        logCountRef.current += result.logs.length
      } else if (statLogsRef.nextIndex < statLogsRef.allStatLogs.length) {
        await enrichMore(statLogsRef, count)
      }
    }

    void enrichMore(ref, count)
      .catch(error => {
        logError(error)
      })
      .finally(() => {
        enrichInFlightRef.current = false
      })
  }, [])

  const toggleAllProjects = React.useCallback(() => {
    const newValue = !showAllProjects
    setShowAllProjects(newValue)
    loadLogs(newValue)
  }, [showAllProjects, loadLogs])

  const reload = React.useCallback(() => {
    loadLogs(showAllProjects)
  }, [loadLogs, showAllProjects])

  return {
    logs,
    loading,
    showAllProjects,
    loadMoreLogs,
    toggleAllProjects,
    reload,
  }
}
