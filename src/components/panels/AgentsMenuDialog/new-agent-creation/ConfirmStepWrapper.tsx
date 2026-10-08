/**
 * Host-agnostic confirm step of the create-agent wizard: saves the
 * finalized agent to disk and reports the creation through onAgentCreated
 * so the host can update its agent-definitions state. The REPL host
 * adapter (components/agents/new-agent-creation/wizard-steps/
 * ConfirmStepWrapper.tsx) wires the callback to AppState.
 */

import chalk from 'chalk'
import React, { type ReactNode, useCallback, useState } from 'react'
import type { Tools } from '../../../../Tool.js'
import type { AgentDefinition } from '../../../../tools/AgentTool/loadAgentsDir.js'
import { editFileInEditor } from '../../../../utils/promptEditor.js'
import { useWizard } from '../../../wizard/index.js'
import {
  getNewAgentFilePath,
  saveAgentToFile,
} from '../../../agents/agentFileUtils.js'
import type { AgentWizardData } from '../../../agents/new-agent-creation/types.js'
import { ConfirmStep } from '../../../agents/new-agent-creation/wizard-steps/ConfirmStep.js'

export type ConfirmStepWrapperDialogProps = {
  tools: Tools
  existingAgents: AgentDefinition[]
  onComplete: (message: string) => void
  /**
   * Host-side write-back invoked with the wizard's finalized agent after
   * its file has been saved: the host appends the agent to its
   * agent-definitions state.
   */
  onAgentCreated: (agent: AgentDefinition) => void
}

export function ConfirmStepWrapper({
  tools,
  existingAgents,
  onComplete,
  onAgentCreated,
}: ConfirmStepWrapperDialogProps): ReactNode {
  const { wizardData } = useWizard<AgentWizardData>()
  const [saveError, setSaveError] = useState<string | null>(null)

  const saveAgent = useCallback(
    async (openInEditor: boolean): Promise<void> => {
      if (!wizardData?.finalAgent) return

      try {
        await saveAgentToFile(
          wizardData.location!,
          wizardData.finalAgent.agentType,
          wizardData.finalAgent.whenToUse,
          wizardData.finalAgent.tools,
          (
            wizardData.finalAgent as import('../../../../tools/AgentTool/loadAgentsDir.js').CustomAgentDefinition
          ).getSystemPrompt(),
          true,
          wizardData.finalAgent.color,
          wizardData.finalAgent.model,
          wizardData.finalAgent.memory,
        )

        onAgentCreated(wizardData.finalAgent)

        if (openInEditor) {
          const filePath = getNewAgentFilePath({
            source: wizardData.location!,
            agentType: wizardData.finalAgent.agentType,
          })
          await editFileInEditor(filePath)
        }

        const message = openInEditor
          ? `Created agent: ${chalk.bold(wizardData.finalAgent.agentType)} and opened in editor. ` +
            `If you made edits, restart to load the latest version.`
          : `Created agent: ${chalk.bold(wizardData.finalAgent.agentType)}`
        onComplete(message)
      } catch (err) {
        setSaveError(
          err instanceof Error ? err.message : 'Failed to save agent',
        )
      }
    },
    [wizardData, onComplete, onAgentCreated],
  )

  const handleSave = useCallback(() => saveAgent(false), [saveAgent])

  const handleSaveAndEdit = useCallback(() => saveAgent(true), [saveAgent])

  return (
    <ConfirmStep
      tools={tools}
      existingAgents={existingAgents}
      onSave={handleSave}
      onSaveAndEdit={handleSaveAndEdit}
      error={saveError}
    />
  )
}
