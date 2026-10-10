/**
 * Shared renderer for the <task-notification> block every background task
 * enqueues through messageQueueManager (shell, agent, main session, monitor).
 * The tag layout is a contract with the model (documented in the system
 * prompt) and with print.ts / structured consumers — statusless notices are
 * progress pings, and <status> present is the terminal signal.
 */

import {
  OUTPUT_FILE_TAG,
  STATUS_TAG,
  SUMMARY_TAG,
  TASK_ID_TAG,
  TASK_NOTIFICATION_TAG,
  TASK_TYPE_TAG,
  TOOL_USE_ID_TAG,
} from '../../constants/xml.js'
import { getTaskOutputPath } from './diskOutput.js'

export function renderTaskNotificationBlock(fields: {
  taskId: string
  /** Pre-escaped by the caller when the summary can contain XML metachars. */
  summary: string
  /** Omit for non-terminal (progress) notices. */
  status?: string
  toolUseId?: string
  /** Distinguishes notice kinds sharing the wrapper (e.g. 'monitor'). */
  taskType?: string
  /** Pre-rendered sections appended after <summary>, each starting with '\n'. */
  extraSections?: string
}): string {
  const toolUseIdLine = fields.toolUseId
    ? `\n<${TOOL_USE_ID_TAG}>${fields.toolUseId}</${TOOL_USE_ID_TAG}>`
    : ''
  const taskTypeLine = fields.taskType
    ? `\n<${TASK_TYPE_TAG}>${fields.taskType}</${TASK_TYPE_TAG}>`
    : ''
  // <status> only when present: a <status> is the terminal signal for
  // print.ts and structured consumers, so progress pings omit it.
  const statusLine =
    fields.status !== undefined
      ? `\n<${STATUS_TAG}>${fields.status}</${STATUS_TAG}>`
      : ''
  return `<${TASK_NOTIFICATION_TAG}>
<${TASK_ID_TAG}>${fields.taskId}</${TASK_ID_TAG}>${toolUseIdLine}${taskTypeLine}
<${OUTPUT_FILE_TAG}>${getTaskOutputPath(fields.taskId)}</${OUTPUT_FILE_TAG}>${statusLine}
<${SUMMARY_TAG}>${fields.summary}</${SUMMARY_TAG}>${fields.extraSections ?? ''}
</${TASK_NOTIFICATION_TAG}>`
}
