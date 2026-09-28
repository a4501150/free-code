/**
 * The web client's view store: the shared framework-free reducer
 * (`src/session/viewStore.ts`, which the TUI client uses too) wrapped in
 * React's external-store contract. The reducer and the store live in the
 * session module; only this hook is React.
 */
import { useSyncExternalStore } from 'react'
import type { SessionView, ViewStore } from '../../session/viewStore.js'

export {
  applyEvent,
  createViewStore,
  emptyView,
  type PermissionEntry,
  type SessionView,
  type ViewStore,
} from '../../session/viewStore.js'

export function useViewStore(store: ViewStore): SessionView {
  return useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot)
}
