import type { ToolPermissionContext } from '../../Tool.js'
import { logForDebugging } from '../debug.js'
import type { PermissionMode } from './PermissionMode.js'
import {
  getAutoModeUnavailableReason,
  isAutoModeGateEnabled,
  isBypassPermissionsModeDisabled,
  transitionPermissionMode,
} from './permissionSetup.js'

// Checks both the cached isAutoModeAvailable (set at startup by
// verifyAutoModeGateAccess) and the live isAutoModeGateEnabled() — these can
// diverge if the circuit breaker or settings change mid-session. The
// live check prevents transitionPermissionMode from throwing
// (permissionSetup.ts:~559), which would silently crash the shift+tab handler
// and leave the user stuck at the current mode.
function canCycleToAuto(ctx: ToolPermissionContext): boolean {
  const gateEnabled = isAutoModeGateEnabled()
  const can = !!ctx.isAutoModeAvailable && gateEnabled
  if (!can) {
    logForDebugging(
      `[auto-mode] canCycleToAuto=false: ctx.isAutoModeAvailable=${ctx.isAutoModeAvailable} isAutoModeGateEnabled=${gateEnabled} reason=${getAutoModeUnavailableReason()}`,
    )
  }
  return can
}

// The exit when the next hop is not reachable: auto behind its gate,
// otherwise wrap to default. Shared by the plan (kill-switch on) and bypass
// cases so their exits stay in lockstep.
function nextWithoutBypass(ctx: ToolPermissionContext): PermissionMode {
  if (canCycleToAuto(ctx)) {
    return 'auto'
  }
  return 'default'
}

/**
 * Determines the next permission mode when cycling through modes with Shift+Tab.
 */
export function getNextPermissionMode(
  toolPermissionContext: ToolPermissionContext,
): PermissionMode {
  switch (toolPermissionContext.mode) {
    case 'default':
      return 'acceptEdits'

    case 'acceptEdits':
      return 'plan'

    case 'plan':
      // Bypass is part of the cycle: the Shift+Tab keypress is itself a
      // deliberate user action, so the launch-flag gate does not apply here.
      if (!isBypassPermissionsModeDisabled()) {
        return 'bypassPermissions'
      }
      return nextWithoutBypass(toolPermissionContext)

    case 'bypassPermissions':
      return nextWithoutBypass(toolPermissionContext)

    case 'dontAsk':
      // Not exposed in UI cycle yet, but return default if somehow reached
      return 'default'

    default:
      // Covers auto and any future modes — always fall back to default
      return 'default'
  }
}

/**
 * Computes the next permission mode and prepares the context for it.
 * Handles any context cleanup needed for the target mode (e.g., stripping
 * dangerous permissions when entering auto mode).
 *
 * @returns The next mode and the context to use (with dangerous permissions stripped if needed)
 */
export function cyclePermissionMode(
  toolPermissionContext: ToolPermissionContext,
): { nextMode: PermissionMode; context: ToolPermissionContext } {
  const nextMode = getNextPermissionMode(toolPermissionContext)
  let context = transitionPermissionMode(
    toolPermissionContext.mode,
    nextMode,
    toolPermissionContext,
  )
  // Entering bypass without the launch flag (Shift+Tab is enough now) must
  // still look bypass-capable to the readers of this flag — the live
  // settings-change kick-out and the SDK set_permission_mode gate — or they
  // would silently ignore a session sitting in bypass.
  if (
    nextMode === 'bypassPermissions' &&
    !context.isBypassPermissionsModeAvailable
  ) {
    context = { ...context, isBypassPermissionsModeAvailable: true }
  }
  return { nextMode, context }
}
