import { DEFAULT_CRON_JITTER_CONFIG } from '../../utils/cronTasks.js'
import { getInitialSettings } from '../../utils/settings/settings.js'

export const DEFAULT_MAX_AGE_DAYS =
  DEFAULT_CRON_JITTER_CONFIG.recurringMaxAgeMs / (24 * 60 * 60 * 1000)

/**
 * Runtime gate for the cron scheduling system: the `scheduledTasksEnabled`
 * settings key (defaults to enabled).
 */
export function isAssistantCronEnabled(): boolean {
  return getInitialSettings().scheduledTasksEnabled ?? true
}

/** Durable (disk-persistent) cron tasks are always enabled. */
export function isDurableCronEnabled(): boolean {
  return true
}

export const CRON_CREATE_TOOL_NAME = 'CronCreate'
export const MAX_JOBS = 50
export const CRON_DELETE_TOOL_NAME = 'CronDelete'
export const CRON_LIST_TOOL_NAME = 'CronList'

export const CRON_CREATE_DESCRIPTION =
  'Schedule a prompt to run at a future time — either recurring on a cron schedule, or once at a specific time. Pass durable: true to persist to .freecode/scheduled_tasks.json; otherwise session-only.'

export const CRON_CREATE_PROMPT = `Schedule a prompt to run at a future time — recurring or one-shot. Standard 5-field cron in the user's local timezone (minute hour day-of-month month day-of-week; "0 9 * * *" is 9am local, no timezone conversion). Recurring (the default): "*/5 * * * *", "0 9 * * 1-5". One-shot (recurring: false): fires once then deletes itself — pin the fields to the target time ("2:30pm today" → "30 14 <today_dom> <today_month> *").

durable: true writes the job to .freecode/scheduled_tasks.json so it survives restarts (a one-shot whose time passed runs late); use it only when the user asks for persistence. Default durable: false is session-only — nothing written to disk.

Jobs fire only while the session is idle. At most ${MAX_JOBS} jobs. Recurring jobs auto-expire after ${DEFAULT_MAX_AGE_DAYS} days — they fire one final time, then are removed; tell the user about that limit.`

export const CRON_DELETE_DESCRIPTION = 'Cancel a scheduled cron job by ID'
export const CRON_DELETE_PROMPT = `Cancel a cron job previously scheduled with ${CRON_CREATE_TOOL_NAME} (durable or session-only).`

export const CRON_LIST_DESCRIPTION = 'List scheduled cron jobs'
export const CRON_LIST_PROMPT = `List all cron jobs scheduled via ${CRON_CREATE_TOOL_NAME}, both durable and session-only.`
