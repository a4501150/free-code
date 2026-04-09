import * as React from 'react'
import { Box, Text } from '../../ink.js'
import type { DeepImmutable } from '../../types/utils.js'
import type { LocalWorkflowTaskState } from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'

type Props = {
  workflow: DeepImmutable<LocalWorkflowTaskState>
  onDone: (result?: string) => void
  onKill?: () => void
  onSkipAgent?: (agentId: string) => void
  onRetryAgent?: (agentId: string) => void
  onBack: () => void
}

export function WorkflowDetailDialog({
  workflow,
  onBack,
}: Props): React.ReactNode {
  return (
    <Box flexDirection="column">
      <Text>Workflow: {workflow.description}</Text>
      <Text dimColor>Press enter to go back.</Text>
    </Box>
  )
}
