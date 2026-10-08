/**
 * REPL host adapter for the /memory file selector: reads the agent
 * definitions and the live dream-task state from AppState and delegates
 * rendering to the host-agnostic panels/MemoryDialog component. The /memory
 * command keeps importing this adapter unchanged.
 */

import * as React from 'react'
import { useAppState } from '../../state/AppState.js'
import {
  MemoryFileSelector as MemoryFileSelectorPanel,
  type MemoryFileSelectorProps,
} from '../panels/MemoryDialog/MemoryFileSelector.js'

type Props = Omit<
  MemoryFileSelectorProps,
  'agentDefinitions' | 'isDreamRunning'
>

export function MemoryFileSelector({
  onSelect,
  onCancel,
}: Props): React.ReactNode {
  const agentDefinitions = useAppState(s => s.agentDefinitions)
  // Dream status: prefer live task state (this session fired it), fall back
  // to the cross-process lock mtime in the panel.
  const isDreamRunning = useAppState(s =>
    Object.values(s.tasks).some(
      t => t.type === 'dream' && t.status === 'running',
    ),
  )

  return (
    <MemoryFileSelectorPanel
      onSelect={onSelect}
      onCancel={onCancel}
      agentDefinitions={agentDefinitions}
      isDreamRunning={isDreamRunning}
    />
  )
}
