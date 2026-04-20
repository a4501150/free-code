import { z } from 'zod/v4'
import { feature } from 'bun:bundle'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { VERIFY_PLAN_EXECUTION_TOOL_NAME } from './constants.js'
import { spawnPlanVerifier } from './spawnPlanVerifier.js'

const inputSchema = lazySchema(() => z.strictObject({}))
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    verified: z.boolean(),
    message: z.string(),
    verdict: z.enum(['PASS', 'FAIL', 'PARTIAL']).optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

type Output = z.infer<OutputSchema>

const TOOL_DESCRIPTION = `Verify that the approved plan from plan mode has been fully implemented. Spawns a background verification subagent that reads the codebase and runs adversarial checks (builds, tests, boundary inputs) against the plan, then returns a PASS/FAIL/PARTIAL verdict.

Call this exactly once after you believe you have finished implementing the plan. The tool is only available when VERIFY_PLAN is compiled in and CLAUDE_CODE_VERIFY_PLAN is truthy — otherwise it is hidden from the model.`

export const VerifyPlanExecutionTool = buildTool({
  name: VERIFY_PLAN_EXECUTION_TOOL_NAME,
  maxResultSizeChars: 16_384,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isEnabled() {
    if (!feature('VERIFY_PLAN')) return false
    return isEnvTruthy(process.env.CLAUDE_CODE_VERIFY_PLAN)
  },
  isConcurrencySafe() {
    return false
  },
  isReadOnly() {
    return true
  },
  async description() {
    return TOOL_DESCRIPTION
  },
  async prompt() {
    return TOOL_DESCRIPTION
  },
  mapToolResultToToolResultBlockParam(output: Output, toolUseID: string) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: output.message,
    }
  },
  renderToolUseMessage() {
    return null
  },
  renderToolResultMessage() {
    return null
  },
  async call(_input, context) {
    const pending = context.getAppState().pendingPlanVerification
    if (!pending?.plan) {
      return {
        data: {
          verified: false,
          message:
            'No pending plan to verify. Did you exit plan mode in this session?',
        },
      }
    }
    if (pending.verificationCompleted) {
      return {
        data: {
          verified: true,
          message: 'Verification already completed for this plan.',
        },
      }
    }

    // Mark verification as started so the verify_plan_reminder attachment
    // stops firing while the verifier runs.
    context.setAppState(prev =>
      prev.pendingPlanVerification
        ? {
            ...prev,
            pendingPlanVerification: {
              ...prev.pendingPlanVerification,
              verificationStarted: true,
            },
          }
        : prev,
    )

    const result = await spawnPlanVerifier(
      pending.plan,
      context,
      context.abortController.signal,
    )

    context.setAppState(prev =>
      prev.pendingPlanVerification
        ? {
            ...prev,
            pendingPlanVerification: {
              ...prev.pendingPlanVerification,
              verificationCompleted: true,
            },
          }
        : prev,
    )

    return {
      data: {
        verified: result.verified,
        verdict: result.verdict,
        message: `Verdict: ${result.verdict}\n\n${result.message}`,
      },
    }
  },
} satisfies ToolDef<InputSchema, Output>)
