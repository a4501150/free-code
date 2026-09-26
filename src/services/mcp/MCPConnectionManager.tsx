import React, { type ReactNode, useEffect } from 'react'
import type { ScopedMcpServerConfig } from './types.js'
import { registerMcpActions } from './mcpActions.js'
import { useManageMCPConnections } from './useManageMCPConnections.js'
export { useMcpReconnect, useMcpToggleEnabled } from './MCPConnectionHooks.js'

interface MCPConnectionManagerProps {
  children: ReactNode
  dynamicMcpConfig: Record<string, ScopedMcpServerConfig> | undefined
  isStrictMcpConfig: boolean
}

/**
 * Runs useManageMCPConnections and publishes its reconnect/toggle callbacks
 * through the mcpActions registry (see mcpActions.ts) — no context provider,
 * so non-React callers can reach the same functions.
 */
export function MCPConnectionManager({
  children,
  dynamicMcpConfig,
  isStrictMcpConfig,
}: MCPConnectionManagerProps): React.ReactNode {
  const { reconnectMcpServer, toggleMcpServer } = useManageMCPConnections(
    dynamicMcpConfig,
    isStrictMcpConfig,
  )

  useEffect(() => {
    return registerMcpActions({ reconnectMcpServer, toggleMcpServer })
  }, [reconnectMcpServer, toggleMcpServer])

  return <>{children}</>
}
