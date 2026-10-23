import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { DESCRIPTION, END_TURN_TOOL_NAME } from './constants.js'

const inputSchema = z.strictObject({})
type InputSchema = typeof inputSchema

const outputSchema = z.object({
  message: z.string(),
})
type OutputSchema = typeof outputSchema

export type Output = z.infer<typeof outputSchema>

/**
 * Subagent-only completion signal. Registered nowhere in the global tool
 * pool (tools.ts) — main-thread sessions never see it; runAgent injects it
 * into every subagent pool it builds. The meaningful effect happens in
 * query.ts, which watches for this tool name and ends the loop after the
 * round's tools have run, and in runAgent.ts, whose finally block then kills
 * the agent's still-running background tasks. The result text delivered to
 * the parent is the agent's most recent assistant text (finalizeAgentTool's
 * extraction, unchanged).
 *
 * Deliberately React-free (no renderToolResultMessage): the run's completion
 * is surfaced by the Agent tool's own UI, not by this tool's result row, and
 * runAgent's module graph must stay ink-free.
 */
export const EndTurnTool = buildTool({
  name: END_TURN_TOOL_NAME,
  userFacingName: () => 'End Turn',
  get inputSchema(): InputSchema {
    return inputSchema
  },
  get outputSchema(): OutputSchema {
    return outputSchema
  },
  isReadOnly() {
    // Not read-only: ending the run kills the agent's owned background
    // tasks — read-only here would feed speculation auto-approval.
    return false
  },
  isConcurrencySafe() {
    return true
  },
  async description() {
    return 'End your run; your last text message is your result'
  },
  async prompt() {
    return DESCRIPTION
  },
  async checkPermissions() {
    return { behavior: 'allow' as const }
  },
  mapToolResultToToolResultBlockParam(output: Output, toolUseID: string) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: output.message,
    }
  },
  renderToolUseMessage() {
    return 'Ending run...'
  },
  async call() {
    return { data: { message: 'Run complete.' } }
  },
} satisfies ToolDef<InputSchema, Output>)
