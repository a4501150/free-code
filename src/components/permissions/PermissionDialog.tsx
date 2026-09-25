import * as React from 'react'
import { Box } from '../../ink.js'
import type { Theme } from '../../utils/theme.js'
import { PermissionRequestTitle } from './PermissionRequestTitle.js'

type Props = {
  title: string
  subtitle?: React.ReactNode
  color?: keyof Theme
  titleColor?: keyof Theme
  innerPaddingX?: number
  titleRight?: React.ReactNode
  children: React.ReactNode
}

export function PermissionDialog({
  title,
  subtitle,
  color = 'permission',
  titleColor,
  innerPaddingX = 1,
  titleRight,
  children,
}: Props): React.ReactNode {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={color}
      borderLeft={false}
      borderRight={false}
      borderBottom={false}
      marginTop={1}
    >
      <Box paddingX={1} flexDirection="column">
        <Box justifyContent="space-between">
          <PermissionRequestTitle
            title={title}
            subtitle={subtitle}
            color={titleColor}
          />
          {titleRight}
        </Box>
      </Box>
      <Box flexDirection="column" paddingX={innerPaddingX}>
        {children}
      </Box>
    </Box>
  )
}
