import * as React from 'react'
import { Box, Text } from '../ink.js'
import { formatDuration, formatNumber } from '../utils/format.js'
import type { Theme } from '../utils/theme.js'
import { ToolUseLoader } from './ToolUseLoader.js'

type Props = {
  agentType: string
  description?: string
  name?: string
  descriptionColor?: keyof Theme
  taskDescription?: string
  toolUseCount: number
  tokens: number | null
  // Live elapsed time while in progress, or total duration once complete.
  // Null before the first progress message arrives (start time unknown).
  durationMs: number | null
  // Resolved model ID, non-null only when it differs from the main loop
  // model. Rendered as a dim tag on the title line.
  effectiveModel: string | null
  color?: keyof Theme
  isLast: boolean
  isResolved: boolean
  isError: boolean
  isAsync?: boolean
  shouldAnimate: boolean
  lastToolInfo?: string | null
  hideType?: boolean
}

export function AgentProgressLine({
  agentType,
  description,
  name,
  descriptionColor,
  taskDescription,
  toolUseCount,
  tokens,
  durationMs,
  effectiveModel,
  color,
  isLast,
  isResolved,
  isError,
  isAsync = false,
  shouldAnimate,
  lastToolInfo,
  hideType = false,
}: Props): React.ReactNode {
  const treeChar = isLast ? '└─' : '├─'
  const isBackgrounded = isAsync && isResolved

  // Determine the status text
  const getStatusText = (): string => {
    if (!isResolved) {
      const parts: string[] = [lastToolInfo || 'Initializing…']
      if (toolUseCount > 0) {
        parts.push(
          toolUseCount === 1 ? '1 tool use' : `${toolUseCount} tool uses`,
        )
      }
      if (tokens !== null && tokens > 0) {
        parts.push(`${formatNumber(tokens)} tokens`)
      }
      if (durationMs !== null) {
        parts.push(formatDuration(durationMs))
      }
      return parts.join(' · ')
    }
    if (isBackgrounded) {
      return taskDescription ?? 'Running in the background'
    }
    // Mirror single-agent "Done (N tool uses · Xk tokens · Ys)" format.
    const parts: string[] = [
      toolUseCount === 1 ? '1 tool use' : `${toolUseCount} tool uses`,
    ]
    if (tokens !== null) {
      parts.push(`${formatNumber(tokens)} tokens`)
    }
    if (durationMs !== null) {
      parts.push(formatDuration(durationMs))
    }
    return `Done (${parts.join(' · ')})`
  }

  return (
    <Box flexDirection="column">
      <Box paddingLeft={3} flexDirection="row">
        <Text dimColor>{treeChar} </Text>
        <ToolUseLoader
          shouldAnimate={shouldAnimate && !isResolved}
          isUnresolved={!isResolved}
          isError={isError}
        />
        <Text dimColor={!isResolved}>
          {hideType ? (
            <>
              <Text bold>{name ?? description ?? agentType}</Text>
              {name && description && <Text dimColor>: {description}</Text>}
            </>
          ) : (
            <>
              <Text
                bold
                backgroundColor={color}
                color={color ? 'inverseText' : undefined}
              >
                {agentType}
              </Text>
              {description && (
                <>
                  {' ('}
                  <Text
                    backgroundColor={descriptionColor}
                    color={descriptionColor ? 'inverseText' : undefined}
                  >
                    {description}
                  </Text>
                  {')'}
                </>
              )}
            </>
          )}
          {!isBackgrounded && effectiveModel && (
            <Text dimColor> {effectiveModel}</Text>
          )}
        </Text>
      </Box>
      {!isBackgrounded && (
        <Box paddingLeft={3} flexDirection="row">
          <Text dimColor>{isLast ? '   ⎿  ' : '│  ⎿  '}</Text>
          <Text dimColor={!isResolved || isBackgrounded}>
            {getStatusText()}
          </Text>
        </Box>
      )}
    </Box>
  )
}
