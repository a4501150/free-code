/**
 * CoordinatorTaskPanel — host-agnostic panel listing steerable background
 * agents. The host maps its task state to neutral CoordinatorTaskRow props
 * and owns the 1s eviction tick (passing the current timestamp in `now`);
 * this panel only renders rows and reports view/click intents.
 *
 * Render contract: below the prompt input footer whenever rows exist.
 * Enter to view/steer, x to dismiss (x handling lives in the host's
 * keybindings, not here).
 */

import figures from 'figures'
import * as React from 'react'
import {
  BLACK_CIRCLE,
  PAUSE_ICON,
  PLAY_ICON,
} from '../../../constants/figures.js'
import { useTerminalSize } from '../../../hooks/useTerminalSize.js'
import { stringWidth } from '../../../ink/stringWidth.js'
import { Box, Text, wrapText } from '../../../ink.js'
import { formatDuration, formatNumber } from '../../../utils/format.js'

/** A panel row — the host maps its task state to this view model. */
export type CoordinatorTaskRow = {
  id: string
  /** Steering handle from the host's agent-name registry */
  name?: string
  description: string
  /** AI activity summary; wins over description when present */
  summary?: string
  isRunning: boolean
  startTime: number
  endTime?: number
  totalPausedMs?: number
  tokenCount?: number
  /** Recent tool-call activity — drives the tokens direction arrow */
  hasActivity: boolean
  queuedCount: number
}

type Props = {
  tasks: CoordinatorTaskRow[]
  /** Timestamp for elapsed math; the host re-renders every second. */
  now: number
  /** Selection pointer: 0 = main row, 1..N = task rows; undefined = outside. */
  selectedIndex?: number
  /** Currently viewed task; undefined = main session. */
  viewedTaskId?: string
  onExitView: () => void
  onEnterView: (taskId: string) => void
}

export function CoordinatorTaskPanel({
  tasks,
  now,
  selectedIndex,
  viewedTaskId,
  onExitView,
  onEnterView,
}: Props): React.ReactNode {
  if (tasks.length === 0) {
    return null
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      <MainLine
        isSelected={selectedIndex === 0}
        isViewed={viewedTaskId === undefined}
        onClick={onExitView}
      />
      {tasks.map((task, i) => (
        <AgentLine
          key={task.id}
          task={task}
          now={now}
          isSelected={selectedIndex === i + 1}
          isViewed={viewedTaskId === task.id}
          onClick={() => onEnterView(task.id)}
        />
      ))}
    </Box>
  )
}

function MainLine({
  isSelected,
  isViewed,
  onClick,
}: {
  isSelected?: boolean
  isViewed?: boolean
  onClick: () => void
}): React.ReactNode {
  const [hover, setHover] = React.useState(false)
  const prefix = isSelected || hover ? figures.pointer + ' ' : '  '
  const bullet = isViewed ? BLACK_CIRCLE : figures.circle
  return (
    <Box
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <Text dimColor={!isSelected && !isViewed && !hover} bold={isViewed}>
        {prefix}
        {bullet} main
      </Text>
    </Box>
  )
}

function AgentLine({
  task,
  now,
  isSelected,
  isViewed,
  onClick,
}: {
  task: CoordinatorTaskRow
  now: number
  isSelected?: boolean
  isViewed?: boolean
  onClick?: () => void
}): React.ReactNode {
  const { columns } = useTerminalSize()
  const [hover, setHover] = React.useState(false)
  const pausedMs = task.totalPausedMs ?? 0
  const elapsedMs = Math.max(
    0,
    task.isRunning
      ? now - task.startTime - pausedMs
      : (task.endTime ?? task.startTime) - task.startTime - pausedMs,
  )

  const elapsed = formatDuration(elapsedMs)
  const tokenCount = task.tokenCount

  // Derive direction arrow from activity state, same logic as Spinner
  const arrow = task.hasActivity ? figures.arrowDown : figures.arrowUp

  const tokenText =
    tokenCount !== undefined && tokenCount > 0
      ? ` · ${arrow} ${formatNumber(tokenCount)} tokens`
      : ''

  const queuedText = task.queuedCount > 0 ? ` · ${task.queuedCount} queued` : ''

  // Precedence: AI summary > static description (no tool-call activity noise)
  const displayDescription = task.summary || task.description

  const highlighted = isSelected || hover
  const prefix = highlighted ? figures.pointer + ' ' : '  '
  const bullet = isViewed ? BLACK_CIRCLE : figures.circle
  const dim = !highlighted && !isViewed

  const sep = task.isRunning ? PLAY_ICON : PAUSE_ICON
  // Name is the steering handle — kept out of truncation and undimmed so it
  // stays readable even when the row is inactive. Short by convention (the
  // Agent tool prompt asks for "one or two words, lowercase").
  const namePart = task.name ? `${task.name}: ` : ''
  const hintPart =
    isSelected && !isViewed
      ? ` · x to ${task.isRunning ? 'stop' : 'clear'}`
      : ''
  const suffixPart = ` ${sep} ${elapsed}${tokenText}${queuedText}${hintPart}`
  const availableForDesc =
    columns -
    stringWidth(prefix) -
    stringWidth(`${bullet} `) -
    stringWidth(namePart) -
    stringWidth(suffixPart)
  const truncated = wrapText(
    displayDescription,
    Math.max(0, availableForDesc),
    'truncate-end',
  )

  const line = (
    <Text dimColor={dim} bold={isViewed}>
      {prefix}
      {bullet}{' '}
      {task.name && (
        <>
          <Text dimColor={false} bold>
            {task.name}
          </Text>
          {': '}
        </>
      )}
      {truncated} {sep} {elapsed}
      {tokenText}
      {task.queuedCount > 0 && <Text color="warning">{queuedText}</Text>}
      {hintPart && <Text dimColor>{hintPart}</Text>}
    </Text>
  )

  if (!onClick) return line
  return (
    <Box
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      {line}
    </Box>
  )
}
