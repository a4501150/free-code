/**
 * REPL host adapter for the MCP tool list: reads mcp.tools from AppState and
 * renders the host-agnostic panels/MCPDialog/MCPToolListView component,
 * keeping the original props contract for the /mcp and /plugin mounts.
 */

import React from 'react'
import { useAppState } from '../../state/AppState.js'
import type { Tool } from '../../Tool.js'
import { MCPToolListView as MCPToolListViewPanel } from '../panels/MCPDialog/MCPToolListView.js'
import type { ServerInfo } from './types.js'

type Props = {
  server: ServerInfo
  onSelectTool: (tool: Tool, index: number) => void
  onBack: () => void
}

export function MCPToolListView({
  server,
  onSelectTool,
  onBack,
}: Props): React.ReactNode {
  const mcpTools = useAppState(s => s.mcp.tools)

  return (
    <MCPToolListViewPanel
      server={server}
      tools={mcpTools}
      onSelectTool={onSelectTool}
      onBack={onBack}
    />
  )
}
