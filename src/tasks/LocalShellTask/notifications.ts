// Pure (non-React) notification helpers for LocalShellTask.
// Extracted so killShellTasks.ts can directly emit kill-notifications without
// pulling React/Ink into its module graph (same rationale as guards.ts /
// killShellTasks.ts).

import {
  OUTPUT_FILE_TAG,
  STATUS_TAG,
  SUMMARY_TAG,
  TASK_ID_TAG,
  TASK_NOTIFICATION_TAG,
  TOOL_USE_ID_TAG,
} from '../../constants/xml.js'
import { abortSpeculation } from '../../services/PromptSuggestion/speculation.js'
import type { SetAppState } from '../../Task.js'
import type { AgentId } from '../../types/ids.js'
import { enqueuePendingNotification } from '../../utils/messageQueueManager.js'
import { getTaskOutputPath } from '../../utils/task/diskOutput.js'
import { updateTaskState } from '../../utils/task/framework.js'
import { escapeXml } from '../../utils/xml.js'
import type { BashTaskKind } from './guards.js'

/** Prefix that identifies a LocalShellTask summary to the UI collapse transform. */
export const BACKGROUND_BASH_SUMMARY_PREFIX = 'Background command '

export function enqueueShellNotification(
  taskId: string,
  description: string,
  status: 'completed' | 'failed' | 'killed',
  exitCode: number | undefined,
  setAppState: SetAppState,
  toolUseId?: string,
  kind: BashTaskKind = 'bash',
  agentId?: AgentId,
): void {
  // Atomically check and set notified flag to prevent duplicate notifications.
  // If the task was already marked as notified (e.g., by TaskStopTool), skip
  // enqueueing to avoid sending redundant messages to the model.
  let shouldEnqueue = false
  updateTaskState(taskId, setAppState, task => {
    if (task.notified) {
      return task
    }
    shouldEnqueue = true
    return { ...task, notified: true }
  })

  if (!shouldEnqueue) {
    return
  }

  // Abort any active speculation — background task state changed, so speculated
  // results may reference stale task output. The prompt suggestion text is
  // preserved; only the pre-computed response is discarded.
  abortSpeculation(setAppState)

  let summary: string
  switch (status) {
    case 'completed':
      summary = `${BACKGROUND_BASH_SUMMARY_PREFIX}"${description}" completed${exitCode !== undefined ? ` (exit code ${exitCode})` : ''}`
      break
    case 'failed':
      summary = `${BACKGROUND_BASH_SUMMARY_PREFIX}"${description}" failed${exitCode !== undefined ? ` with exit code ${exitCode}` : ''}`
      break
    case 'killed':
      summary = `${BACKGROUND_BASH_SUMMARY_PREFIX}"${description}" was stopped`
      break
  }

  const outputPath = getTaskOutputPath(taskId)
  const toolUseIdLine = toolUseId
    ? `\n<${TOOL_USE_ID_TAG}>${toolUseId}</${TOOL_USE_ID_TAG}>`
    : ''
  const message = `<${TASK_NOTIFICATION_TAG}>
<${TASK_ID_TAG}>${taskId}</${TASK_ID_TAG}>${toolUseIdLine}
<${OUTPUT_FILE_TAG}>${outputPath}</${OUTPUT_FILE_TAG}>
<${STATUS_TAG}>${status}</${STATUS_TAG}>
<${SUMMARY_TAG}>${escapeXml(summary)}</${SUMMARY_TAG}>
</${TASK_NOTIFICATION_TAG}>`

  enqueuePendingNotification({
    value: message,
    mode: 'task-notification',
    priority: 'later',
    agentId,
  })
}
