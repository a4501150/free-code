import * as React from 'react'
import {
  DISCLOSURE_COLLAPSED,
  DISCLOSURE_EXPANDED,
} from '../../constants/figures.js'
import { Box, NoSelect, Text, type TextProps } from '../../ink.js'
import { getShortcutDisplay } from '../../keybindings/shortcutFormat.js'
import { countCharInString, plural } from '../../utils/stringUtils.js'
import { useSelectedMessageBg } from '../messageActions.js'

type Props = {
  addMargin: boolean
  label: string
  content: string
  verbose: boolean
  color?: TextProps['color']
}

/**
 * Deliberately not MessageResponse: `⎿` marks a result hanging off the line
 * above it, and injected context often has no parent line at all (the
 * user-context block opens the session). A disclosure triangle at the same
 * indent reads as its own row and advertises that clicking expands it.
 *
 * `verbose` is how expansion arrives — Messages.tsx folds per-row click state,
 * --verbose and transcript mode into that one prop, so there is no local
 * expansion state to keep in sync.
 */
export function InjectedContextMessage({
  addMargin,
  label,
  content,
  verbose,
  color,
}: Props): React.ReactNode {
  const bg = useSelectedMessageBg()
  const body = content.trim()
  if (!body) return null

  const lineCount = countCharInString(body, '\n') + 1
  // Collapsed rows otherwise advertise no way in: name the exact key so the
  // raw model-facing bytes are reachable without mouse or lore. Respects a
  // rebound transcript toggle.
  const expandHint = verbose
    ? ''
    : lineCount > 1
      ? ` (${getShortcutDisplay('app:toggleTranscript', 'Global', 'ctrl+o')} to expand)`
      : ''

  return (
    <Box
      flexDirection="column"
      backgroundColor={bg}
      marginTop={addMargin ? 1 : 0}
    >
      <Box>
        <NoSelect fromLeftEdge flexShrink={0}>
          <Text dimColor>
            {'  '}
            {verbose ? DISCLOSURE_EXPANDED : DISCLOSURE_COLLAPSED}{' '}
          </Text>
        </NoSelect>
        <Box flexShrink={1} flexGrow={1}>
          <Text color={color} dimColor={color === undefined} wrap="wrap">
            {label}{' '}
            <Text dimColor>
              ({lineCount} {plural(lineCount, 'line')}){expandHint}
            </Text>
          </Text>
        </Box>
      </Box>
      {verbose && (
        <Box paddingLeft={4}>
          <Text dimColor wrap="wrap">
            {body}
          </Text>
        </Box>
      )}
    </Box>
  )
}
