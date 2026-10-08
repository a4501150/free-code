/**
 * Host-agnostic /mcp settings flow: renders from the raw MCP clients,
 * tools, commands and resources plus the agent definitions, and reaches the
 * connection manager / store write-back through callbacks. The host adapter
 * (components/mcp/MCPSettings.tsx) reads AppState and wires them.
 */

import React, { useEffect, useMemo } from 'react'
import type { Command, CommandResultDisplay } from '../../../commands.js'
import { ClaudeAuthProvider } from '../../../services/mcp/auth.js'
import type { McpActions } from '../../../services/mcp/mcpActions.js'
import type {
  McpClaudeAIProxyServerConfig,
  McpHTTPServerConfig,
  McpSSEServerConfig,
  McpStdioServerConfig,
  MCPServerConnection,
  ServerResource,
} from '../../../services/mcp/types.js'
import {
  extractAgentMcpServers,
  filterToolsByServer,
} from '../../../services/mcp/utils.js'
import type { AgentDefinition } from '../../../tools/AgentTool/loadAgentsDir.js'
import type { Tool } from '../../../Tool.js'
import { MCPAgentServerMenu } from '../../mcp/MCPAgentServerMenu.js'
import { MCPListPanel } from '../../mcp/MCPListPanel.js'
import type {
  AgentMcpServerInfo,
  MCPViewState,
  ServerInfo,
} from '../../mcp/types.js'
import { MCPToolDetailView } from '../../mcp/MCPToolDetailView.js'
import { MCPToolListView as MCPToolListViewPanel } from './MCPToolListView.js'
import { MCPRemoteServerMenu as MCPRemoteServerMenuPanel } from './MCPRemoteServerMenu.js'
import { MCPStdioServerMenu as MCPStdioServerMenuPanel } from './MCPStdioServerMenu.js'

type Props = {
  mcpClients: MCPServerConnection[]
  mcpTools: Tool[]
  mcpCommands: Command[]
  mcpResources: Record<string, ServerResource[]>
  /** All agent definitions — agent-scoped MCP servers are derived here. */
  agentDefinitions: AgentDefinition[]
  onReconnect: McpActions['reconnectMcpServer']
  onToggleEnabled: McpActions['toggleMcpServer']
  /** Marks a clear-auth'd server needs-auth/failed and drops its capabilities. */
  onServerDisconnected: (
    serverName: string,
    clientType: 'needs-auth' | 'failed',
  ) => void
  onComplete: (
    result?: string,
    options?: { display?: CommandResultDisplay },
  ) => void
}

export function MCPSettings({
  mcpClients,
  mcpTools,
  mcpCommands,
  mcpResources,
  agentDefinitions,
  onReconnect,
  onToggleEnabled,
  onServerDisconnected,
  onComplete,
}: Props): React.ReactNode {
  const [viewState, setViewState] = React.useState<MCPViewState>({
    type: 'list',
  })
  const [servers, setServers] = React.useState<ServerInfo[]>([])

  // Extract agent-specific MCP servers from agent definitions
  const agentMcpServers = useMemo(
    () => extractAgentMcpServers(agentDefinitions),
    [agentDefinitions],
  )

  const filteredClients = React.useMemo(
    () =>
      mcpClients
        .filter(client => client.name !== 'ide')
        .sort((a, b) => a.name.localeCompare(b.name)),
    [mcpClients],
  )

  React.useEffect(() => {
    let cancelled = false
    async function prepareServers() {
      const serverInfos = await Promise.all(
        filteredClients.map(async client => {
          const scope = client.config.scope
          const isSSE = client.config.type === 'sse'
          const isHTTP = client.config.type === 'http'
          const isClaudeAIProxy = client.config.type === 'claudeai-proxy'
          let isAuthenticated: boolean | undefined = undefined

          if (isSSE || isHTTP) {
            const authProvider = new ClaudeAuthProvider(
              client.name,
              client.config as McpSSEServerConfig | McpHTTPServerConfig,
            )
            const tokens = await authProvider.tokens()
            // Server is authenticated if:
            // 1. It has OAuth tokens, OR
            // 2. It's connected and has tools (meaning it's working, regardless of auth method)
            const hasToolsAndConnected =
              client.type === 'connected' &&
              filterToolsByServer(mcpTools, client.name).length > 0
            isAuthenticated = Boolean(tokens) || hasToolsAndConnected
          }

          const baseInfo = {
            name: client.name,
            client,
            scope,
          }

          if (isClaudeAIProxy) {
            return {
              ...baseInfo,
              transport: 'claudeai-proxy' as const,
              isAuthenticated: false,
              config: client.config as McpClaudeAIProxyServerConfig,
            }
          } else if (isSSE) {
            return {
              ...baseInfo,
              transport: 'sse' as const,
              isAuthenticated,
              config: client.config as McpSSEServerConfig,
            }
          } else if (isHTTP) {
            return {
              ...baseInfo,
              transport: 'http' as const,
              isAuthenticated,
              config: client.config as McpHTTPServerConfig,
            }
          } else {
            return {
              ...baseInfo,
              transport: 'stdio' as const,
              config: client.config as McpStdioServerConfig,
            }
          }
        }),
      )

      if (cancelled) return
      setServers(serverInfos)
    }

    void prepareServers()
    return () => {
      cancelled = true
    }
  }, [filteredClients, mcpTools])

  useEffect(() => {
    if (servers.length === 0 && filteredClients.length > 0) {
      // Still loading
      return
    }

    // Only show "no servers" message if no regular servers AND no agent servers
    if (servers.length === 0 && agentMcpServers.length === 0) {
      onComplete(
        'No MCP servers configured. Please run /doctor if this is unexpected. Otherwise, run `claude mcp --help` or visit https://code.claude.com/docs/en/mcp to learn more.',
      )
    }
  }, [
    servers.length,
    filteredClients.length,
    agentMcpServers.length,
    onComplete,
  ])

  switch (viewState.type) {
    case 'list':
      return (
        <MCPListPanel
          servers={servers}
          agentServers={agentMcpServers}
          onSelectServer={server =>
            setViewState({ type: 'server-menu', server })
          }
          onSelectAgentServer={(agentServer: AgentMcpServerInfo) =>
            setViewState({ type: 'agent-server-menu', agentServer })
          }
          onComplete={onComplete}
          defaultTab={viewState.defaultTab}
        />
      )

    case 'server-menu': {
      const serverTools = filterToolsByServer(mcpTools, viewState.server.name)

      const defaultTab =
        viewState.server.transport === 'claudeai-proxy'
          ? 'claude.ai'
          : 'Claude Code'

      if (viewState.server.transport === 'stdio') {
        return (
          <MCPStdioServerMenuPanel
            server={viewState.server}
            serverToolsCount={serverTools.length}
            commands={mcpCommands}
            resources={mcpResources}
            onReconnect={onReconnect}
            onToggleEnabled={onToggleEnabled}
            onViewTools={() =>
              setViewState({ type: 'server-tools', server: viewState.server })
            }
            onCancel={() => setViewState({ type: 'list', defaultTab })}
            onComplete={onComplete}
          />
        )
      } else {
        return (
          <MCPRemoteServerMenuPanel
            server={viewState.server}
            serverToolsCount={serverTools.length}
            commands={mcpCommands}
            resources={mcpResources}
            onReconnect={onReconnect}
            onToggleEnabled={onToggleEnabled}
            onServerDisconnected={onServerDisconnected}
            onViewTools={() =>
              setViewState({ type: 'server-tools', server: viewState.server })
            }
            onCancel={() => setViewState({ type: 'list', defaultTab })}
            onComplete={onComplete}
          />
        )
      }
    }

    case 'server-tools':
      return (
        <MCPToolListViewPanel
          server={viewState.server}
          tools={mcpTools}
          onSelectTool={(_, index) =>
            setViewState({
              type: 'server-tool-detail',
              server: viewState.server,
              toolIndex: index,
            })
          }
          onBack={() =>
            setViewState({ type: 'server-menu', server: viewState.server })
          }
        />
      )

    case 'server-tool-detail': {
      const serverTools = filterToolsByServer(mcpTools, viewState.server.name)
      const tool = serverTools[viewState.toolIndex]
      if (!tool) {
        setViewState({ type: 'server-tools', server: viewState.server })
        return null
      }
      return (
        <MCPToolDetailView
          tool={tool}
          server={viewState.server}
          onBack={() =>
            setViewState({ type: 'server-tools', server: viewState.server })
          }
        />
      )
    }

    case 'agent-server-menu':
      return (
        <MCPAgentServerMenu
          agentServer={viewState.agentServer}
          onCancel={() => setViewState({ type: 'list', defaultTab: 'Agents' })}
          onComplete={onComplete}
        />
      )
  }
}
