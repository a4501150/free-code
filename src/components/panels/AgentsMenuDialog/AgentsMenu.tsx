/**
 * Host-agnostic agents dialog: renders from neutral props — agent
 * definitions, MCP tools and the tool permission context come in as data,
 * and the post-delete store write-back goes out through onAgentDeleted.
 * The REPL host adapter (components/agents/AgentsMenu.tsx) reads the store
 * and wires the callbacks.
 */

import chalk from 'chalk'
import * as React from 'react'
import { useCallback, useMemo, useState } from 'react'
import type { SettingSource } from 'src/utils/settings/constants.js'
import type { CommandResultDisplay } from '../../../commands.js'
import { useExitOnCtrlCDWithKeybindings } from '../../../hooks/useExitOnCtrlCDWithKeybindings.js'
import { useMergedTools } from '../../../hooks/useMergedTools.js'
import { Box, Text } from '../../../ink.js'
import type { ToolPermissionContext, Tools } from '../../../Tool.js'
import {
  type ResolvedAgent,
  resolveAgentOverrides,
} from '../../../tools/AgentTool/agentDisplay.js'
import {
  type AgentDefinition,
  type AgentDefinitionsResult,
} from '../../../tools/AgentTool/loadAgentsDir.js'
import { toError } from '../../../utils/errors.js'
import { logError } from '../../../utils/log.js'
import { Select } from '../../CustomSelect/select.js'
import { Dialog } from '../../design-system/Dialog.js'
import { AgentDetail } from '../../agents/AgentDetail.js'
import { type AgentEditorChanges, AgentEditor } from './AgentEditor.js'
import { AgentNavigationFooter } from '../../agents/AgentNavigationFooter.js'
import { AgentsList } from '../../agents/AgentsList.js'
import { deleteAgentFromFile } from '../../agents/agentFileUtils.js'
import { CreateAgentWizard } from '../../agents/new-agent-creation/CreateAgentWizard.js'
import type { ModeState } from '../../agents/types.js'

export type AgentsMenuDialogProps = {
  tools: Tools
  onExit: (
    result?: string,
    options?: { display?: CommandResultDisplay },
  ) => void
  /** All loaded agent definitions (every source + the active set). */
  agentDefinitions: AgentDefinitionsResult
  /** MCP tools discovered dynamically — used to merge the tool pool. */
  mcpTools: Tools
  /** Permission context used when filtering the merged tool pool. */
  toolPermissionContext: ToolPermissionContext
  /**
   * Host-side write-back invoked after an agent has been removed from its
   * file: the host updates its agent-definitions state for this agent.
   */
  onAgentDeleted: (agent: AgentDefinition) => void
  /**
   * Host-side write-back forwarded to the agent editor after it updates an
   * agent's file: the host updates its agent-definitions state for the
   * edited agent.
   */
  onAgentUpdated: (changes: AgentEditorChanges) => void
  /**
   * Host-side write-back with the finalized agent from the create wizard:
   * the host appends it to its agent-definitions state.
   */
  onAgentCreated: (agent: AgentDefinition) => void
}

export function AgentsMenu({
  tools,
  onExit,
  agentDefinitions,
  mcpTools,
  toolPermissionContext,
  onAgentDeleted,
  onAgentUpdated,
  onAgentCreated,
}: AgentsMenuDialogProps): React.ReactNode {
  const [modeState, setModeState] = useState<ModeState>({
    mode: 'list-agents',
    source: 'all',
  })
  const { allAgents, activeAgents: agents } = agentDefinitions
  const [changes, setChanges] = useState<string[]>([])

  // Get MCP tools from app state and merge with local tools
  const mergedTools = useMergedTools(tools, mcpTools, toolPermissionContext)

  useExitOnCtrlCDWithKeybindings()

  const agentsBySource: Record<
    SettingSource | 'all' | 'built-in' | 'plugin',
    AgentDefinition[]
  > = useMemo(
    () => ({
      'built-in': allAgents.filter(a => a.source === 'built-in'),
      userSettings: allAgents.filter(a => a.source === 'userSettings'),
      projectSettings: allAgents.filter(a => a.source === 'projectSettings'),
      localSettings: allAgents.filter(a => a.source === 'localSettings'),
      flagSettings: allAgents.filter(a => a.source === 'flagSettings'),
      plugin: allAgents.filter(a => a.source === 'plugin'),
      all: allAgents,
    }),
    [allAgents],
  )

  const handleAgentCreated = useCallback((message: string) => {
    setChanges(prev => [...prev, message])
    setModeState({ mode: 'list-agents', source: 'all' })
  }, [])

  const handleAgentDeleted = useCallback(
    async (agent: AgentDefinition) => {
      try {
        await deleteAgentFromFile(agent)
        onAgentDeleted(agent)

        setChanges(prev => [
          ...prev,
          `Deleted agent: ${chalk.bold(agent.agentType)}`,
        ])
        // Go back to the agents list after deletion
        setModeState({ mode: 'list-agents', source: 'all' })
      } catch (error) {
        logError(toError(error))
      }
    },
    [onAgentDeleted],
  )

  // Render based on mode
  switch (modeState.mode) {
    case 'list-agents': {
      const agentsToShow =
        modeState.source === 'all'
          ? [
              ...agentsBySource['built-in'],
              ...agentsBySource['userSettings'],
              ...agentsBySource['projectSettings'],
              ...agentsBySource['localSettings'],
              ...agentsBySource['flagSettings'],
              ...agentsBySource['plugin'],
            ]
          : agentsBySource[modeState.source]

      // Resolve overrides and filter to the agents we want to show
      const allResolved = resolveAgentOverrides(agentsToShow, agents)
      const resolvedAgents: ResolvedAgent[] = allResolved

      return (
        <>
          <AgentsList
            source={modeState.source}
            agents={resolvedAgents}
            onBack={() => {
              const exitMessage =
                changes.length > 0
                  ? `Agent changes:\n${changes.join('\n')}`
                  : undefined
              onExit(exitMessage ?? 'Agents dialog dismissed', {
                display: changes.length === 0 ? 'system' : undefined,
              })
            }}
            onSelect={agent =>
              setModeState({
                mode: 'agent-menu',
                agent,
                previousMode: modeState,
              })
            }
            onCreateNew={() => setModeState({ mode: 'create-agent' })}
            changes={changes}
          />
          <AgentNavigationFooter />
        </>
      )
    }

    case 'create-agent':
      return (
        <CreateAgentWizard
          tools={mergedTools}
          existingAgents={agents}
          onComplete={handleAgentCreated}
          onCancel={() => setModeState({ mode: 'list-agents', source: 'all' })}
          onAgentCreated={onAgentCreated}
        />
      )

    case 'agent-menu': {
      // Always use fresh agent data
      const freshAgent = allAgents.find(
        a =>
          a.agentType === modeState.agent.agentType &&
          a.source === modeState.agent.source,
      )
      const agentToUse = freshAgent || modeState.agent

      const isEditable =
        agentToUse.source !== 'built-in' &&
        agentToUse.source !== 'plugin' &&
        agentToUse.source !== 'flagSettings'
      const menuItems = [
        { label: 'View agent', value: 'view' },
        ...(isEditable
          ? [
              { label: 'Edit agent', value: 'edit' },
              { label: 'Delete agent', value: 'delete' },
            ]
          : []),
        { label: 'Back', value: 'back' },
      ]

      const handleMenuSelect = (value: string): void => {
        switch (value) {
          case 'view':
            setModeState({
              mode: 'view-agent',
              agent: agentToUse,
              previousMode: modeState.previousMode,
            })
            break
          case 'edit':
            setModeState({
              mode: 'edit-agent',
              agent: agentToUse,
              previousMode: modeState,
            })
            break
          case 'delete':
            setModeState({
              mode: 'delete-confirm',
              agent: agentToUse,
              previousMode: modeState,
            })
            break
          case 'back':
            setModeState(modeState.previousMode)
            break
        }
      }

      return (
        <>
          <Dialog
            title={modeState.agent.agentType}
            onCancel={() => setModeState(modeState.previousMode)}
            hideInputGuide
          >
            <Box flexDirection="column">
              <Select
                options={menuItems}
                onChange={handleMenuSelect}
                onCancel={() => setModeState(modeState.previousMode)}
              />
              {changes.length > 0 && (
                <Box marginTop={1}>
                  <Text dimColor>{changes[changes.length - 1]}</Text>
                </Box>
              )}
            </Box>
          </Dialog>
          <AgentNavigationFooter />
        </>
      )
    }

    case 'view-agent': {
      // Always use fresh agent data from allAgents
      const freshAgent = allAgents.find(
        a =>
          a.agentType === modeState.agent.agentType &&
          a.source === modeState.agent.source,
      )
      const agentToDisplay = freshAgent || modeState.agent

      return (
        <>
          <Dialog
            title={agentToDisplay.agentType}
            onCancel={() =>
              setModeState({
                mode: 'agent-menu',
                agent: agentToDisplay,
                previousMode: modeState.previousMode,
              })
            }
            hideInputGuide
          >
            <AgentDetail
              agent={agentToDisplay}
              tools={mergedTools}
              allAgents={allAgents}
              onBack={() =>
                setModeState({
                  mode: 'agent-menu',
                  agent: agentToDisplay,
                  previousMode: modeState.previousMode,
                })
              }
            />
          </Dialog>
          <AgentNavigationFooter instructions="Press Enter or Esc to go back" />
        </>
      )
    }

    case 'delete-confirm': {
      const deleteOptions = [
        { label: 'Yes, delete', value: 'yes' },
        { label: 'No, cancel', value: 'no' },
      ]

      return (
        <>
          <Dialog
            title="Delete agent"
            onCancel={() => {
              if ('previousMode' in modeState)
                setModeState(modeState.previousMode)
            }}
            color="error"
          >
            <Text>
              Are you sure you want to delete the agent{' '}
              <Text bold>{modeState.agent.agentType}</Text>?
            </Text>
            <Box marginTop={1}>
              <Text dimColor>Source: {modeState.agent.source}</Text>
            </Box>
            <Box marginTop={1}>
              <Select
                options={deleteOptions}
                onChange={(value: string) => {
                  if (value === 'yes') {
                    void handleAgentDeleted(modeState.agent)
                  } else {
                    if ('previousMode' in modeState) {
                      setModeState(modeState.previousMode)
                    }
                  }
                }}
                onCancel={() => {
                  if ('previousMode' in modeState) {
                    setModeState(modeState.previousMode)
                  }
                }}
              />
            </Box>
          </Dialog>
          <AgentNavigationFooter instructions="Press ↑↓ to navigate, Enter to select, Esc to cancel" />
        </>
      )
    }

    case 'edit-agent': {
      // Always use fresh agent data
      const freshAgent = allAgents.find(
        a =>
          a.agentType === modeState.agent.agentType &&
          a.source === modeState.agent.source,
      )
      const agentToEdit = freshAgent || modeState.agent

      return (
        <>
          <Dialog
            title={`Edit agent: ${agentToEdit.agentType}`}
            onCancel={() => setModeState(modeState.previousMode)}
            hideInputGuide
          >
            <AgentEditor
              agent={agentToEdit}
              tools={mergedTools}
              onAgentUpdated={onAgentUpdated}
              onSaved={message => {
                handleAgentCreated(message)
                setModeState(modeState.previousMode)
              }}
              onBack={() => setModeState(modeState.previousMode)}
            />
          </Dialog>
          <AgentNavigationFooter />
        </>
      )
    }

    default:
      return null
  }
}
