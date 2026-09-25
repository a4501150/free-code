import figures from 'figures'
import * as React from 'react'
import { Box, Text } from 'src/ink.js'
import type { PromptInputMode } from 'src/types/textInputTypes.js'
import type { Theme } from 'src/utils/theme.js'

type Props = {
  mode: PromptInputMode
  isLoading: boolean
  viewingAgentName?: string
  viewingAgentColor?: keyof Theme
}

type PromptCharProps = {
  isLoading: boolean
  themeColor?: keyof Theme
}

/**
 * Renders the prompt character (❯). The viewed agent's color overrides
 * the default color when set.
 */
function PromptChar({
  isLoading,
  themeColor,
}: PromptCharProps): React.ReactNode {
  const color = themeColor ?? undefined

  return (
    <Text color={color} dimColor={isLoading}>
      {figures.pointer}&nbsp;
    </Text>
  )
}

export function PromptInputModeIndicator({
  mode,
  isLoading,
  viewingAgentName,
  viewingAgentColor,
}: Props): React.ReactNode {
  return (
    <Box
      alignItems="flex-start"
      alignSelf="flex-start"
      flexWrap="nowrap"
      justifyContent="flex-start"
    >
      {viewingAgentName ? (
        // Use the viewed agent's color on the standard prompt character,
        // matching the established style
        <PromptChar isLoading={isLoading} themeColor={viewingAgentColor} />
      ) : mode === 'bash' ? (
        <Text color="bashBorder" dimColor={isLoading}>
          !&nbsp;
        </Text>
      ) : (
        <PromptChar isLoading={isLoading} />
      )}
    </Box>
  )
}
