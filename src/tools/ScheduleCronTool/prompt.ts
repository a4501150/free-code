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

export const CRON_CREATE_PROMPT = `Schedule a prompt to be enqueued at a future time — recurring on a cron schedule or once at a specific time. Uses standard 5-field cron in the user's local timezone: minute hour day-of-month month day-of-week ("0 9 * * *" means 9am local — no timezone conversion needed).

- Recurring (recurring: true, the default): for "every N minutes" / "weekdays at 9am" — "*/5 * * * *", "0 9 * * 1-5".
- One-shot (recurring: false): fires once then deletes itself. Pin minute/hour/day-of-month/month to the target time: "remind me at 2:30pm today" → "30 14 <today_dom> <today_month> *".

## Durability

By default (durable: false) the job lives only in this session — nothing is written to disk, and the job is gone when the process exits. Pass durable: true to write to .freecode/scheduled_tasks.json so the job survives restarts (resuming on next launch; a one-shot whose time passed runs late). Only use durable: true when the user explicitly asks for the task to persist ("keep doing this every day", "set this up permanently"). Most "remind me in 5 minutes" requests must stay session-only.

## Runtime behavior

Jobs only fire while the session is idle (not mid-query). At most ${MAX_JOBS} jobs at once. Recurring tasks auto-expire after ${DEFAULT_MAX_AGE_DAYS} days — they fire one final time, then are removed; tell the user about the ${DEFAULT_MAX_AGE_DAYS}-day limit when scheduling recurring jobs.`

export const CRON_DELETE_DESCRIPTION = 'Cancel a scheduled cron job by ID'
export const CRON_DELETE_PROMPT = `Cancel a cron job previously scheduled with ${CRON_CREATE_TOOL_NAME} (durable or session-only).`

export const CRON_LIST_DESCRIPTION = 'List scheduled cron jobs'
export const CRON_LIST_PROMPT = `List all cron jobs scheduled via ${CRON_CREATE_TOOL_NAME}, both durable and session-only.`
