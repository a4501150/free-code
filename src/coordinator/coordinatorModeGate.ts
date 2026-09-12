/**
 * Coordinator mode gate — leaf module.
 *
 * Single source of truth for the `isCoordinatorMode()` check. Extracted from
 * coordinatorMode.ts so callers can depend on this tiny leaf without pulling
 * in the rest of coordinatorMode.
 */

import { getInitialSettings } from '../utils/settings/settings.js'

// In-process override, set by --tasks startup and by session-mode matching on
// resume. Module state (not env) so resumed sessions and in-process workers all
// observe the flip.
let coordinatorModeOverride: boolean | undefined

export function setCoordinatorModeOverride(on: boolean): void {
  coordinatorModeOverride = on
}

export function isCoordinatorMode(): boolean {
  if (coordinatorModeOverride !== undefined) {
    return coordinatorModeOverride
  }
  return getInitialSettings().coordinatorMode === true
}
