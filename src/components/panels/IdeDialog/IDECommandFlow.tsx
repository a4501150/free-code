import * as path from 'path'
import React, { useCallback, useEffect, useRef, useState } from 'react'

import type { CommandResultDisplay } from '../../../commands.js'
import { Select } from '../../CustomSelect/index.js'
import { Dialog } from '../../design-system/Dialog.js'
import {
  IdeAutoConnectDialog,
  IdeDisableAutoConnectDialog,
  shouldShowAutoConnectDialog,
  shouldShowDisableAutoConnectDialog,
} from '../../IdeAutoConnectDialog.js'
import { Box, Text } from '../../../ink.js'
import { clearServerCache } from '../../../services/mcp/client.js'
import type {
  MCPServerConnection,
  ScopedMcpServerConfig,
} from '../../../services/mcp/types.js'
import { getCwd } from '../../../utils/cwd.js'
import {
  type DetectedIDEInfo,
  isSupportedJetBrainsTerminal,
  isSupportedTerminal,
} from '../../../utils/ide.js'

export type IDECommandFlowProps = {
  availableIDEs: DetectedIDEInfo[]
  unavailableIDEs: DetectedIDEInfo[]
  currentIDE: DetectedIDEInfo | null
  dynamicMcpConfig?: Record<string, ScopedMcpServerConfig>
  onChangeDynamicMcpConfig?: (
    config: Record<string, ScopedMcpServerConfig>,
  ) => void
  onDone: (
    result?: string,
    options?: { display?: CommandResultDisplay },
  ) => void
  /**
   * The 'ide' MCP client connection from app state
   * (`AppState.mcp.clients.find(c => c.name === 'ide')`), if present.
   */
  ideClient: MCPServerConnection | undefined
  /**
   * Removes the 'ide' client and its `mcp__ide__` tools/commands from app
   * state (host-side store write).
   */
  onRemoveIdeClient: () => void
}

type IDEScreenProps = {
  availableIDEs: DetectedIDEInfo[]
  unavailableIDEs: DetectedIDEInfo[]
  selectedIDE?: DetectedIDEInfo | null
  onClose: () => void
  onSelect: (ide?: DetectedIDEInfo) => void
}

function IDEScreen({
  availableIDEs,
  unavailableIDEs,
  selectedIDE,
  onClose,
  onSelect,
}: IDEScreenProps): React.ReactNode {
  const [selectedValue, setSelectedValue] = useState(
    selectedIDE?.port?.toString() ?? 'None',
  )
  const [showAutoConnectDialog, setShowAutoConnectDialog] = useState(false)
  const [showDisableAutoConnectDialog, setShowDisableAutoConnectDialog] =
    useState(false)

  const handleSelectIDE = useCallback(
    (value: string) => {
      if (value !== 'None' && shouldShowAutoConnectDialog()) {
        setShowAutoConnectDialog(true)
      } else if (value === 'None' && shouldShowDisableAutoConnectDialog()) {
        setShowDisableAutoConnectDialog(true)
      } else {
        onSelect(availableIDEs.find(ide => ide.port === parseInt(value)))
      }
    },
    [availableIDEs, onSelect],
  )

  const ideCounts = availableIDEs.reduce<Record<string, number>>((acc, ide) => {
    acc[ide.name] = (acc[ide.name] || 0) + 1
    return acc
  }, {})

  const options = availableIDEs
    .map(ide => {
      const hasMultipleInstances = (ideCounts[ide.name] || 0) > 1
      const showWorkspace =
        hasMultipleInstances && ide.workspaceFolders.length > 0

      return {
        label: ide.name,
        value: ide.port.toString(),
        description: showWorkspace
          ? formatWorkspaceFolders(ide.workspaceFolders)
          : undefined,
      }
    })
    .concat([{ label: 'None', value: 'None', description: undefined }])

  if (showAutoConnectDialog) {
    return (
      <IdeAutoConnectDialog onComplete={() => handleSelectIDE(selectedValue)} />
    )
  }

  if (showDisableAutoConnectDialog) {
    return (
      <IdeDisableAutoConnectDialog
        onComplete={() => {
          // Always disconnect when user selects "None", regardless of their
          // choice about disabling auto-connect
          onSelect(undefined)
        }}
      />
    )
  }

  return (
    <Dialog
      title="Select IDE"
      subtitle="Connect to an IDE for integrated development features."
      onCancel={onClose}
      color="ide"
    >
      <Box flexDirection="column">
        {availableIDEs.length === 0 && (
          <Text dimColor>
            {isSupportedJetBrainsTerminal()
              ? 'No available IDEs detected. Please install the plugin and restart your IDE:\n' +
                'https://docs.claude.com/s/claude-code-jetbrains'
              : 'No available IDEs detected. Make sure your IDE has the Claude Code extension or plugin installed and is running.'}
          </Text>
        )}

        {availableIDEs.length !== 0 && (
          <Select
            defaultValue={selectedValue}
            defaultFocusValue={selectedValue}
            options={options}
            onChange={value => {
              setSelectedValue(value)
              handleSelectIDE(value)
            }}
          />
        )}
        {availableIDEs.length !== 0 &&
          availableIDEs.some(
            ide => ide.name === 'VS Code' || ide.name === 'Visual Studio Code',
          ) && (
            <Box marginTop={1}>
              <Text color="warning">
                Note: Only one Claude Code instance can be connected to VS Code
                at a time.
              </Text>
            </Box>
          )}
        {availableIDEs.length !== 0 && !isSupportedTerminal() && (
          <Box marginTop={1}>
            <Text dimColor>
              Tip: You can enable auto-connect to IDE in /config or with the
              --ide flag
            </Text>
          </Box>
        )}

        {unavailableIDEs.length > 0 && (
          <Box marginTop={1} flexDirection="column">
            <Text dimColor>
              Found {unavailableIDEs.length} other running IDE(s). However,
              their workspace/project directories do not match the current cwd.
            </Text>
            <Box marginTop={1} flexDirection="column">
              {unavailableIDEs.map((ide, index) => (
                <Box key={index} paddingLeft={3}>
                  <Text dimColor>
                    • {ide.name}: {formatWorkspaceFolders(ide.workspaceFolders)}
                  </Text>
                </Box>
              ))}
            </Box>
          </Box>
        )}
      </Box>
    </Dialog>
  )
}

// Connection timeout slightly longer than the 30s MCP connection timeout
const IDE_CONNECTION_TIMEOUT_MS = 35000

export function IDECommandFlow({
  availableIDEs,
  unavailableIDEs,
  currentIDE,
  dynamicMcpConfig,
  onChangeDynamicMcpConfig,
  onDone,
  ideClient,
  onRemoveIdeClient,
}: IDECommandFlowProps): React.ReactNode {
  const [connectingIDE, setConnectingIDE] = useState<DetectedIDEInfo | null>(
    null,
  )
  const isFirstCheckRef = useRef(true)

  // Watch for connection result
  useEffect(() => {
    if (!connectingIDE) return
    // Skip the first check — it reflects stale state from before the
    // config change was dispatched
    if (isFirstCheckRef.current) {
      isFirstCheckRef.current = false
      return
    }
    if (!ideClient || ideClient.type === 'pending') return
    if (ideClient.type === 'connected') {
      onDone(`Connected to ${connectingIDE.name}.`)
    } else if (ideClient.type === 'failed') {
      onDone(`Failed to connect to ${connectingIDE.name}.`)
    }
  }, [ideClient, connectingIDE, onDone])

  // Timeout fallback
  useEffect(() => {
    if (!connectingIDE) return
    const timer = setTimeout(
      onDone,
      IDE_CONNECTION_TIMEOUT_MS,
      `Connection to ${connectingIDE.name} timed out.`,
    )
    return () => clearTimeout(timer)
  }, [connectingIDE, onDone])

  const handleSelectIDE = useCallback(
    (selectedIDE?: DetectedIDEInfo) => {
      if (!onChangeDynamicMcpConfig) {
        onDone('Error connecting to IDE.')
        return
      }
      const newConfig = { ...(dynamicMcpConfig || {}) }
      if (currentIDE) {
        delete newConfig.ide
      }
      if (!selectedIDE) {
        // Close the MCP transport and remove the client from state
        if (ideClient && ideClient.type === 'connected' && currentIDE) {
          // Null out onclose to prevent auto-reconnection
          ideClient.client.onclose = () => {}
          void clearServerCache('ide', ideClient.config)
          onRemoveIdeClient()
        }
        onChangeDynamicMcpConfig(newConfig)
        onDone(
          currentIDE
            ? `Disconnected from ${currentIDE.name}.`
            : 'No IDE selected.',
        )
        return
      }
      const url = selectedIDE.url
      newConfig.ide = {
        type: url.startsWith('ws:') ? 'ws-ide' : 'sse-ide',
        url: url,
        ideName: selectedIDE.name,
        authToken: selectedIDE.authToken,
        ideRunningInWindows: selectedIDE.ideRunningInWindows,
        scope: 'dynamic' as const,
      } as ScopedMcpServerConfig
      isFirstCheckRef.current = true
      setConnectingIDE(selectedIDE)
      onChangeDynamicMcpConfig(newConfig)
    },
    [
      dynamicMcpConfig,
      currentIDE,
      ideClient,
      onRemoveIdeClient,
      onChangeDynamicMcpConfig,
      onDone,
    ],
  )

  if (connectingIDE) {
    return <Text dimColor>Connecting to {connectingIDE.name}…</Text>
  }

  return (
    <IDEScreen
      availableIDEs={availableIDEs}
      unavailableIDEs={unavailableIDEs}
      selectedIDE={currentIDE}
      onClose={() => onDone('IDE selection cancelled', { display: 'system' })}
      onSelect={handleSelectIDE}
    />
  )
}

/**
 * Formats workspace folders for display, stripping cwd and showing tail end of paths
 * @param folders Array of folder paths
 * @param maxLength Maximum total length of the formatted string
 * @returns Formatted string with folder paths
 */
export function formatWorkspaceFolders(
  folders: string[],
  maxLength: number = 100,
): string {
  if (folders.length === 0) return ''

  const cwd = getCwd()

  // Only show first 2 workspaces
  const foldersToShow = folders.slice(0, 2)
  const hasMore = folders.length > 2

  // Account for ", …" if there are more folders
  const ellipsisOverhead = hasMore ? 3 : 0 // ", …"

  // Account for commas and spaces between paths (", " = 2 chars per separator)
  const separatorOverhead = (foldersToShow.length - 1) * 2
  const availableLength = maxLength - separatorOverhead - ellipsisOverhead

  const maxLengthPerPath = Math.floor(availableLength / foldersToShow.length)

  const cwdNFC = cwd.normalize('NFC')
  const formattedFolders = foldersToShow.map(folder => {
    // Strip cwd from the beginning if present
    // Normalize both to NFC for consistent comparison (macOS uses NFD paths)
    const folderNFC = folder.normalize('NFC')
    if (folderNFC.startsWith(cwdNFC + path.sep)) {
      folder = folderNFC.slice(cwdNFC.length + 1)
    }

    if (folder.length <= maxLengthPerPath) {
      return folder
    }
    return '…' + folder.slice(-(maxLengthPerPath - 1))
  })

  let result = formattedFolders.join(', ')
  if (hasMore) {
    result += ', …'
  }

  return result
}
