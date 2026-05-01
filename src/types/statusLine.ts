import type { CurrentUsage } from '../utils/tokens.js'

/**
 * Input passed to the user-configured `statusLine` hook command.
 * Shape is mirrored from buildStatusLineCommandInput in
 * src/components/StatusLine.tsx — every conditionally spread field is
 * reflected as optional here.
 */
export type StatusLineCommandInput = {
  // Fields from createBaseHookInput (src/utils/hooks.ts)
  session_id: string
  transcript_path: string
  cwd: string
  permission_mode?: string
  agent_id?: string
  agent_type?: string

  session_name?: string
  model: {
    id: string
    display_name: string
  }
  workspace: {
    current_dir: string
    project_dir: string
    added_dirs: string[]
  }
  version: string
  cost: {
    total_cost_usd: number
    total_duration_ms: number
    total_api_duration_ms: number
    total_lines_added: number
    total_lines_removed: number
  }
  context_window: {
    total_input_tokens: number
    total_output_tokens: number
    /**
     * Session-cumulative tokens written to provider cache. `0` for providers
     * that do not distinguish cache-write cost (OpenAI, Codex, Gemini without
     * explicit cachedContent). See NormalizedUsage in
     * src/utils/normalizedUsage.ts for the underlying semantic.
     */
    total_cache_creation_input_tokens: number
    /** Session-cumulative tokens served from provider cache. */
    total_cache_read_input_tokens: number
    context_window_size: number
    current_usage: CurrentUsage | null
    used_percentage: number | null
    remaining_percentage: number | null
  }
  /**
   * Per-turn usage breakdown from the most recent API response. `0` on
   * fields the provider does not report. Populated alongside the cumulative
   * `context_window` counters so status-line scripts can display a "last
   * turn cost N tokens" metric without re-reading the transcript.
   */
  last_usage?: {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens: number
    cache_read_input_tokens: number
  }
  exceeds_200k_tokens: boolean
  rate_limits?: {
    five_hour?: {
      used_percentage: number
      resets_at: string | number
    }
    seven_day?: {
      used_percentage: number
      resets_at: string | number
    }
  }
  vim?: {
    mode: string
  }
  agent?: {
    name: string
  }
  worktree?: {
    name: string
    path: string
    branch: string | undefined
    original_cwd: string
    original_branch: string | undefined
  }
}
