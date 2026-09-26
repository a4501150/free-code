import { getMcpActions, type McpActions } from './mcpActions.js'

/**
 * Accessors for the actions published by MCPConnectionManager via the
 * mcpActions registry. Function shape (not hook internals) — kept as
 * `use*` names because every consumer calls them from component bodies.
 */
export function useMcpReconnect(): McpActions['reconnectMcpServer'] {
  const actions = getMcpActions()
  if (!actions) {
    throw new Error('useMcpReconnect must be used within MCPConnectionManager')
  }
  return actions.reconnectMcpServer
}

export function useMcpToggleEnabled(): McpActions['toggleMcpServer'] {
  const actions = getMcpActions()
  if (!actions) {
    throw new Error(
      'useMcpToggleEnabled must be used within MCPConnectionManager',
    )
  }
  return actions.toggleMcpServer
}
