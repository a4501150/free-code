import React from 'react'
import { Box, Text } from '../ink.js'
import { useKeybinding } from '../keybindings/useKeybinding.js'
import { useShortcutDisplay } from '../keybindings/useShortcutDisplay.js'

type Props = {
  onSelect: (session: never) => void
  onCancel: () => void
  isEmbedded?: boolean
}

export function ResumeTask({
  onCancel,
}: Props): React.ReactNode {
  const escKey = useShortcutDisplay('confirm:no', 'Confirmation', 'Esc')

  useKeybinding('confirm:no', onCancel, { context: 'Confirmation' })

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold>Resume task is not available</Text>
      <Box marginTop={1}>
        <Text dimColor>
          Press <Text bold>{escKey}</Text> to cancel
        </Text>
      </Box>
    </Box>
  )
}
