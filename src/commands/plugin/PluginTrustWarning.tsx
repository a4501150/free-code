import figures from 'figures'
import * as React from 'react'
import { Box, Text } from '../../ink.js'

export function PluginTrustWarning(): React.ReactNode {
  return (
    <Box marginBottom={1}>
      <Text color="claude">{figures.warning} </Text>
      <Text dimColor italic>
        Make sure you trust a plugin before installing, updating, or using it.
        Anthropic does not control what MCP servers, files, or other software
        are included in plugins and cannot verify that they will work as
        intended or that they won&apos;t change. See each plugin&apos;s homepage
        for more information.
      </Text>
    </Box>
  )
}
