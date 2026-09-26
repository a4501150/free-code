import React from 'react'
import { MCPSettings } from '../../components/mcp/index.js'
import { MCPReconnect } from '../../components/mcp/MCPReconnect.js'
import { getMcpActions } from '../../services/mcp/mcpActions.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import type { ToolUseContext } from '../../Tool.js'
import type { LocalJSXCommandContext } from '../../types/command.js'

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: ToolUseContext & LocalJSXCommandContext,
  args?: string,
): Promise<React.ReactNode> {
  if (args) {
    const parts = args.trim().split(/\s+/)

    // Allow /mcp no-redirect to bypass the redirect for testing
    if (parts[0] === 'no-redirect') {
      return <MCPSettings onComplete={onDone} />
    }

    if (parts[0] === 'reconnect' && parts[1]) {
      return (
        <MCPReconnect
          serverName={parts.slice(1).join(' ')}
          onComplete={onDone}
        />
      )
    }

    if (parts[0] === 'enable' || parts[0] === 'disable') {
      const isEnabling = parts[0] === 'enable'
      const target = parts.length > 1 ? parts.slice(1).join(' ') : 'all'
      const actions = getMcpActions()
      if (!actions) {
        onDone('MCP connection manager is not active')
        return null
      }
      const clients = context
        .getAppState()
        .mcp.clients.filter(c => c.name !== 'ide')
      const toToggle =
        target === 'all'
          ? clients.filter(c =>
              isEnabling ? c.type === 'disabled' : c.type !== 'disabled',
            )
          : clients.filter(c => c.name === target)

      if (toToggle.length === 0) {
        onDone(
          target === 'all'
            ? `All MCP servers are already ${isEnabling ? 'enabled' : 'disabled'}`
            : `MCP server "${target}" not found`,
        )
        return null
      }

      for (const s of toToggle) {
        void actions.toggleMcpServer(s.name)
      }
      onDone(
        target === 'all'
          ? `${isEnabling ? 'Enabled' : 'Disabled'} ${toToggle.length} MCP server(s)`
          : `MCP server "${target}" ${isEnabling ? 'enabled' : 'disabled'}`,
      )
      return null
    }
  }

  return <MCPSettings onComplete={onDone} />
}
