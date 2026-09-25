import * as React from 'react'
import { Box, Text } from '../../ink.js'
import type { Theme } from '../../utils/theme.js'

type Props = {
  title: string
  subtitle?: React.ReactNode
  color?: keyof Theme
}

export function PermissionRequestTitle({
  title,
  subtitle,
  color = 'permission',
}: Props): React.ReactNode {
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" gap={1}>
        <Text bold color={color}>
          {title}
        </Text>
      </Box>
      {subtitle != null &&
        (typeof subtitle === 'string' ? (
          <Text dimColor wrap="truncate-start">
            {subtitle}
          </Text>
        ) : (
          subtitle
        ))}
    </Box>
  )
}
