/**
 * UI-facing types for the /mcp settings flow. Server connection and
 * config types are defined once in src/services/mcp/types.ts and
 * re-exported from here so React components can `import type` without
 * pulling in the services-layer module.
 *
 * UI-specific additions (`ServerInfo`, `AgentMcpServerInfo`,
 * `MCPViewState`) are derived from every construction site in
 * src/components/mcp/MCPSettings.tsx, MCPListPanel.tsx,
 * MCPStdioServerMenu.tsx, MCPRemoteServerMenu.tsx and
 * src/services/mcp/utils.ts.
 */

import type {
  McpClaudeAIProxyServerConfig,
  McpHTTPServerConfig,
  McpSSEServerConfig,
  McpStdioServerConfig,
} from '../../services/mcp/types.js'
import type {
  ConnectedMCPServer,
  DisabledMCPServer,
  FailedMCPServer,
  MCPServerConnection,
  NeedsAuthMCPServer,
  PendingMCPServer,
} from '../../services/mcp/types.js'

// Re-export the services-layer types so component-layer consumers can
// import them from one place.
export type {
  ConnectedMCPServer,
  DisabledMCPServer,
  FailedMCPServer,
  MCPServerConnection,
  NeedsAuthMCPServer,
  PendingMCPServer,
} from '../../services/mcp/types.js'
export type {
  ConfigScope,
  McpClaudeAIProxyServerConfig,
  McpHTTPServerConfig,
  McpJsonConfig,
  McpSdkServerConfig,
  McpServerConfig,
  McpSSEIDEServerConfig,
  McpSSEServerConfig,
  McpStdioServerConfig,
  McpWebSocketIDEServerConfig,
  McpWebSocketServerConfig,
  ScopedMcpServerConfig,
  SerializedClient,
  SerializedTool,
  ServerResource,
  Transport,
} from '../../services/mcp/types.js'
export {
  ConfigScopeSchema,
  McpJsonConfigSchema,
  McpServerConfigSchema,
  McpStdioServerConfigSchema,
  TransportSchema,
} from '../../services/mcp/types.js'

import type { ConfigScope } from '../../services/mcp/types.js'

/**
 * Per-transport UI row shown in `<MCPListPanel>`. The `client` field holds
 * the corresponding MCPServerConnection so components can read its
 * status + capabilities.
 */
type BaseServerInfo = {
  name: string
  client: MCPServerConnection
  scope: ConfigScope
}

export type StdioServerInfo = BaseServerInfo & {
  transport: 'stdio'
  config: McpStdioServerConfig
}

export type SSEServerInfo = BaseServerInfo & {
  transport: 'sse'
  config: McpSSEServerConfig
  isAuthenticated?: boolean
}

export type HTTPServerInfo = BaseServerInfo & {
  transport: 'http'
  config: McpHTTPServerConfig
  isAuthenticated?: boolean
}

export type ClaudeAIServerInfo = BaseServerInfo & {
  transport: 'claudeai-proxy'
  config: McpClaudeAIProxyServerConfig
  isAuthenticated?: boolean
}

/** Union of all user-facing server rows rendered by MCPListPanel. */
export type ServerInfo =
  | StdioServerInfo
  | SSEServerInfo
  | HTTPServerInfo
  | ClaudeAIServerInfo

/**
 * Agent-defined MCP server pulled out of an agent's frontmatter. Rendered
 * in the MCPListPanel agents section.
 */
export type AgentMcpServerInfo = {
  name: string
  sourceAgents: string[]
  transport: 'stdio' | 'sse' | 'http' | 'ws'
  command?: string
  url?: string
  needsAuth: boolean
  isAuthenticated?: boolean
}

/**
 * Top-level view-state discriminated union for `<MCPSettings>`. Each
 * `setViewState(…)` call in MCPSettings.tsx corresponds to one variant.
 */
export type MCPViewState =
  | { type: 'list'; defaultTab?: string }
  | { type: 'server-menu'; server: ServerInfo }
  | { type: 'server-tools'; server: ServerInfo }
  | { type: 'server-tool-detail'; server: ServerInfo; toolIndex: number }
  | { type: 'agent-server-menu'; agentServer: AgentMcpServerInfo }
