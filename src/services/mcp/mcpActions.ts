import type { Command } from '../../commands.js'
import type { Tool } from '../../Tool.js'
import type { MCPServerConnection, ServerResource } from './types.js'

/**
 * Module-level registry for the MCP connect/disconnect actions that used to
 * travel through React context. The MCPConnectionManager (or any host running
 * useManageMCPConnections) registers its callbacks at mount; readers that live
 * outside the React tree — the `/mcp enable|disable` command path, or print
 * mode's control handler — reach them without a component to borrow context
 * from. Registration is owned by one provider at a time: register() returns a
 * release function that only clears the entry if it is still the registered
 * one, so overlapping mount/unmount between the two host sites cannot erase a
 * fresher registration.
 */
export type McpActions = {
  reconnectMcpServer: (serverName: string) => Promise<{
    client: MCPServerConnection
    tools: Tool[]
    commands: Command[]
    resources?: ServerResource[]
  }>
  toggleMcpServer: (serverName: string) => Promise<void>
}

type Registration = { actions: McpActions; owner: symbol }

let registration: Registration | null = null

export function registerMcpActions(actions: McpActions): () => void {
  const owner = Symbol('mcp-actions')
  registration = { actions, owner }
  return () => {
    if (registration?.owner === owner) {
      registration = null
    }
  }
}

/** Current actions, or null when no MCPConnectionManager is mounted. */
export function getMcpActions(): McpActions | null {
  return registration?.actions ?? null
}
