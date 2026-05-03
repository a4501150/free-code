import * as React from 'react'
import { Box, Text } from '../ink.js'
import {
  calculateTokenWarningState,
  isAutoCompactEnabled,
} from '../services/compact/autoCompact.js'
import { useCompactWarningSuppression } from '../services/compact/compactWarningHook.js'

type Props = {
  tokenUsage: number
  model: string
}

export function TokenWarning({ tokenUsage, model }: Props): React.ReactNode {
  const { percentLeft, isAboveWarningThreshold, isAboveErrorThreshold } =
    calculateTokenWarningState(tokenUsage, model)

  // Use reactive hook to check if warning should be suppressed
  const suppressWarning = useCompactWarningSuppression()

  if (!isAboveWarningThreshold || suppressWarning) {
    return null
  }

  const showAutoCompactWarning = isAutoCompactEnabled()
  const autocompactLabel = `${percentLeft}% until auto-compact`

  return (
    <Box flexDirection="row">
      {showAutoCompactWarning ? (
        <Text dimColor wrap="truncate">
          {autocompactLabel}
        </Text>
      ) : (
        <Text
          color={isAboveErrorThreshold ? 'error' : 'warning'}
          wrap="truncate"
        >
          {`Context low (${percentLeft}% remaining) \u00b7 Run /compact to compact & continue`}
        </Text>
      )}
    </Box>
  )
}
