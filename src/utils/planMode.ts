import { FILE_READ_TOOL_NAME } from '../tools/FileReadTool/prompt.js'
import { GLOB_TOOL_NAME } from '../tools/GlobTool/prompt.js'
import { GREP_TOOL_NAME } from '../tools/GrepTool/prompt.js'
import { getRateLimitTier, getSubscriptionType } from './auth.js'
import { getCurrentProjectConfig } from './config.js'
import { shouldPreferBashForSearch } from './embeddedTools.js'
import { isEnvDefinedFalsy } from './envUtils.js'
import { getInitialSettings } from './settings/settings.js'

export function getPlanModeAgentCount(): number {
  // Environment variable override takes precedence
  if (process.env.CLAUDE_CODE_PLAN_AGENT_COUNT) {
    const count = parseInt(process.env.CLAUDE_CODE_PLAN_AGENT_COUNT, 10)
    if (!isNaN(count) && count > 0 && count <= 10) {
      return count
    }
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
  if (process.env.CLAUDE_CODE_PLAN_EXPLORE_AGENT_COUNT) {
    const count = parseInt(process.env.CLAUDE_CODE_PLAN_EXPLORE_AGENT_COUNT, 10)
    if (!isNaN(count) && count > 0 && count <= 10) {
      return count
    }
  }

  return 3
}

/**
 * Check if plan mode interview phase is enabled.
 *
 * Config: always on, envVar=CLAUDE_CODE_PLAN_MODE_INTERVIEW_PHASE can disable
 */
export function isPlanModeInterviewPhaseEnabled(): boolean {
  const env = process.env.CLAUDE_CODE_PLAN_MODE_INTERVIEW_PHASE
  if (isEnvDefinedFalsy(env)) return false
  return getInitialSettings()?.planModeInterviewPhase ?? false
}

export function getReadOnlyToolNames(): string {
  // When Glob/Grep are stripped from the registry, point at find/grep via
  // Bash instead.
  const tools = shouldPreferBashForSearch()
    ? [FILE_READ_TOOL_NAME, '`find`', '`grep`']
    : [FILE_READ_TOOL_NAME, GLOB_TOOL_NAME, GREP_TOOL_NAME]
  const { allowedTools } = getCurrentProjectConfig()
  // allowedTools is a tool-name allowlist. find/grep are shell commands, not
  // tool names, so the filter is only meaningful for the dedicated-tools branch.
  const filtered =
    allowedTools && allowedTools.length > 0 && !shouldPreferBashForSearch()
      ? tools.filter(t => allowedTools.includes(t))
      : tools
  return filtered.join(', ')
}

/**
 * Snapshotted plan-mode context stored on a `plan_mode` Attachment at creation
 * time. Reading these dynamically at render time would let an OLD attachment's
 * text drift across turns whenever the underlying state changes (e.g.
 * subscription tier rotates on a token refresh, or `allowedTools` is edited
 * mid-session in a `DEDICATED_SEARCH_TOOLS` build). That drift would bust the
 * prompt-cache prefix. Snapshotting freezes each attachment's text to the
 * values that were live when it was emitted.
 *
 * See CLAUDE.md "Fingerprint stability depends on msg[0] being byte-stable".
 */
export type PlanModeRenderContext = {
  agentCount: number
  exploreAgentCount: number
  interviewPhase: boolean
  /** Comma-joined display string of read-only tools, e.g. "FileRead, `find`, `grep`". */
  readOnlyToolNames: string
}

export function snapshotPlanModeRenderContext(): PlanModeRenderContext {
  return {
    agentCount: getPlanModeAgentCount(),
    exploreAgentCount: getPlanModeExploreAgentCount(),
    interviewPhase: isPlanModeInterviewPhaseEnabled(),
    readOnlyToolNames: getReadOnlyToolNames(),
  }
}
