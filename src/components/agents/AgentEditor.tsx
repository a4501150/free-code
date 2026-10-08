/**
 * REPL host adapter for the /agents editor: wires the post-save
 * agent-definitions write-back to AppState and delegates rendering to
 * the host-agnostic panels/AgentsMenuDialog component.
 */

import * as React from 'react'
import { useCallback } from 'react'
import { useSetAppState } from '../../state/AppState.js'
import type { Tools } from '../../Tool.js'
import type { AgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js'
import { withAgentUpdated } from './agentDefinitionUpdates.js'
import {
  type AgentEditorChanges,
  AgentEditor as AgentEditorPanel,
} from '../panels/AgentsMenuDialog/AgentEditor.js'

type Props = {
  agent: AgentDefinition
  tools: Tools
  onSaved: (message: string) => void
  onBack: () => void
}

export function AgentEditor({
  agent,
  tools,
  onSaved,
  onBack,
}: Props): React.ReactNode {
  const setAppState = useSetAppState()

  const onAgentUpdated = useCallback(
    (changes: AgentEditorChanges): void => {
      setAppState(state => withAgentUpdated(state, changes))
    },
    [setAppState],
  )

  return (
    <AgentEditorPanel
      agent={agent}
      tools={tools}
      onSaved={onSaved}
      onBack={onBack}
      onAgentUpdated={onAgentUpdated}
    />
  )
}
