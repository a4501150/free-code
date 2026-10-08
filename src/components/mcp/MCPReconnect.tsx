/**
 * REPL host adapter for the immediate `/mcp reconnect <server>` flow: backs
 * the existence check with a store.getState() snapshot (deliberately not a
 * reactive subscription — see the panel's effect comment) and wires the
 * connection manager's reconnect action, then renders the host-agnostic
 * panels/MCPDialog/MCPReconnect component.
 */

import React, { useCallback } from 'react'
import type { CommandResultDisplay } from '../../commands.js'
import { useMcpReconnect } from '../../services/mcp/MCPConnectionManager.js'
import { useAppStateStore } from '../../state/AppState.js'
import { MCPReconnect as MCPReconnectPanel } from '../panels/MCPDialog/MCPReconnect.js'

type Props = {
  serverName: string
  onComplete: (
    result?: string,
    options?: { display?: CommandResultDisplay },
  ) => void
}

export function MCPReconnect({
  serverName,
  onComplete,
}: Props): React.ReactNode {
  const store = useAppStateStore()
  const reconnectMcpServer = useMcpReconnect()

  // Read via store.getState() instead of a reactive selector so the panel's
  // effect does not re-fire when onReconnect updates mcp.clients.
  const serverExists = useCallback(
    (name: string): boolean =>
      store.getState().mcp.clients.some(c => c.name === name),
    [store],
  )

  return (
    <MCPReconnectPanel
      serverName={serverName}
      serverExists={serverExists}
      onReconnect={reconnectMcpServer}
      onComplete={onComplete}
    />
  )
}
