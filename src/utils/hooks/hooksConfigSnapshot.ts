import { resetSdkInitState } from '../../bootstrap/state.js'
// Import as module object so spyOn works in tests (direct imports bypass spies)
import * as settingsModule from '../settings/settings.js'
import { resetSettingsCache } from '../settings/settingsCache.js'
import type { HooksSettings } from '../settings/types.js'

let initialHooksConfig: HooksSettings | null = null

/**
 * Whether `disableAllHooks` is set in any settings source.
 *
 * Callers must consult this for every hook channel, not just settings-defined
 * hooks: plugin-registered hooks and session-derived (agent/skill frontmatter)
 * hooks are assembled separately in hooks.ts and would otherwise keep running.
 */
export function areAllHooksDisabled(): boolean {
  return settingsModule.getSettings_DEPRECATED().disableAllHooks === true
}

function getHooksFromAllowedSources(): HooksSettings {
  if (areAllHooksDisabled()) {
    return {}
  }
  return settingsModule.getSettings_DEPRECATED().hooks ?? {}
}

/**
 * Capture a snapshot of the current hooks configuration
 * This should be called once during application startup
 */
export function captureHooksConfigSnapshot(): void {
  initialHooksConfig = getHooksFromAllowedSources()
}

/**
 * Update the hooks configuration snapshot
 * This should be called when hooks are modified through the settings
 */
export function updateHooksConfigSnapshot(): void {
  // Reset the session cache to ensure we read fresh settings from disk.
  // Without this, the snapshot could use stale cached settings when the user
  // edits freecode.json externally and then runs /hooks - the session cache
  // may not have been invalidated yet (e.g., if the file watcher's stability
  // threshold hasn't elapsed).
  resetSettingsCache()
  initialHooksConfig = getHooksFromAllowedSources()
}

/**
 * Get the current hooks configuration from snapshot
 * Falls back to settings if no snapshot exists
 * @returns The hooks configuration
 */
export function getHooksConfigFromSnapshot(): HooksSettings | null {
  if (initialHooksConfig === null) {
    captureHooksConfigSnapshot()
  }
  return initialHooksConfig
}

/**
 * Reset the hooks configuration snapshot (useful for testing)
 * Also resets SDK init state to prevent test pollution
 */
export function resetHooksConfigSnapshot(): void {
  initialHooksConfig = null
  resetSdkInitState()
}
