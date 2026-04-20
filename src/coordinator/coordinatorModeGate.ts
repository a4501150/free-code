/**
 * Coordinator mode gate — leaf module.
 *
 * Single source of truth for the `isCoordinatorMode()` check. Extracted from
 * coordinatorMode.ts so callers can depend on this tiny leaf without pulling
 * in the rest of coordinatorMode (which imports constants/tools and creates
 * cycles through ToolSearchTool/prompt and AgentTool).
 */

import { feature } from 'bun:bundle'
import { isEnvTruthy } from '../utils/envUtils.js'

export function isCoordinatorMode(): boolean {
  if (feature('COORDINATOR_MODE')) {
    return isEnvTruthy(process.env.CLAUDE_CODE_COORDINATOR_MODE)
  }
  return false
}
