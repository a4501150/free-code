/**
 * REPL host adapter for the /mcp settings flow: reads the MCP slice and the
 * agent definitions from AppState, wires the connection-manager callbacks
 * and the clear-auth store write-back, and delegates rendering to the
 * host-agnostic panels/MCPDialog/MCPSettings component. Keeps the original
 * onComplete contract for the /mcp command and the settings dialog mounts.
 */

import React, { useCallback } from 'react'
import type { CommandResultDisplay } from '../../commands.js'
import {
  useMcpReconnect,
  useMcpToggleEnabled,
} from '../../services/mcp/MCPConnectionManager.js'
import { applyServerDisconnected } from '../../services/mcp/utils.js'
import { useAppState, useSetAppState } from '../../state/AppState.js'
import { MCPSettings as MCPSettingsPanel } from '../panels/MCPDialog/MCPSettings.js'

type Props = {
  onComplete: (
    result?: string,
    options?: { display?: CommandResultDisplay },
  ) => void
}

export function MCPSettings({ onComplete }: Props): React.ReactNode {
  const mcp = useAppState(s => s.mcp)
  const agentDefinitions = useAppState(s => s.agentDefinitions)
  const setAppState = useSetAppState()
  const reconnectMcpServer = useMcpReconnect()
  const toggleMcpServer = useMcpToggleEnabled()

  // A server whose auth was cleared: mark it needs-auth/failed and drop its
  // A server whose auth was cleared: mark it needs-auth/failed and drop its
  // tools, commands and resources from the store.
  const onServerDisconnected = useCallback(
    (serverName: string, clientType: 'needs-auth' | 'failed'): void => {
      setAppState(prev => ({
        ...prev,
        mcp: applyServerDisconnected(prev.mcp, serverName, clientType),
      }))
    },
    [setAppState],
  )

  return (
    <MCPSettingsPanel
      mcpClients={mcp.clients}
      mcpTools={mcp.tools}
      mcpCommands={mcp.commands}
      mcpResources={mcp.resources}
      agentDefinitions={agentDefinitions.allAgents}
      onReconnect={reconnectMcpServer}
      onToggleEnabled={toggleMcpServer}
      onServerDisconnected={onServerDisconnected}
      onComplete={onComplete}
    />
  )
}
