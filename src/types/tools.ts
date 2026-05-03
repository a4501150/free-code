/**
 * Centralized progress-data types for every tool that streams progress
 * updates back to the UI. Living in its own module (re-exported from
 * src/Tool.ts) avoids import cycles between Tool.ts and the individual
 * tool modules.
 *
 * Each variant's type string is the discriminator the UI and replay code
 * switch on — see src/utils/queryHelpers.ts and src/utils/messages.ts
 * for consumers.
 */

import type { NormalizedMessage } from './message.js'

/** Common fields emitted by both Bash and PowerShell shell backends. */
export type ShellProgress = BashProgress | PowerShellProgress

export type BashProgress = {
  type: 'bash_progress'
  /** Trailing window of the shell output shown live. */
  output: string
  /** Full output accumulated so far (may be truncated/head-tail). */
  fullOutput: string
  elapsedTimeSeconds: number
  totalLines: number
  totalBytes: number
  taskId?: string
  timeoutMs?: number
}

export type PowerShellProgress = {
  type: 'powershell_progress'
  output: string
  fullOutput: string
  elapsedTimeSeconds: number
  totalLines: number
  totalBytes: number
  taskId?: string
  timeoutMs?: number
}

export type WebSearchProgress =
  | {
      type: 'query_update'
      query: string
    }
  | {
      type: 'search_results_received'
      resultCount: number
      query: string
    }

export type SkillToolProgress = {
  type: 'skill_progress'
  /** Normalized forked-agent message that triggered the progress. */
  message: NormalizedMessage
  prompt: string
  agentId?: string
}

export type AgentToolProgress = {
  type: 'agent_progress'
  message: NormalizedMessage
  prompt: string
  agentId?: string
}

export type MCPProgress =
  | {
      type: 'mcp_progress'
      status: 'started'
      serverName: string
      toolName: string
    }
  | {
      type: 'mcp_progress'
      status: 'completed' | 'failed'
      serverName: string
      toolName: string
      elapsedTimeMs: number
    }
  | {
      type: 'mcp_progress'
      status: 'progress'
      serverName: string
      toolName: string
      progress: number
      total?: number
      progressMessage?: string
    }

export type TaskOutputProgress = {
  type: 'waiting_for_task'
  taskId?: string
  taskDescription?: string
  taskType?: string
}

/** Progress emitted by the REPL pseudo-tool — JSX injected directly. */
export type REPLToolProgress = {
  type: 'repl_progress'
  message?: string
}

/**
 * Union of every tool-emitted progress payload. The UI renders based on
 * `data.type`; adding a new progress type elsewhere requires adding it
 * here too.
 */
export type ToolProgressData =
  | BashProgress
  | PowerShellProgress
  | WebSearchProgress
  | SkillToolProgress
  | AgentToolProgress
  | MCPProgress
  | TaskOutputProgress
  | REPLToolProgress
