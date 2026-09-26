/**
 * Standalone agent utilities for sessions with custom names/colors
 * (set via /rename and /color).
 */

import type { AppState } from '../state/AppStateStore.js'

/**
 * Returns the standalone agent name, if one was set.
 */
export function getStandaloneAgentName(appState: AppState): string | undefined {
  return appState.standaloneAgentContext?.name
}
