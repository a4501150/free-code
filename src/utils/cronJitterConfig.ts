// Settings-backed cron jitter configuration.
//
// Separated from cronScheduler.ts so the scheduler can be bundled in the
// Agent SDK public build without pulling in settings and its large
// transitive dependency set.
//
// Usage:
//   REPL (useScheduledTasks.ts): pass `getJitterConfig: getCronJitterConfig`
//   Daemon/SDK: omit getJitterConfig → DEFAULT_CRON_JITTER_CONFIG applies.

import {
  type CronJitterConfig,
  DEFAULT_CRON_JITTER_CONFIG,
} from './cronTasks.js'
import { getInitialSettings } from './settings/settings.js'

/**
 * Read cron jitter config from settings.json, fall back to defaults.
 * Called from check() every tick via the `getJitterConfig` callback —
 * cheap (synchronous settings read).
 *
 * Exported so ops runbooks can point at a single function when documenting
 * the lever, and so tests can spy on it without mocking settings.
 *
 * Pass this as `getJitterConfig` when calling createCronScheduler in REPL
 * contexts. Daemon/SDK callers omit getJitterConfig and get defaults.
 */
export function getCronJitterConfig(): CronJitterConfig {
  return getInitialSettings()?.cronJitterConfig ?? DEFAULT_CRON_JITTER_CONFIG
}
