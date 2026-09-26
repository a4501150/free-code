import { writeFile } from 'fs/promises'
import { ExitPlanModePermissionRequest } from '../../components/permissions/ExitPlanModePermissionRequest/ExitPlanModePermissionRequest.js'
import { z } from 'zod/v4'
import * as autoModeStateNs from '../../utils/permissions/autoModeState.js'
import * as permissionSetupNs from '../../utils/permissions/permissionSetup.js'
import {
  getAllowedChannels,
  hasExitedPlanModeInSession,
  setHasExitedPlanMode,
  setNeedsAutoModeExitAttachment,
  setNeedsPlanModeExitAttachment,
} from '../../bootstrap/state.js'

import { buildTool, type Tool, type ToolDef } from '../../Tool.js'
import { logForDebugging } from '../../utils/debug.js'
import { logError } from '../../utils/log.js'
import {
  getPlan,
  getPlanFilePath,
  persistFileSnapshotIfRemote,
} from '../../utils/plans.js'
import { EXIT_PLAN_MODE_TOOL_NAME } from './constants.js'
import { EXIT_PLAN_MODE_TOOL_PROMPT } from './prompt.js'
import {
  renderToolResultMessage,
  renderToolUseMessage,
  renderToolUseRejectedMessage,
} from './UI.js'

const inputSchema = z.strictObject({}).passthrough()
type InputSchema = typeof inputSchema

/**
 * SDK-facing input schema - includes fields injected by normalizeToolInput.
 * The internal inputSchema doesn't have these fields because plan is read from disk,
 * but the SDK/hooks see the normalized version with plan and file path included.
 */
export const _sdkInputSchema = inputSchema.extend({
  plan: z
    .string()
    .optional()
    .describe('The plan content (injected by normalizeToolInput from disk)'),
  planFilePath: z
    .string()
    .optional()
    .describe('The plan file path (injected by normalizeToolInput)'),
})

export const outputSchema = z.object({
  plan: z
    .string()
    .nullable()
    .describe('The plan that was presented to the user'),
  isAgent: z.boolean(),
  filePath: z
    .string()
    .optional()
    .describe('The file path where the plan was saved'),
  planWasEdited: z
    .boolean()
    .optional()
    .describe(
      'True when the user edited the plan (CCR web UI or Ctrl+G); determines whether the plan is echoed back in tool_result',
    ),
})
type OutputSchema = typeof outputSchema

export type Output = z.infer<OutputSchema>

export const ExitPlanModeTool: Tool<InputSchema, Output> = buildTool({
  renderPermissionRequest: () => ExitPlanModePermissionRequest,

  name: EXIT_PLAN_MODE_TOOL_NAME,
  maxResultSizeChars: 100_000,
  async description() {
    return 'Prompts the user to exit plan mode and start coding'
  },
  async prompt() {
    return EXIT_PLAN_MODE_TOOL_PROMPT
  },
  get inputSchema(): InputSchema {
    return inputSchema
  },
  get outputSchema(): OutputSchema {
    return outputSchema
  },
  userFacingName() {
    return ''
  },
  isEnabled() {
    // When --channels is active the user is likely on Telegram/Discord, not
    // watching the TUI. The plan-approval dialog would hang. Paired with the
    // same gate on EnterPlanMode so plan mode isn't a trap.
    if (getAllowedChannels().length > 0) {
      return false
    }
    return true
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return false // Now writes to disk
  },
  requiresUserInteraction() {
    return true
  },
  async validateInput(_input, { getAppState }) {
    // Reject before checkPermissions to avoid showing the approval dialog.
    const mode = getAppState().toolPermissionContext.mode
    if (mode !== 'plan') {
      return {
        result: false,
        message:
          'You are not in plan mode. This tool is only for exiting plan mode after writing a plan-mode plan. If your plan was already approved, continue with implementation. If approval-before-coding is required, call EnterPlanMode first.',
        errorCode: 1,
      }
    }
    return { result: true }
  },
  async checkPermissions(input, _context) {
    // Require user confirmation to exit plan mode
    return {
      behavior: 'ask' as const,
      message: 'Exit plan mode?',
      updatedInput: input,
    }
  },
  normalizeInput(input, ctx) {
    // Always inject plan content and file path for ExitPlanModeV2 so
    // hooks/SDK get the plan. The V2 tool reads plan from file instead of
    // input, but hooks/SDK see the normalized version (see _sdkInputSchema).
    const plan = getPlan(ctx?.agentId)
    const planFilePath = getPlanFilePath(ctx?.agentId)
    // Persist file snapshot for CCR sessions so the plan survives pod recycling
    void persistFileSnapshotIfRemote()
    return plan !== null ? { ...input, plan, planFilePath } : input
  },
  renderToolUseMessage,
  renderToolResultMessage,
  renderToolUseRejectedMessage,
  async call(input, context) {
    const isAgent = !!context.agentId

    const filePath = getPlanFilePath(context.agentId)
    // CCR web UI may send an edited plan via permissionResult.updatedInput.
    // queryHelpers.ts full-replaces finalInput, so when CCR sends {} (no edit)
    // input.plan is undefined -> disk fallback. The internal inputSchema omits
    // `plan` (normally injected by normalizeToolInput), hence the narrowing.
    const inputPlan =
      'plan' in input && typeof input.plan === 'string' ? input.plan : undefined
    const plan = inputPlan ?? getPlan(context.agentId)

    // Sync disk so VerifyPlanExecution / Read see the edit. Re-snapshot
    // after: the only other persistFileSnapshotIfRemote call (api.ts) runs
    // in normalizeToolInput, pre-permission — it captured the old plan.
    if (inputPlan !== undefined && filePath) {
      await writeFile(filePath, inputPlan, 'utf-8').catch(e => logError(e))
      void persistFileSnapshotIfRemote()
    }

    // Note on plan verification (VERIFY_PLAN feature): after context clear,
    // REPL.processInitialMessage stores pendingPlanVerification on appState.
    // The main model sees a verify_plan_reminder attachment every 10 turns
    // until it calls VerifyPlanExecution, whose call() spawns a verifier
    // subagent and flips verificationStarted/Completed. No separate hook is
    // registered — the tool itself drives the verification inline.

    // Ensure mode is changed when exiting plan mode.
    // This handles cases where permission flow didn't set the mode
    // (e.g., when PermissionRequest hook auto-approves without providing updatedPermissions).
    const appState = context.getAppState()
    // Compute gate-off fallback before setAppState so we can notify the user.
    // Circuit breaker defense: if prePlanMode was an auto-like mode but the
    // gate is now off (circuit breaker or settings disable), restore to
    // 'default' instead. Without this, ExitPlanMode would bypass the circuit
    // breaker by calling setAutoModeActive(true) directly.
    let gateFallbackNotification: string | null = null
    const prePlanRaw = appState.toolPermissionContext.prePlanMode ?? 'default'
    if (prePlanRaw === 'auto' && !permissionSetupNs.isAutoModeGateEnabled()) {
      const reason =
        permissionSetupNs.getAutoModeUnavailableReason() ?? 'circuit-breaker'
      gateFallbackNotification =
        permissionSetupNs.getAutoModeUnavailableNotification(reason) ??
        'auto mode unavailable'
      logForDebugging(
        `[auto-mode gate @ ExitPlanModeTool] prePlanMode=${prePlanRaw} ` +
          `but gate is off (reason=${reason}) — falling back to default on plan exit`,
        { level: 'warn' },
      )
    }
    if (gateFallbackNotification) {
      context.addNotification?.({
        key: 'auto-mode-gate-plan-exit-fallback',
        text: `plan exit → default · ${gateFallbackNotification}`,
        priority: 'immediate',
        color: 'warning',
        timeoutMs: 10000,
      })
    }

    context.setAppState(prev => {
      if (prev.toolPermissionContext.mode !== 'plan') return prev
      setHasExitedPlanMode(true)
      setNeedsPlanModeExitAttachment(true)
      let restoreMode = prev.toolPermissionContext.prePlanMode ?? 'default'
      if (
        restoreMode === 'auto' &&
        !permissionSetupNs.isAutoModeGateEnabled()
      ) {
        restoreMode = 'default'
      }
      const finalRestoringAuto = restoreMode === 'auto'
      // Capture pre-restore state — isAutoModeActive() is the authoritative
      // signal (prePlanMode/strippedDangerousRules are stale after
      // transitionPlanAutoMode deactivates mid-plan).
      const autoWasUsedDuringPlan = autoModeStateNs.isAutoModeActive()
      autoModeStateNs.setAutoModeActive(finalRestoringAuto)
      if (autoWasUsedDuringPlan && !finalRestoringAuto) {
        setNeedsAutoModeExitAttachment(true)
      }
      // If restoring to a non-auto mode and permissions were stripped (either
      // from entering plan from auto, or from shouldPlanUseAutoMode),
      // restore them. If restoring to auto, keep them stripped.
      const restoringToAuto = restoreMode === 'auto'
      let baseContext = prev.toolPermissionContext
      if (restoringToAuto) {
        baseContext =
          permissionSetupNs.stripDangerousPermissionsForAutoMode(baseContext)
      } else if (prev.toolPermissionContext.strippedDangerousRules) {
        baseContext = permissionSetupNs.restoreDangerousPermissions(baseContext)
      }
      return {
        ...prev,
        toolPermissionContext: {
          ...baseContext,
          mode: restoreMode,
          prePlanMode: undefined,
        },
      }
    })

    return {
      data: {
        plan,
        isAgent,
        filePath,
        planWasEdited: inputPlan !== undefined || undefined,
      },
    }
  },
  mapToolResultToToolResultBlockParam(
    { isAgent, plan, filePath, planWasEdited },
    toolUseID,
  ) {
    if (isAgent) {
      return {
        type: 'tool_result',
        content:
          'User has approved the plan. There is nothing else needed from you now. Please respond with "ok"',
        tool_use_id: toolUseID,
      }
    }

    // Handle empty plan
    if (!plan || plan.trim() === '') {
      return {
        type: 'tool_result',
        content: 'User has approved exiting plan mode. You can now proceed.',
        tool_use_id: toolUseID,
      }
    }

    // Label edited plans so the model knows the user changed something.
    const planLabel = planWasEdited
      ? 'Approved Plan (edited by user)'
      : 'Approved Plan'

    return {
      type: 'tool_result',
      content: `User has approved your plan. You can now start coding. Start with updating your todo list if applicable

Your plan has been saved to: ${filePath}
You can refer back to it if needed during implementation.

## ${planLabel}:
${plan}`,
      tool_use_id: toolUseID,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
