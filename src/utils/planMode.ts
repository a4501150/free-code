import { FILE_READ_TOOL_NAME } from '../tools/FileReadTool/prompt.js'
import { getAllowedChannels } from '../bootstrap/state.js'
import { getRateLimitTier, getSubscriptionType } from './auth.js'
import { getInitialSettings } from './settings/settings.js'
import { isBuiltInPlanAgentEnabled } from './planAgent.js'

export function getPlanModeAgentCount(): number {
  const fromSettings = getInitialSettings().planAgentCount
  if (
    typeof fromSettings === 'number' &&
    fromSettings >= 1 &&
    fromSettings <= 10
  ) {
    return fromSettings
  }

  const subscriptionType = getSubscriptionType()
  const rateLimitTier = getRateLimitTier()

  if (
    subscriptionType === 'max' &&
    rateLimitTier === 'default_claude_max_20x'
  ) {
    return 3
  }

  if (subscriptionType === 'enterprise' || subscriptionType === 'team') {
    return 3
  }

  return 1
}

export function getPlanModeExploreAgentCount(): number {
  const fromSettings = getInitialSettings().planExploreAgentCount
  if (
    typeof fromSettings === 'number' &&
    fromSettings >= 1 &&
    fromSettings <= 10
  ) {
    return fromSettings
  }

  return 3
}

/**
 * Check if plan mode interview phase is enabled.
 *
 * Config: planModeInterviewPhase in settings, default off.
 */
export function isPlanModeInterviewPhaseEnabled(): boolean {
  return getInitialSettings()?.planModeInterviewPhase ?? false
}

// Module constant: the joined string is snapshotted into plan_mode
// attachments and must be byte-stable across turns.
export const READ_ONLY_TOOL_NAMES = [
  FILE_READ_TOOL_NAME,
  '`find`',
  '`grep`',
].join(', ')

export function getReadOnlyToolNames(): string {
  return READ_ONLY_TOOL_NAMES
}

/**
 * Snapshotted plan-mode context stored on a `plan_mode` Attachment at creation
 * time. Reading these dynamically at render time would let an OLD attachment's
 * text drift across turns whenever the underlying state changes (e.g.
 * subscription tier rotates on a token refresh). That drift would bust the
 * prompt-cache prefix. Snapshotting freezes each attachment's text to the
 * values that were live when it was emitted.
 *
 * See CLAUDE.md "Fingerprint stability depends on msg[0] being byte-stable".
 */
export type PlanModeRenderContext = {
  agentCount: number
  exploreAgentCount: number
  interviewPhase: boolean
  planAgentEnabled?: boolean
  /** Comma-joined display string of read-only tools, e.g. "FileRead, `find`, `grep`". */
  readOnlyToolNames: string
  /**
   * False when AskUserQuestion/ExitPlanMode are unregistered (assistant mode +
   * --channels: their dialogs hang with nobody at the TUI; same predicate as
   * both tools' isEnabled()). Plan-mode prose must not instruct tools that
   * aren't registered.
   */
  interactiveToolsEnabled: boolean
}

export function isInteractivePlanToolEnabled(): boolean {
  if (getAllowedChannels().length > 0) {
    return false
  }
  return true
}

export function snapshotPlanModeRenderContext(): PlanModeRenderContext {
  return {
    agentCount: getPlanModeAgentCount(),
    exploreAgentCount: getPlanModeExploreAgentCount(),
    interviewPhase: isPlanModeInterviewPhaseEnabled(),
    planAgentEnabled: isBuiltInPlanAgentEnabled(),
    readOnlyToolNames: getReadOnlyToolNames(),
    interactiveToolsEnabled: isInteractivePlanToolEnabled(),
  }
}
