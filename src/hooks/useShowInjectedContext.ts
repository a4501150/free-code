import { useAppState } from '../state/AppState.js'

/** Absent means enabled, so existing configs get the rows without opting in. */
export function useShowInjectedContext(): boolean {
  return useAppState(s => s.settings.showInjectedContext) !== false
}
