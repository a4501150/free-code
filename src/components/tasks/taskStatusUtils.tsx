/**
 * Shared utilities for displaying task status across different task types.
 */

import figures from 'figures'
import type { TaskStatus } from 'src/Task.js'

/**
 * Returns true if the given task status represents a terminal (finished) state.
 */
export function isTerminalStatus(status: TaskStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'killed'
}

/**
 * Returns the appropriate icon for a task based on status and state flags.
 */
export function getTaskStatusIcon(
  status: TaskStatus,
  options?: {
    isIdle?: boolean
    awaitingApproval?: boolean
    hasError?: boolean
    shutdownRequested?: boolean
  },
): string {
  const { isIdle, awaitingApproval, hasError, shutdownRequested } =
    options ?? {}

  if (hasError) return figures.cross
  if (awaitingApproval) return figures.questionMarkPrefix
  if (shutdownRequested) return figures.warning

  if (status === 'running') {
    if (isIdle) return figures.ellipsis
    return figures.play
  }
  if (status === 'completed') return figures.tick
  if (status === 'failed' || status === 'killed') return figures.cross
  return figures.bullet
}

/**
 * Returns the appropriate semantic color for a task based on status and state flags.
 */
export function getTaskStatusColor(
  status: TaskStatus,
  options?: {
    isIdle?: boolean
    awaitingApproval?: boolean
    hasError?: boolean
    shutdownRequested?: boolean
  },
): 'success' | 'error' | 'warning' | 'background' {
  const { isIdle, awaitingApproval, hasError, shutdownRequested } =
    options ?? {}

  if (hasError) return 'error'
  if (awaitingApproval) return 'warning'
  if (shutdownRequested) return 'warning'
  if (isIdle) return 'background'

  if (status === 'completed') return 'success'
  if (status === 'failed') return 'error'
  if (status === 'killed') return 'warning'
  return 'background'
}
