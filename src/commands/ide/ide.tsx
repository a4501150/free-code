import chalk from 'chalk'
import React, { useCallback, useEffect, useState } from 'react'

import type {
  CommandResultDisplay,
  LocalJSXCommandContext,
} from '../../commands.js'
import { Select } from '../../components/CustomSelect/index.js'
import { Dialog } from '../../components/design-system/Dialog.js'
import {
  IDECommandFlow as IDECommandFlowPanel,
  type IDECommandFlowProps as PanelIDECommandFlowProps,
} from '../../components/panels/IdeDialog/IDECommandFlow.js'
import { Text } from '../../ink.js'
import type { ScopedMcpServerConfig } from '../../services/mcp/types.js'
import { useAppState, useSetAppState } from '../../state/AppState.js'
import { getCwd } from '../../utils/cwd.js'
import { execFileNoThrow } from '../../utils/execFileNoThrow.js'
import {
  type DetectedIDEInfo,
  detectIDEs,
  detectRunningIDEs,
  type IdeType,
  isJetBrainsIde,
  isSupportedJetBrainsTerminal,
  isSupportedTerminal,
  toIDEDisplayName,
} from '../../utils/ide.js'
import { getCurrentWorktreeSession } from '../../utils/worktree.js'

export { formatWorkspaceFolders } from '../../components/panels/IdeDialog/IDECommandFlow.js'

async function findCurrentIDE(
  availableIDEs: DetectedIDEInfo[],
  dynamicMcpConfig?: Record<string, ScopedMcpServerConfig>,
): Promise<DetectedIDEInfo | null> {
  const currentConfig = dynamicMcpConfig?.ide
  if (
    !currentConfig ||
    (currentConfig.type !== 'sse-ide' && currentConfig.type !== 'ws-ide')
  ) {
    return null
  }
  for (const ide of availableIDEs) {
    if (ide.url === currentConfig.url) {
      return ide
    }
  }
  return null
}

type IDEOpenSelectionProps = {
  availableIDEs: DetectedIDEInfo[]
  onSelectIDE: (ide?: DetectedIDEInfo) => void
  onDone: (
    result?: string,
    options?: { display?: CommandResultDisplay },
  ) => void
}

function IDEOpenSelection({
  availableIDEs,
  onSelectIDE,
  onDone,
}: IDEOpenSelectionProps): React.ReactNode {
  const [selectedValue, setSelectedValue] = useState(
    availableIDEs[0]?.port?.toString() ?? '',
  )

  const handleSelectIDE = useCallback(
    (value: string) => {
      const selectedIDE = availableIDEs.find(
        ide => ide.port === parseInt(value),
      )
      onSelectIDE(selectedIDE)
    },
    [availableIDEs, onSelectIDE],
  )

  const options = availableIDEs.map(ide => ({
    label: ide.name,
    value: ide.port.toString(),
  }))

  function handleCancel(): void {
    onDone('IDE selection cancelled', { display: 'system' })
  }

  return (
    <Dialog
      title="Select an IDE to open the project"
      onCancel={handleCancel}
      color="ide"
    >
      <Select
        defaultValue={selectedValue}
        defaultFocusValue={selectedValue}
        options={options}
        onChange={value => {
          setSelectedValue(value)
          handleSelectIDE(value)
        }}
      />
    </Dialog>
  )
}

function RunningIDESelector({
  runningIDEs,
  onSelectIDE,
  onDone,
}: {
  runningIDEs: IdeType[]
  onSelectIDE: (ide: IdeType) => void
  onDone: (
    result?: string,
    options?: { display?: CommandResultDisplay },
  ) => void
}): React.ReactNode {
  const [selectedValue, setSelectedValue] = useState(runningIDEs[0] ?? '')

  const handleSelectIDE = useCallback(
    (value: string) => {
      onSelectIDE(value as IdeType)
    },
    [onSelectIDE],
  )

  const options = runningIDEs.map(ide => ({
    label: toIDEDisplayName(ide),
    value: ide,
  }))

  function handleCancel(): void {
    onDone('IDE selection cancelled', { display: 'system' })
  }

  return (
    <Dialog
      title="Select IDE to install extension"
      onCancel={handleCancel}
      color="ide"
    >
      <Select
        defaultFocusValue={selectedValue}
        options={options}
        onChange={value => {
          setSelectedValue(value)
          handleSelectIDE(value)
        }}
      />
    </Dialog>
  )
}

function InstallOnMount({
  ide,
  onInstall,
}: {
  ide: IdeType
  onInstall: (ide: IdeType) => void
}): React.ReactNode {
  useEffect(() => {
    onInstall(ide)
  }, [ide, onInstall])
  return null
}

export async function call(
  onDone: (
    result?: string,
    options?: { display?: CommandResultDisplay },
  ) => void,
  context: LocalJSXCommandContext,
  args: string,
): Promise<React.ReactNode | null> {
  const {
    options: { dynamicMcpConfig },
    onChangeDynamicMcpConfig,
  } = context

  // Handle 'open' argument
  if (args?.trim() === 'open') {
    const worktreeSession = getCurrentWorktreeSession()
    const targetPath = worktreeSession ? worktreeSession.worktreePath : getCwd()

    // Detect available IDEs
    const detectedIDEs = await detectIDEs(true)
    const availableIDEs = detectedIDEs.filter(ide => ide.isValid)

    if (availableIDEs.length === 0) {
      onDone('No IDEs with Claude Code extension detected.')
      return null
    }

    // Return IDE selection component
    return (
      <IDEOpenSelection
        availableIDEs={availableIDEs}
        onSelectIDE={async (selectedIDE?: DetectedIDEInfo) => {
          if (!selectedIDE) {
            onDone('No IDE selected.')
            return
          }

          // Try to open the project in the selected IDE
          if (
            selectedIDE.name.toLowerCase().includes('vscode') ||
            selectedIDE.name.toLowerCase().includes('cursor') ||
            selectedIDE.name.toLowerCase().includes('windsurf')
          ) {
            // VS Code-based IDEs
            const { code } = await execFileNoThrow('code', [targetPath])
            if (code === 0) {
              onDone(
                `Opened ${worktreeSession ? 'worktree' : 'project'} in ${chalk.bold(selectedIDE.name)}`,
              )
            } else {
              onDone(
                `Failed to open in ${selectedIDE.name}. Try opening manually: ${targetPath}`,
              )
            }
          } else if (isSupportedJetBrainsTerminal()) {
            // JetBrains IDEs - they usually open via their CLI tools
            onDone(
              `Please open the ${worktreeSession ? 'worktree' : 'project'} manually in ${chalk.bold(selectedIDE.name)}: ${targetPath}`,
            )
          } else {
            onDone(
              `Please open the ${worktreeSession ? 'worktree' : 'project'} manually in ${chalk.bold(selectedIDE.name)}: ${targetPath}`,
            )
          }
        }}
        onDone={() => {
          onDone('Exited without opening IDE', { display: 'system' })
        }}
      />
    )
  }

  const detectedIDEs = await detectIDEs(true)

  // If no IDEs with extensions detected, check for running IDEs and offer to install
  if (
    detectedIDEs.length === 0 &&
    context.onInstallIDEExtension &&
    !isSupportedTerminal()
  ) {
    const runningIDEs = await detectRunningIDEs()

    const onInstall = (ide: IdeType) => {
      if (context.onInstallIDEExtension) {
        context.onInstallIDEExtension(ide)
        // The completion message will be shown after installation
        if (isJetBrainsIde(ide)) {
          onDone(
            `Installed plugin to ${chalk.bold(toIDEDisplayName(ide))}\n` +
              `Please ${chalk.bold('restart your IDE')} completely for it to take effect`,
          )
        } else {
          onDone(`Installed extension to ${chalk.bold(toIDEDisplayName(ide))}`)
        }
      }
    }

    if (runningIDEs.length > 1) {
      // Show selector when multiple IDEs are running
      return (
        <RunningIDESelector
          runningIDEs={runningIDEs}
          onSelectIDE={onInstall}
          onDone={() => {
            onDone('No IDE selected.', { display: 'system' })
          }}
        />
      )
    } else if (runningIDEs.length === 1) {
      return <InstallOnMount ide={runningIDEs[0]!} onInstall={onInstall} />
    }
  }

  const availableIDEs = detectedIDEs.filter(ide => ide.isValid)
  const unavailableIDEs = detectedIDEs.filter(ide => !ide.isValid)

  const currentIDE = await findCurrentIDE(availableIDEs, dynamicMcpConfig)

  return (
    <IDECommandFlow
      availableIDEs={availableIDEs}
      unavailableIDEs={unavailableIDEs}
      currentIDE={currentIDE}
      dynamicMcpConfig={dynamicMcpConfig}
      onChangeDynamicMcpConfig={onChangeDynamicMcpConfig}
      onDone={onDone}
    />
  )
}

type IDECommandFlowHostProps = Omit<
  PanelIDECommandFlowProps,
  'ideClient' | 'onRemoveIdeClient'
>

/**
 * REPL host adapter for the IDE command flow: reads the 'ide' MCP client
 * from the app store and wires the client-removal store write behind a typed
 * callback for the host-agnostic panel.
 */
function IDECommandFlow(props: IDECommandFlowHostProps): React.ReactNode {
  const ideClient = useAppState(s => s.mcp.clients.find(c => c.name === 'ide'))
  const setAppState = useSetAppState()
  const onRemoveIdeClient = useCallback(
    () =>
      setAppState(prev => ({
        ...prev,
        mcp: {
          ...prev.mcp,
          clients: prev.mcp.clients.filter(c => c.name !== 'ide'),
          tools: prev.mcp.tools.filter(t => !t.name?.startsWith('mcp__ide__')),
          commands: prev.mcp.commands.filter(
            c => !c.name?.startsWith('mcp__ide__'),
          ),
        },
      })),
    [setAppState],
  )
  return (
    <IDECommandFlowPanel
      {...props}
      ideClient={ideClient}
      onRemoveIdeClient={onRemoveIdeClient}
    />
  )
}
