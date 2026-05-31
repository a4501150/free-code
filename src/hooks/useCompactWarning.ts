import { useSyncExternalStore } from 'react'
import { compactWarningStore } from '../services/compact/compactWarningState.js'

export function useCompactWarningSuppression(): boolean {
  return useSyncExternalStore(
    compactWarningStore.subscribe,
    compactWarningStore.getState,
  )
}
