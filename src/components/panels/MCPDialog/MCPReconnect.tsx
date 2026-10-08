/**
 * Host-agnostic immediate MCP reconnect: the server-existence check and the
 * reconnect dispatch come in as callbacks so this panel has no store. The
 * host adapter (components/mcp/MCPReconnect.tsx) backs serverExists with a
 * store.getState() snapshot read and onReconnect with the connection
 * manager's reconnect action.
 */

import figures from 'figures'
import React, { useEffect, useState } from 'react'
import type { CommandResultDisplay } from '../../../commands.js'
import { Box, color, Text, useTheme } from '../../../ink.js'
import type { McpActions } from '../../../services/mcp/mcpActions.js'
import { Spinner } from '../../Spinner.js'

type Props = {
  serverName: string
  /** Snapshot existence check — must not subscribe to mcp.clients. */
  serverExists: (serverName: string) => boolean
  onReconnect: McpActions['reconnectMcpServer']
  onComplete: (
    result?: string,
    options?: { display?: CommandResultDisplay },
  ) => void
}

export function MCPReconnect({
  serverName,
  serverExists,
  onReconnect,
  onComplete,
}: Props): React.ReactNode {
  const [theme] = useTheme()
  const [isReconnecting, setIsReconnecting] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    async function attemptReconnect() {
      try {
        // Check if server exists via the snapshot callback rather than a
        // reactive subscription so this effect does not re-fire when
        // onReconnect updates mcp.clients via onConnectionAttempt.
        if (!serverExists(serverName)) {
          setError(`MCP server "${serverName}" not found`)
          setIsReconnecting(false)
          onComplete(`MCP server "${serverName}" not found`)
          return
        }

        // Attempt reconnection
        const result = await onReconnect(serverName)

        switch (result.client.type) {
          case 'connected':
            setIsReconnecting(false)
            onComplete(`Successfully reconnected to ${serverName}`)
            break
          case 'needs-auth':
            setError(`${serverName} requires authentication`)
            setIsReconnecting(false)
            onComplete(
              `${serverName} requires authentication. Use /mcp to authenticate.`,
            )
            break
          case 'pending':
          case 'failed':
          case 'disabled':
            setError(`Failed to reconnect to ${serverName}`)
            setIsReconnecting(false)
            onComplete(`Failed to reconnect to ${serverName}`)
            break
        }
      } catch (err) {
        // Only catch actual errors (like server not found)
        const errorMessage = err instanceof Error ? err.message : String(err)
        setError(errorMessage)
        setIsReconnecting(false)
        onComplete(`Error: ${errorMessage}`)
      }
    }

    void attemptReconnect()
  }, [serverName, onReconnect, serverExists, onComplete])

  if (isReconnecting) {
    return (
      <Box flexDirection="column" gap={1} padding={1}>
        <Text color="text">
          Reconnecting to <Text bold>{serverName}</Text>
        </Text>
        <Box>
          <Spinner />
          <Text> Establishing connection to MCP server</Text>
        </Box>
      </Box>
    )
  }

  if (error) {
    return (
      <Box flexDirection="column" gap={1} padding={1}>
        <Box>
          <Text>{color('error', theme)(figures.cross)} </Text>
          <Text color="error">Failed to reconnect to {serverName}</Text>
        </Box>
        <Text dimColor>Error: {error}</Text>
      </Box>
    )
  }

  return null
}
