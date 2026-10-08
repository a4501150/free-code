/**
 * REPL host adapter for the /hooks dialog. Reads the app store (MCP tools
 * for the matcher tool pool, and a state snapshot for hook grouping) and
 * renders the host-agnostic panel in panels/HooksConfigDialog/.
 */
import * as React from 'react'
import { useMemo } from 'react'
import { useAppState, useAppStateStore } from 'src/state/AppState.js'
import type { CommandResultDisplay } from '../../commands.js'
import { groupHooksByEventAndMatcher } from '../../utils/hooks/hooksConfigManager.js'
import { HooksConfigMenu as HooksConfigMenuPanel } from '../panels/HooksConfigDialog/HooksConfigMenu.js'

type Props = {
  toolNames: string[]
  onExit: (
    result?: string,
    options?: { display?: CommandResultDisplay },
  ) => void
}

export function HooksConfigMenu({ toolNames, onExit }: Props): React.ReactNode {
  const mcp = useAppState(s => s.mcp)
  const appStateStore = useAppStateStore()
  const combinedToolNames = useMemo(
    () => [...toolNames, ...mcp.tools.map(tool => tool.name)],
    [toolNames, mcp.tools],
  )

  const hooksByEventAndMatcher = useMemo(
    () =>
      groupHooksByEventAndMatcher(appStateStore.getState(), combinedToolNames),
    [combinedToolNames, appStateStore],
  )

  return (
    <HooksConfigMenuPanel
      combinedToolNames={combinedToolNames}
      hooksByEventAndMatcher={hooksByEventAndMatcher}
      onExit={onExit}
    />
  )
}
