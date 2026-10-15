/**
 * React shim over the framework-free view store; the reducer and the store
 * itself live in src/session/viewStore.ts so non-React hosts can share them.
 */
import { useSyncExternalStore } from 'react'
import type { SessionView, ViewStore } from '../../session/viewStore.js'

export type { SessionView, ViewStore } from '../../session/viewStore.js'
export {
  applyEvent,
  createViewStore,
  emptyView,
} from '../../session/viewStore.js'

export function useViewStore(store: ViewStore): SessionView {
  return useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot)
}
