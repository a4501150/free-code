import { getInitialSettings } from './settings/settings.js'

/**
 * Whether background (async) task execution is enabled. Controlled by the
 * `backgroundTasksEnabled` settings key; defaults to enabled.
 */
export function isBackgroundTasksEnabled(): boolean {
  return getInitialSettings().backgroundTasksEnabled ?? true
}
