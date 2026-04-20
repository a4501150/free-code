/**
 * Hook-output truncation limits.
 *
 * This leaf lives separately from `./settings.ts` so callers running during
 * bootstrap (e.g. `processUserInput`) can read the setting without forming a
 * circular dependency with settings initialization. We touch only
 * `settingsCache.ts`, which has no transitive imports back into the main
 * settings loader or bootstrap.
 */

import { getSessionSettingsCache } from './settingsCache.js'

export const MAX_HOOK_OUTPUT_LENGTH_DEFAULT = 100_000

/**
 * Resolve the configured hook-output truncation length, falling back to the
 * built-in default when settings have not yet been loaded into the session
 * cache.
 */
export function getMaxHookOutputLength(): number {
  const cached = getSessionSettingsCache()
  return cached?.settings?.maxHookOutputLength ?? MAX_HOOK_OUTPUT_LENGTH_DEFAULT
}
