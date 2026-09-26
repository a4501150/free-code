import type { AgentId } from 'src/types/ids.js'
import type { z } from 'zod/v4'
import type { Tool } from '../Tool.js'
import { EXIT_PLAN_MODE_TOOL_NAME } from '../tools/ExitPlanModeTool/constants.js'

/**
 * Tool-specific corrections for input parsed from the API stream. Tools
 * that need corrections implement Tool.normalizeInput (dispatched below —
 * add a hook there rather than a case here); the BackgroundTaskOutput arm
 * is legacy replay for a removed tool that no longer has a Tool object to
 * normalize itself.
 */
export function normalizeToolInput<T extends Tool>(
  tool: T,
  input: z.infer<T['inputSchema']>,
  agentId?: AgentId,
): z.infer<T['inputSchema']> {
  const normalize = tool.normalizeInput
  if (normalize) {
    // SAFETY: TS can't narrow the generic T through the hook lookup; the
    // hook is declared on the same T, so input and the return value are
    // already T['inputSchema']-shaped.
    return normalize.call(tool, input as never, { agentId }) as z.infer<
      T['inputSchema']
    >
  }
  switch (tool.name) {
    case 'BackgroundTaskOutput': {
      // The tool was removed; this case stays so transcripts recorded
      // before removal replay cleanly. Normalizes legacy parameter names
      // from AgentOutputTool/BashOutputTool.
      const legacyInput = input as Record<string, unknown>
      const taskId =
        legacyInput.task_id ?? legacyInput.agentId ?? legacyInput.bash_id
      const timeout =
        legacyInput.timeout ??
        (typeof legacyInput.wait_up_to === 'number'
          ? legacyInput.wait_up_to * 1000
          : undefined)
      return {
        task_id: taskId ?? '',
        block: legacyInput.block ?? true,
        timeout: timeout ?? 30000,
      } as z.infer<T['inputSchema']>
    }
    default:
      return input
  }
}

// Strips fields that were added by normalizeToolInput before sending to API
// (e.g., plan field from ExitPlanModeV2 which has an empty input schema)
export function normalizeToolInputForAPI<T extends Tool>(
  tool: T,
  input: z.infer<T['inputSchema']>,
): z.infer<T['inputSchema']> {
  switch (tool.name) {
    case EXIT_PLAN_MODE_TOOL_NAME: {
      // Strip injected fields before sending to API (schema expects empty object)
      if (
        input &&
        typeof input === 'object' &&
        ('plan' in input || 'planFilePath' in input)
      ) {
        const { plan, planFilePath, ...rest } = input as Record<string, unknown>
        return rest as z.infer<T['inputSchema']>
      }
      return input
    }
    default:
      return input
  }
}
