/**
 * REPL host adapter for the remote (SSE / HTTP / claude.ai-proxy) MCP server
 * menu: reads the MCP commands and resources from AppState, wires the
 * connection manager's reconnect/toggle actions and the clear-auth store
 * write-back, and renders the host-agnostic
 * panels/MCPDialog/MCPRemoteServerMenu component. Keeps the original props
 * contract for the /mcp and /plugin mounts.
 */

import React, { useCallback } from 'react'
import type { CommandResultDisplay } from '../../commands.js'
import {
  useMcpReconnect,
  useMcpToggleEnabled,
} from '../../services/mcp/MCPConnectionManager.js'
import { applyServerDisconnected } from '../../services/mcp/utils.js'
import { useAppState, useSetAppState } from '../../state/AppState.js'
import { MCPRemoteServerMenu as MCPRemoteServerMenuPanel } from '../panels/MCPDialog/MCPRemoteServerMenu.js'
import type {
  ClaudeAIServerInfo,
  HTTPServerInfo,
  SSEServerInfo,
} from './types.js'

type Props = {
  server: SSEServerInfo | HTTPServerInfo | ClaudeAIServerInfo
  serverToolsCount: number
  onViewTools: () => void
  onCancel: () => void
  onComplete?: (
    result?: string,
    options?: { display?: CommandResultDisplay },
  ) => void
  borderless?: boolean
}

export function MCPRemoteServerMenu({
  server,
  serverToolsCount,
  onViewTools,
  onCancel,
  onComplete,
  borderless = false,
}: Props): React.ReactNode {
  const mcp = useAppState(s => s.mcp)
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
    <MCPRemoteServerMenuPanel
      server={server}
      serverToolsCount={serverToolsCount}
      commands={mcp.commands}
      resources={mcp.resources}
      onReconnect={reconnectMcpServer}
      onToggleEnabled={toggleMcpServer}
      onServerDisconnected={onServerDisconnected}
      onViewTools={onViewTools}
      onCancel={onCancel}
      onComplete={onComplete}
      borderless={borderless}
    />
  )
}
