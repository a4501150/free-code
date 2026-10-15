import uniqBy from 'lodash-es/uniqBy.js'
import { useMemo } from 'react'
import type { MCPServerConnection } from '../services/mcp/types.js'

export function mergeClients(
  initialClients: MCPServerConnection[] | undefined,
  mcpClients: readonly MCPServerConnection[] | undefined,
): MCPServerConnection[] {
  if (mcpClients && mcpClients.length > 0) {
    // Initial clients win name conflicts (uniqBy keeps first occurrence):
    // a startup connection the host deliberately built overrides a same-
    // named store write.
    return initialClients
      ? uniqBy([...initialClients, ...mcpClients], 'name')
      : [...mcpClients]
  }
  return initialClients ?? []
}

export function useMergedClients(
  initialClients: MCPServerConnection[] | undefined,
  mcpClients: MCPServerConnection[] | undefined,
): MCPServerConnection[] {
  return useMemo(
    () => mergeClients(initialClients, mcpClients),
    [initialClients, mcpClients],
  )
}
