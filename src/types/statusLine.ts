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
  output_style: {
    name: string
  }
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
    context_window_size: number
    current_usage: number
    used_percentage: number
    remaining_percentage: number
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
