import { useEffect, useRef, useState } from 'react'

/**
 * Gates a subtree's unmount: flips true immediately when `active` rises,
 * and only after `graceMs` once `active` falls. Bridges brief dips of a
 * mount condition mid-turn (isLoading dropping between request boundaries,
 * queues draining and refilling) so the subtree survives the dip instead
 * of unmounting and remounting — a row disappearing and reappearing reads
 * as a blink. A real teardown is only delayed by `graceMs`.
 */
export function useUnmountDebounce(active: boolean, graceMs: number): boolean {
  const [held, setHeld] = useState(active)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    if (active) {
      setHeld(true)
    } else {
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        setHeld(false)
      }, graceMs)
    }
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [active, graceMs])

  return held
}
