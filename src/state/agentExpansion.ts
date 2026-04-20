import * as React from 'react'
import { useAppState, useSetAppState } from './AppState.js'

export function useIsAgentToolUseExpanded(toolUseId: string): boolean {
  return useAppState(s => s.expandedAgentToolUseIds.has(toolUseId))
}

export function useToggleAgentToolUseExpansion(toolUseId: string): () => void {
  const setAppState = useSetAppState()
  return React.useCallback(() => {
    setAppState(prev => {
      const next = new Set(prev.expandedAgentToolUseIds)
      if (next.has(toolUseId)) next.delete(toolUseId)
      else next.add(toolUseId)
      return { ...prev, expandedAgentToolUseIds: next }
    })
  }, [setAppState, toolUseId])
}
