/**
 * REPL host adapter for the /agents menu: reads agent definitions, MCP
 * tools and the tool permission context from AppState, wires the
 * post-delete/edit/create store write-backs, and delegates rendering to
 * the host-agnostic panels/AgentsMenuDialog component.
 */

import * as React from 'react'
import { useCallback } from 'react'
import type { CommandResultDisplay } from '../../commands.js'
import { useAppState, useSetAppState } from '../../state/AppState.js'
import type { Tools } from '../../Tool.js'
import type { AgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js'
import {
  withAgentCreated,
  withAgentDeleted,
  withAgentUpdated,
} from './agentDefinitionUpdates.js'
import { AgentsMenu as AgentsMenuPanel } from '../panels/AgentsMenuDialog/AgentsMenu.js'
import type { AgentEditorChanges } from '../panels/AgentsMenuDialog/AgentEditor.js'

type Props = {
  tools: Tools
  onExit: (
    result?: string,
    options?: { display?: CommandResultDisplay },
  ) => void
}

export function AgentsMenu({ tools, onExit }: Props): React.ReactNode {
  const agentDefinitions = useAppState(s => s.agentDefinitions)
  const mcpTools = useAppState(s => s.mcp.tools)
  const toolPermissionContext = useAppState(s => s.toolPermissionContext)
  const setAppState = useSetAppState()

  const onAgentDeleted = useCallback(
    (agent: AgentDefinition): void => {
      setAppState(state => withAgentDeleted(state, agent))
    },
    [setAppState],
  )

  const onAgentUpdated = useCallback(
    (changes: AgentEditorChanges): void => {
      setAppState(state => withAgentUpdated(state, changes))
    },
    [setAppState],
  )

  const onAgentCreated = useCallback(
    (agent: AgentDefinition): void => {
      setAppState(state => withAgentCreated(state, agent))
    },
    [setAppState],
  )

  return (
    <AgentsMenuPanel
      tools={tools}
      onExit={onExit}
      agentDefinitions={agentDefinitions}
      mcpTools={mcpTools}
      toolPermissionContext={toolPermissionContext}
      onAgentDeleted={onAgentDeleted}
      onAgentUpdated={onAgentUpdated}
      onAgentCreated={onAgentCreated}
    />
  )
}
