/**
 * The statusline payload, framework-free.
 *
 * The producer half of the statusline command contract: gate
 * (`statusLineShouldDisplay`) and payload builder
 * (`buildStatusLineCommandInput`) extracted from `components/StatusLine.tsx`
 * so a host without React — the in-process sessiond's hosted session
 * (`src/sessiond/hostedStatusLine.ts`) — can run the very same command with
 * the very same payload. The classic REPL component and the hosted driver
 * must not drift on what the user's script sees on stdin.
 *
 * Not framework-free in effect only: every accessor it reads is
 * session-scoped bootstrap/cost state, so call it inside the owning
 * session's scope (`runInSessionScope`) when more than one session lives in
 * the process.
 */
import {
  getAssistantActive,
  getMainThreadAgentType,
  getOriginalCwd,
  getSdkBetas,
  getSessionId,
} from '../bootstrap/state.js'
import type { PermissionMode } from '../utils/permissions/PermissionMode.js'
import {
  getTotalAPIDuration,
  getTotalCacheCreationInputTokens,
  getTotalCacheReadInputTokens,
  getTotalCost,
  getTotalDuration,
  getTotalInputTokens,
  getTotalLinesAdded,
  getTotalLinesRemoved,
  getTotalOutputTokens,
} from '../cost-tracker.js'
import type { ReadonlySettings } from '../hooks/useSettings.js'
import { getRawUtilization } from '../services/claudeAiLimits.js'
import type { Message } from '../types/message.js'
import type { StatusLineCommandInput } from '../types/statusLine.js'
import type { VimMode } from '../types/textInputTypes.js'
import {
  calculateContextPercentages,
  getContextWindowForModel,
} from '../utils/context.js'
import { getCwd } from '../utils/cwd.js'
import { createBaseHookInput } from '../utils/hooks.js'
import { getLastAssistantMessage } from '../utils/messages.js'
import {
  getRuntimeMainLoopModel,
  type ModelName,
  renderModelName,
} from '../utils/model/model.js'
import { getCurrentSessionTitle } from '../utils/sessionStorage.js'
import {
  doesMostRecentAssistantMessageExceed200k,
  getCurrentUsage,
} from '../utils/tokens.js'
import { getCurrentWorktreeSession } from '../utils/worktree.js'
import { isVimModeEnabled } from '../components/PromptInput/utils.js'

export function statusLineShouldDisplay(
  settings?: ReadonlySettings | null,
): boolean {
  // Assistant mode: statusline fields (model, permission mode, cwd) reflect the
  // REPL/daemon process, not what the agent child is actually running. Hide it.
  if (getAssistantActive()) return false
  const statusLine = settings?.statusLine
  if (statusLine) return statusLine.type !== 'off'
  // No user config: the embedded default script runs, unless hooks are disabled.
  return settings?.disableAllHooks !== true
}

export function buildStatusLineCommandInput(
  permissionMode: PermissionMode,
  exceeds200kTokens: boolean,
  settings: ReadonlySettings,
  messages: Message[],
  addedDirs: string[],
  mainLoopModel: ModelName,
  vimMode?: VimMode,
  isViewedWorkerModel?: boolean,
): StatusLineCommandInput {
  const agentType = getMainThreadAgentType()
  const worktreeSession = getCurrentWorktreeSession()
  // When displaying a viewed worker's model, skip runtime resolution —
  // the subagent model is already fully resolved and should not be
  // replaced by planModeModel or other main-loop overrides.
  const runtimeModel = isViewedWorkerModel
    ? mainLoopModel
    : getRuntimeMainLoopModel({
        permissionMode,
        mainLoopModel,
        exceeds200kTokens,
      })
  const currentUsage = getCurrentUsage(messages)
  const contextWindowSize = getContextWindowForModel(
    runtimeModel,
    getSdkBetas(),
  )
  const contextPercentages = calculateContextPercentages(
    currentUsage,
    contextWindowSize,
  )

  const sessionId = getSessionId()
  const sessionName = getCurrentSessionTitle(sessionId)
  const rawUtil = getRawUtilization()
  const rateLimits: StatusLineCommandInput['rate_limits'] = {
    ...(rawUtil.five_hour && {
      five_hour: {
        used_percentage: rawUtil.five_hour.utilization * 100,
        resets_at: rawUtil.five_hour.resets_at,
      },
    }),
    ...(rawUtil.seven_day && {
      seven_day: {
        used_percentage: rawUtil.seven_day.utilization * 100,
        resets_at: rawUtil.seven_day.resets_at,
      },
    }),
  }
  return {
    ...createBaseHookInput(),
    ...(sessionName && { session_name: sessionName }),
    model: {
      id: runtimeModel,
      display_name: renderModelName(runtimeModel),
    },
    workspace: {
      current_dir: getCwd(),
      project_dir: getOriginalCwd(),
      added_dirs: addedDirs,
    },
    version: MACRO.VERSION,
    cost: {
      total_cost_usd: getTotalCost(),
      total_duration_ms: getTotalDuration(),
      total_api_duration_ms: getTotalAPIDuration(),
      total_lines_added: getTotalLinesAdded(),
      total_lines_removed: getTotalLinesRemoved(),
    },
    context_window: {
      total_input_tokens: getTotalInputTokens(),
      total_output_tokens: getTotalOutputTokens(),
      total_cache_creation_input_tokens: getTotalCacheCreationInputTokens(),
      total_cache_read_input_tokens: getTotalCacheReadInputTokens(),
      context_window_size: contextWindowSize,
      current_usage: currentUsage,
      used_percentage: contextPercentages.used,
      remaining_percentage: contextPercentages.remaining,
    },
    ...(currentUsage && {
      last_usage: {
        input_tokens: currentUsage.input_tokens,
        output_tokens: currentUsage.output_tokens,
        cache_creation_input_tokens: currentUsage.cache_creation_input_tokens,
        cache_read_input_tokens: currentUsage.cache_read_input_tokens,
      },
    }),
    exceeds_200k_tokens: exceeds200kTokens,
    ...((rateLimits.five_hour || rateLimits.seven_day) && {
      rate_limits: rateLimits,
    }),
    ...(isVimModeEnabled() && {
      vim: {
        mode: vimMode ?? 'INSERT',
      },
    }),
    ...(agentType && {
      agent: {
        name: agentType,
      },
    }),
    ...(worktreeSession && {
      worktree: {
        name: worktreeSession.worktreeName,
        path: worktreeSession.worktreePath,
        branch: worktreeSession.worktreeBranch,
        original_cwd: worktreeSession.originalCwd,
        original_branch: worktreeSession.originalBranch,
      },
    }),
  }
}

/** The classic component's re-render trigger, shared with the hosted driver. */
export function getLastAssistantMessageId(messages: Message[]): string | null {
  return getLastAssistantMessage(messages)?.uuid ?? null
}
