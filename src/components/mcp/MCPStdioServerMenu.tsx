/**
 * REPL host adapter for the stdio MCP server menu: reads the MCP commands and
 * resources from AppState, wires the connection manager's reconnect/toggle
 * actions, and renders the host-agnostic
 * panels/MCPDialog/MCPStdioServerMenu component. Keeps the original props
 * contract for the /mcp and /plugin mounts.
 */

import React from 'react'
import type { CommandResultDisplay } from '../../commands.js'
import {
  useMcpReconnect,
  useMcpToggleEnabled,
} from '../../services/mcp/MCPConnectionManager.js'
import { useAppState } from '../../state/AppState.js'
import { MCPStdioServerMenu as MCPStdioServerMenuPanel } from '../panels/MCPDialog/MCPStdioServerMenu.js'
import type { StdioServerInfo } from './types.js'

type Props = {
  server: StdioServerInfo
  serverToolsCount: number
  onViewTools: () => void
  onCancel: () => void
  onComplete: (
    result?: string,
    options?: { display?: CommandResultDisplay },
  ) => void
  borderless?: boolean
}

export function MCPStdioServerMenu({
  server,
  serverToolsCount,
  onViewTools,
  onCancel,
  onComplete,
  borderless = false,
}: Props): React.ReactNode {
  const mcp = useAppState(s => s.mcp)
  const reconnectMcpServer = useMcpReconnect()
  const toggleMcpServer = useMcpToggleEnabled()

  return (
    <MCPStdioServerMenuPanel
      server={server}
      serverToolsCount={serverToolsCount}
      commands={mcp.commands}
      resources={mcp.resources}
      onReconnect={reconnectMcpServer}
      onToggleEnabled={toggleMcpServer}
      onViewTools={onViewTools}
      onCancel={onCancel}
      onComplete={onComplete}
      borderless={borderless}
    />
  )
}
