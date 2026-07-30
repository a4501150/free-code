import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type {
  Resource,
  ServerCapabilities,
} from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod/v4'
// Configuration schemas and types
export const ConfigScopeSchema = z.enum([
  'local',
  'user',
  'project',
  'dynamic',
  'claudeai',
])
export type ConfigScope = z.infer<typeof ConfigScopeSchema>

export const TransportSchema = z.enum([
  'stdio',
  'sse',
  'sse-ide',
  'http',
  'ws',
  'sdk',
])
export type Transport = z.infer<typeof TransportSchema>

export const McpStdioServerConfigSchema = z.object({
  type: z.literal('stdio').optional(), // Optional for backwards compatibility
  command: z.string().min(1, 'Command cannot be empty'),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).optional(),
  includeTools: z.array(z.string()).optional(),
  excludeTools: z.array(z.string()).optional(),
})

// Cross-App Access (XAA / SEP-990): just a per-server flag. IdP connection
// details (issuer, clientId, callbackPort) come from settings.xaaIdp — configured
// once, shared across all XAA-enabled servers. clientId/clientSecret (parent
// oauth config + keychain slot) are for the MCP server's AS.
const McpXaaConfigSchema = z.boolean()

const McpOAuthConfigSchema = z.object({
  clientId: z.string().optional(),
  callbackPort: z.number().int().positive().optional(),
  authServerMetadataUrl: z
    .string()
    .url()
    .startsWith('https://', {
      message: 'authServerMetadataUrl must use https://',
    })
    .optional(),
  xaa: McpXaaConfigSchema.optional(),
})

export const McpSSEServerConfigSchema = z.object({
  type: z.literal('sse'),
  url: z.string(),
  headers: z.record(z.string(), z.string()).optional(),
  headersHelper: z.string().optional(),
  oauth: McpOAuthConfigSchema.optional(),
  includeTools: z.array(z.string()).optional(),
  excludeTools: z.array(z.string()).optional(),
})

// Internal-only server type for IDE extensions
export const McpSSEIDEServerConfigSchema = z.object({
  type: z.literal('sse-ide'),
  url: z.string(),
  ideName: z.string(),
  ideRunningInWindows: z.boolean().optional(),
  includeTools: z.array(z.string()).optional(),
  excludeTools: z.array(z.string()).optional(),
})

// Internal-only server type for IDE extensions
export const McpWebSocketIDEServerConfigSchema = z.object({
  type: z.literal('ws-ide'),
  url: z.string(),
  ideName: z.string(),
  authToken: z.string().optional(),
  ideRunningInWindows: z.boolean().optional(),
  includeTools: z.array(z.string()).optional(),
  excludeTools: z.array(z.string()).optional(),
})

export const McpHTTPServerConfigSchema = z.object({
  type: z.literal('http'),
  url: z.string(),
  headers: z.record(z.string(), z.string()).optional(),
  headersHelper: z.string().optional(),
  oauth: McpOAuthConfigSchema.optional(),
  includeTools: z.array(z.string()).optional(),
  excludeTools: z.array(z.string()).optional(),
})

export const McpWebSocketServerConfigSchema = z.object({
  type: z.literal('ws'),
  url: z.string(),
  headers: z.record(z.string(), z.string()).optional(),
  headersHelper: z.string().optional(),
  includeTools: z.array(z.string()).optional(),
  excludeTools: z.array(z.string()).optional(),
})

export const McpSdkServerConfigSchema = z.object({
  type: z.literal('sdk'),
  name: z.string(),
  includeTools: z.array(z.string()).optional(),
  excludeTools: z.array(z.string()).optional(),
})

// Config type for Claude.ai proxy servers
export const McpClaudeAIProxyServerConfigSchema = z.object({
  type: z.literal('claudeai-proxy'),
  url: z.string(),
  id: z.string(),
  includeTools: z.array(z.string()).optional(),
  excludeTools: z.array(z.string()).optional(),
})

export const McpServerConfigSchema = z.union([
  McpStdioServerConfigSchema,
  McpSSEServerConfigSchema,
  McpSSEIDEServerConfigSchema,
  McpWebSocketIDEServerConfigSchema,
  McpHTTPServerConfigSchema,
  McpWebSocketServerConfigSchema,
  McpSdkServerConfigSchema,
  McpClaudeAIProxyServerConfigSchema,
])

export type McpStdioServerConfig = z.infer<typeof McpStdioServerConfigSchema>
export type McpSSEServerConfig = z.infer<typeof McpSSEServerConfigSchema>
export type McpSSEIDEServerConfig = z.infer<typeof McpSSEIDEServerConfigSchema>
export type McpWebSocketIDEServerConfig = z.infer<
  typeof McpWebSocketIDEServerConfigSchema
>
export type McpHTTPServerConfig = z.infer<typeof McpHTTPServerConfigSchema>
export type McpWebSocketServerConfig = z.infer<
  typeof McpWebSocketServerConfigSchema
>
export type McpSdkServerConfig = z.infer<typeof McpSdkServerConfigSchema>
export type McpClaudeAIProxyServerConfig = z.infer<
  typeof McpClaudeAIProxyServerConfigSchema
>
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>

export type ScopedMcpServerConfig = McpServerConfig & {
  scope: ConfigScope
  // For plugin-provided servers: the providing plugin's LoadedPlugin.source
  // (e.g. 'slack@anthropic'). Stashed at config-build time so the channel
  // gate doesn't have to race AppState.plugins.enabled hydration.
  pluginSource?: string
}

export const McpJsonConfigSchema = z.object({
  mcpServers: z.record(z.string(), McpServerConfigSchema),
})

export type McpJsonConfig = z.infer<typeof McpJsonConfigSchema>

// Server connection types
export type ConnectedMCPServer = {
  client: Client
  name: string
  type: 'connected'
  capabilities: ServerCapabilities
  serverInfo?: {
    name: string
    version: string
  }
  instructions?: string
  config: ScopedMcpServerConfig
  cleanup: () => Promise<void>
}

export type FailedMCPServer = {
  name: string
  type: 'failed'
  config: ScopedMcpServerConfig
  error?: string
}

export type NeedsAuthMCPServer = {
  name: string
  type: 'needs-auth'
  config: ScopedMcpServerConfig
}

export type PendingMCPServer = {
  name: string
  type: 'pending'
  config: ScopedMcpServerConfig
  reconnectAttempt?: number
  maxReconnectAttempts?: number
}

export type DisabledMCPServer = {
  name: string
  type: 'disabled'
  config: ScopedMcpServerConfig
}

export type MCPServerConnection =
  | ConnectedMCPServer
  | FailedMCPServer
  | NeedsAuthMCPServer
  | PendingMCPServer
  | DisabledMCPServer

// Resource types
export type ServerResource = Resource & { server: string }

// MCP CLI State types
export interface SerializedTool {
  name: string
  description: string
  inputJSONSchema?: {
    [x: string]: unknown
    type: 'object'
    properties?: {
      [x: string]: unknown
    }
  }
  isMcp?: boolean
  originalToolName?: string // Original unnormalized tool name from MCP server
}

export interface SerializedClient {
  name: string
  type: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled'
  capabilities?: ServerCapabilities
}

export interface MCPCliState {
  clients: SerializedClient[]
  configs: Record<string, ScopedMcpServerConfig>
  tools: SerializedTool[]
  resources: Record<string, ServerResource[]>
  normalizedNames?: Record<string, string> // Maps normalized names to original names
}
