/**
 * Coordinator mode gate — leaf module.
 *
 * Single source of truth for the `isCoordinatorMode()` check. Extracted from
 * coordinatorMode.ts so callers can depend on this tiny leaf without pulling
 * in the rest of coordinatorMode.
 */

import { isEnvTruthy } from '../utils/envUtils.js'

export function isCoordinatorMode(): boolean {
  return isEnvTruthy(process.env.CLAUDE_CODE_COORDINATOR_MODE)
}
