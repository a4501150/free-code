import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import {
  getRunningOwnedShellTasks,
  namedTaskIds,
} from '../../tasks/ownership.js'
import { BACKGROUND_TASK_STOP_TOOL_NAME } from '../BackgroundTaskStopTool/prompt.js'
import { DESCRIPTION, FINISH_RUN_TOOL_NAME } from './constants.js'

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
 * the parent is the agent's most recent assistant text, skipping ack text
 * emitted in reply to a finish-run reminder (finalizeAgentTool's
 * extraction). The EndTurn alias keeps tool_use blocks from pre-rename
 * transcripts resolvable by name (findToolByName).
 *
 * Deliberately React-free (no renderToolResultMessage): the run's completion
 * is surfaced by the Agent tool's own UI, not by this tool's result row, and
 * runAgent's module graph must stay ink-free.
 */
export const FinishRunTool = buildTool({
  name: FINISH_RUN_TOOL_NAME,
  aliases: ['EndTurn'],
  userFacingName: () => 'Finish Run',
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
    return 'End your run now, killing owned background tasks; not needed to finish — a final text message with no tool calls completes the run and is your result'
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
  async call(_input, toolUseContext) {
    // The owned-tasks gate lives in runAgent (strike semantics, parks), but
    // its decision arrives only after this result. Claiming completion here
    // while the gate is about to refuse produced "Run complete." followed
    // by "was not carried out" in the same turn — state the truth instead.
    const ownedTasks = getRunningOwnedShellTasks(
      toolUseContext.agentId,
      toolUseContext.getAppState,
    )
    if (ownedTasks.length > 0) {
      return {
        data: {
          message: `FinishRun received, but you still own ${ownedTasks.length} running background task(s) (${namedTaskIds(ownedTasks.map(t => t.id))}), so the run is not complete yet. To wait for them, reply with no tool calls at all — the run parks and their completion notifications wake you. To end the run now, stop them with ${BACKGROUND_TASK_STOP_TOOL_NAME} or call ${FINISH_RUN_TOOL_NAME} again with no work between.`,
        },
      }
    }
    return { data: { message: 'Run complete.' } }
  },
} satisfies ToolDef<InputSchema, Output>)
