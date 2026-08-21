import * as React from 'react'
import { useState, useRef, useCallback } from 'react'
import { QueryGuard } from '../../utils/QueryGuard.js'

export function useReplQueryLifecycle({
  resetStreamingState,
  setUserInputOnProcessing,
}: {
  resetStreamingState: () => void
  setUserInputOnProcessing: (input: string | undefined) => void
}) {
  const queryGuard = React.useRef(new QueryGuard()).current

  const isQueryActive = React.useSyncExternalStore(
    queryGuard.subscribe,
    queryGuard.getSnapshot,
  )

  const [isExternalLoading, setIsExternalLoadingRaw] = React.useState(false)
  const isLoading = isQueryActive || isExternalLoading

  const [abortController, setAbortController] =
    useState<AbortController | null>(null)
  const abortControllerRef = useRef<AbortController | null>(null)
  abortControllerRef.current = abortController

  // Wall-clock time tracking refs
  const loadingStartTimeRef = React.useRef<number>(0)
  const totalPausedMsRef = React.useRef(0)
  const pauseStartTimeRef = React.useRef<number | null>(null)
  const resetTimingRefs = React.useCallback(() => {
    loadingStartTimeRef.current = Date.now()
    totalPausedMsRef.current = 0
    pauseStartTimeRef.current = null
  }, [])

  // Reset timing refs inline when isQueryActive transitions false→true
  const wasQueryActiveRef = React.useRef(false)
  if (isQueryActive && !wasQueryActiveRef.current) {
    resetTimingRefs()
  }
  wasQueryActiveRef.current = isQueryActive

  const setIsExternalLoading = React.useCallback(
    (value: boolean) => {
      setIsExternalLoadingRaw(value)
      if (value) resetTimingRefs()
    },
    [resetTimingRefs],
  )

  const swarmStartTimeRef = React.useRef<number | null>(null)

  const [lastQueryCompletionTime, setLastQueryCompletionTime] = useState(0)

  const resetLoadingState = useCallback(() => {
    setIsExternalLoading(false)
    setUserInputOnProcessing(undefined)
    resetStreamingState()
  }, [resetStreamingState, setIsExternalLoading, setUserInputOnProcessing])

  return {
    queryGuard,
    isQueryActive,
    isLoading,
    isExternalLoading,
    setIsExternalLoading,
    abortController,
    setAbortController,
    abortControllerRef,
    loadingStartTimeRef,
    totalPausedMsRef,
    pauseStartTimeRef,
    resetTimingRefs,
    swarmStartTimeRef,
    lastQueryCompletionTime,
    setLastQueryCompletionTime,
    resetLoadingState,
  }
}
