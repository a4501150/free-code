import React, { useCallback } from 'react'
import { Box, Text } from '../../ink.js'
import { Select } from '../CustomSelect/index.js'
import { Dialog } from '../design-system/Dialog.js'
import type { AgentMemoryScope } from '../../tools/AgentTool/agentMemory.js'
import { getAgentMemoryDir } from '../../tools/AgentTool/agentMemory.js'
import { getSnapshotDirForAgent } from '../../tools/AgentTool/agentMemorySnapshot.js'

type Choice = 'merge' | 'keep' | 'replace'

type Props = {
  agentType: string
  scope: AgentMemoryScope
  snapshotTimestamp: string
  onComplete: (choice: Choice) => void
  onCancel: () => void
}

export function SnapshotUpdateDialog({
  agentType,
  snapshotTimestamp,
  onComplete,
  onCancel,
}: Props) {
  const handleChoice = useCallback(
    (choice: Choice) => {
      onComplete(choice)
    },
    [onComplete],
  )

  return (
    <Dialog title="Agent memory snapshot update" onCancel={onCancel}>
      <Box flexDirection="column" gap={1}>
        <Text>
          A newer project snapshot is available for agent{' '}
          <Text bold>{agentType}</Text> (updated {snapshotTimestamp}).
        </Text>
        <Text dimColor>
          Your local agent memory has diverged from the project snapshot.
        </Text>
      </Box>
      <Select
        options={[
          {
            value: 'merge' as const,
            label: 'Merge',
            description:
              'Ask the agent to merge local memory with the snapshot',
          },
          {
            value: 'replace' as const,
            label: 'Replace',
            description: 'Overwrite local memory with the snapshot',
          },
          {
            value: 'keep' as const,
            label: 'Keep local',
            description: 'Keep your current local memory and skip this update',
          },
        ]}
        onChange={(value: Choice) => handleChoice(value)}
      />
    </Dialog>
  )
}

/**
 * Build a prompt instructing the agent to merge its local memory files
 * with the updated project snapshot.
 */
export function buildMergePrompt(
  agentType: string,
  scope: AgentMemoryScope,
): string {
  const localDir = getAgentMemoryDir(agentType, scope)
  const snapshotDir = getSnapshotDirForAgent(agentType)

  return [
    `The project snapshot for agent "${agentType}" has been updated.`,
    `Please merge the updated snapshot memory files into your local memory.`,
    ``,
    `- Snapshot directory: ${snapshotDir}`,
    `- Local memory directory: ${localDir}`,
    ``,
    `Read both directories, compare the files, and update your local memory ` +
      `to incorporate any new or changed information from the snapshot while ` +
      `preserving any local-only knowledge that is still relevant.`,
  ].join('\n')
}
