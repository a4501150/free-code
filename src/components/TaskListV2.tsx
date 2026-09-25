import figures from 'figures'
import * as React from 'react'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { Box, Text } from '../ink.js'
import { count } from '../utils/array.js'
import { truncateToWidth } from '../utils/format.js'
import type { Task } from '../utils/tasks.js'
import type { Theme } from '../utils/theme.js'

type Props = {
  tasks: Task[]
  isStandalone?: boolean
}

const RECENT_COMPLETED_TTL_MS = 30_000

function byIdAsc(a: Task, b: Task): number {
  const aNum = parseInt(a.id, 10)
  const bNum = parseInt(b.id, 10)
  if (!isNaN(aNum) && !isNaN(bNum)) {
    return aNum - bNum
  }
  return a.id.localeCompare(b.id)
}

export function TaskListV2({
  tasks,
  isStandalone = false,
}: Props): React.ReactNode {
  const [, forceUpdate] = React.useState(0)
  const { rows, columns } = useTerminalSize()

  // Track when each task was last observed transitioning to completed
  const completionTimestampsRef = React.useRef(new Map<string, number>())
  const previousCompletedIdsRef = React.useRef<Set<string> | null>(null)
  if (previousCompletedIdsRef.current === null) {
    previousCompletedIdsRef.current = new Set(
      tasks.filter(t => t.status === 'completed').map(t => t.id),
    )
  }
  const maxDisplay = rows <= 10 ? 0 : Math.min(10, Math.max(3, rows - 14))

  // Update completion timestamps: reset when a task transitions to completed
  const currentCompletedIds = new Set(
    tasks.filter(t => t.status === 'completed').map(t => t.id),
  )
  const now = Date.now()
  for (const id of currentCompletedIds) {
    if (!previousCompletedIdsRef.current.has(id)) {
      completionTimestampsRef.current.set(id, now)
    }
  }
  for (const id of completionTimestampsRef.current.keys()) {
    if (!currentCompletedIds.has(id)) {
      completionTimestampsRef.current.delete(id)
    }
  }
  previousCompletedIdsRef.current = currentCompletedIds

  // Schedule re-render when the next recent completion expires.
  // Depend on `tasks` so the timer is only reset when the task list changes,
  // not on every render (which was causing unnecessary work).
  React.useEffect(() => {
    if (completionTimestampsRef.current.size === 0) {
      return
    }
    const currentNow = Date.now()
    let earliestExpiry = Infinity
    for (const ts of completionTimestampsRef.current.values()) {
      const expiry = ts + RECENT_COMPLETED_TTL_MS
      if (expiry > currentNow && expiry < earliestExpiry) {
        earliestExpiry = expiry
      }
    }
    if (earliestExpiry === Infinity) {
      return
    }
    const timer = setTimeout(
      forceUpdate => forceUpdate((n: number) => n + 1),
      earliestExpiry - currentNow,
      forceUpdate,
    )
    return () => clearTimeout(timer)
  }, [tasks])

  if (tasks.length === 0) {
    return null
  }

  // Get task counts for display
  const completedCount = count(tasks, t => t.status === 'completed')
  const pendingCount = count(tasks, t => t.status === 'pending')
  const inProgressCount = tasks.length - completedCount - pendingCount
  // Unresolved tasks (open or in_progress) block dependent tasks
  const unresolvedTaskIds = new Set(
    tasks.filter(t => t.status !== 'completed').map(t => t.id),
  )

  // Check if we need to truncate
  const needsTruncation = tasks.length > maxDisplay

  let visibleTasks: Task[]
  let hiddenTasks: Task[]

  if (needsTruncation) {
    // Prioritize: recently completed (within 30s), in-progress, pending, older completed
    const recentCompleted: Task[] = []
    const olderCompleted: Task[] = []
    for (const task of tasks.filter(t => t.status === 'completed')) {
      const ts = completionTimestampsRef.current.get(task.id)
      if (ts && now - ts < RECENT_COMPLETED_TTL_MS) {
        recentCompleted.push(task)
      } else {
        olderCompleted.push(task)
      }
    }
    recentCompleted.sort(byIdAsc)
    olderCompleted.sort(byIdAsc)
    const inProgress = tasks
      .filter(t => t.status === 'in_progress')
      .sort(byIdAsc)
    const pending = tasks
      .filter(t => t.status === 'pending')
      .sort((a, b) => {
        const aBlocked = a.blockedBy.some(id => unresolvedTaskIds.has(id))
        const bBlocked = b.blockedBy.some(id => unresolvedTaskIds.has(id))
        if (aBlocked !== bBlocked) {
          return aBlocked ? 1 : -1
        }
        return byIdAsc(a, b)
      })

    const prioritized = [
      ...recentCompleted,
      ...inProgress,
      ...pending,
      ...olderCompleted,
    ]
    visibleTasks = prioritized.slice(0, maxDisplay)
    hiddenTasks = prioritized.slice(maxDisplay)
  } else {
    // No truncation needed — sort by ID for stable ordering
    visibleTasks = [...tasks].sort(byIdAsc)
    hiddenTasks = []
  }

  let hiddenSummary = ''
  if (hiddenTasks.length > 0) {
    const parts: string[] = []
    const hiddenPending = count(hiddenTasks, t => t.status === 'pending')
    const hiddenInProgress = count(hiddenTasks, t => t.status === 'in_progress')
    const hiddenCompleted = count(hiddenTasks, t => t.status === 'completed')
    if (hiddenInProgress > 0) {
      parts.push(`${hiddenInProgress} in progress`)
    }
    if (hiddenPending > 0) {
      parts.push(`${hiddenPending} pending`)
    }
    if (hiddenCompleted > 0) {
      parts.push(`${hiddenCompleted} completed`)
    }
    hiddenSummary = ` … +${parts.join(', ')}`
  }

  const content = (
    <>
      {visibleTasks.map(task => (
        <TaskItem
          key={task.id}
          task={task}
          openBlockers={task.blockedBy.filter(id => unresolvedTaskIds.has(id))}
          columns={columns}
        />
      ))}
      {maxDisplay > 0 && hiddenSummary && <Text dimColor>{hiddenSummary}</Text>}
    </>
  )

  if (isStandalone) {
    return (
      <Box flexDirection="column" marginTop={1} marginLeft={2}>
        <Box>
          <Text dimColor>
            <Text bold>{tasks.length}</Text>
            {' tasks ('}
            <Text bold>{completedCount}</Text>
            {' done, '}
            {inProgressCount > 0 && (
              <>
                <Text bold>{inProgressCount}</Text>
                {' in progress, '}
              </>
            )}
            <Text bold>{pendingCount}</Text>
            {' open)'}
          </Text>
        </Box>
        {content}
      </Box>
    )
  }

  return <Box flexDirection="column">{content}</Box>
}

type TaskItemProps = {
  task: Task
  openBlockers: string[]
  columns: number
}

function getTaskIcon(status: Task['status']): {
  icon: string
  color: keyof Theme | undefined
} {
  switch (status) {
    case 'completed':
      return { icon: figures.tick, color: 'success' }
    case 'in_progress':
      return { icon: figures.squareSmallFilled, color: 'claude' }
    case 'pending':
      return { icon: figures.squareSmall, color: undefined }
  }
}

function TaskItem({
  task,
  openBlockers,
  columns,
}: TaskItemProps): React.ReactNode {
  const isCompleted = task.status === 'completed'
  const isInProgress = task.status === 'in_progress'
  const isBlocked = openBlockers.length > 0

  const { icon, color } = getTaskIcon(task.status)

  // Truncate subject based on available space. Account for: icon(2) +
  // indentation(~8 when nested under spinner) + safety.
  const maxSubjectWidth = Math.max(15, columns - 15)
  const displaySubject = truncateToWidth(task.subject, maxSubjectWidth)

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={color}>{icon} </Text>
        <Text
          bold={isInProgress}
          strikethrough={isCompleted}
          dimColor={isCompleted || isBlocked}
        >
          {displaySubject}
        </Text>
        {isBlocked && (
          <Text dimColor>
            {' '}
            {figures.pointerSmall} blocked by{' '}
            {[...openBlockers]
              .sort((a, b) => parseInt(a, 10) - parseInt(b, 10))
              .map(id => `#${id}`)
              .join(', ')}
          </Text>
        )}
      </Box>
    </Box>
  )
}
