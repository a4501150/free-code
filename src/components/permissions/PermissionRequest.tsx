import * as React from 'react'
import { EnterPlanModeTool } from 'src/tools/EnterPlanModeTool/EnterPlanModeTool.js'
import { ExitPlanModeTool } from 'src/tools/ExitPlanModeTool/ExitPlanModeTool.js'
import { useNotifyAfterTimeout } from '../../hooks/useNotifyAfterTimeout.js'
import { useKeybinding } from '../../keybindings/useKeybinding.js'
import type { AnyObject, Tool, ToolUseContext } from '../../Tool.js'
import type { AssistantMessage } from '../../types/message.js'
import type { PermissionDecision } from '../../utils/permissions/PermissionResult.js'
import { FallbackPermissionRequest } from './FallbackPermissionRequest.js'

import type { DomainUserContentBlock } from '../../types/domain.js'
import type { z } from 'zod/v4'
import type { PermissionUpdate } from '../../utils/permissions/PermissionUpdateSchema.js'

export type PermissionRequestProps<Input extends AnyObject = AnyObject> = {
  toolUseConfirm: ToolUseConfirm<Input>
  toolUseContext: ToolUseContext
  onDone(): void
  onReject(): void
  verbose: boolean
  /**
   * Register JSX to render in a sticky footer below the scrollable area.
   * Fullscreen mode only (non-fullscreen has no sticky area — terminal
   * scrollback moves everything together). Call with null to clear.
   *
   * Used by ExitPlanModePermissionRequest to keep response options visible
   * while the user scrolls through a long plan. The callback is stable —
   * JSX passed should use refs for callbacks that close over component state
   * to avoid stale closures (React reconciles the JSX, preserving Select's
   * internal focus/input state).
   */
  setStickyFooter?: (jsx: React.ReactNode | null) => void
}

export type ToolUseConfirm<Input extends AnyObject = AnyObject> = {
  assistantMessage: AssistantMessage
  tool: Tool<Input>
  description: string
  input: z.infer<Input>
  toolUseContext: ToolUseContext
  toolUseID: string
  permissionResult: PermissionDecision
  permissionPromptStartTimeMs: number
  /** Called when user interacts with the permission dialog (e.g., arrow keys, tab, typing). */
  onUserInteraction(): void
  onAbort(): void
  onAllow(
    updatedInput: z.infer<Input>,
    permissionUpdates: PermissionUpdate[],
    feedback?: string,
    contentBlocks?: DomainUserContentBlock[],
  ): void
  onReject(feedback?: string, contentBlocks?: DomainUserContentBlock[]): void
  recheckPermission(): Promise<void>
}

function getNotificationMessage(toolUseConfirm: ToolUseConfirm): string {
  const toolName = toolUseConfirm.tool.userFacingName(
    toolUseConfirm.input as never,
  )

  if (toolUseConfirm.tool === ExitPlanModeTool) {
    return 'Claude Code needs your approval for the plan'
  }

  if (toolUseConfirm.tool === EnterPlanModeTool) {
    return 'Claude Code wants to enter plan mode'
  }

  if (!toolName || toolName.trim() === '') {
    return 'Claude Code needs your attention'
  }

  return `Claude needs your permission to use ${toolName}`
}

export function PermissionRequest({
  toolUseConfirm,
  toolUseContext,
  onDone,
  onReject,
  verbose,
  setStickyFooter,
}: PermissionRequestProps): React.ReactNode {
  // Handle Ctrl+C (app:interrupt) to reject
  useKeybinding(
    'app:interrupt',
    () => {
      onDone()
      onReject()
      toolUseConfirm.onReject()
    },
    { context: 'Confirmation' },
  )

  const notificationMessage = getNotificationMessage(toolUseConfirm)
  useNotifyAfterTimeout(notificationMessage, 'permission_prompt')

  const PermissionComponent =
    toolUseConfirm.tool.renderPermissionRequest?.() ?? FallbackPermissionRequest

  return (
    <PermissionComponent
      toolUseContext={toolUseContext}
      toolUseConfirm={toolUseConfirm}
      onDone={onDone}
      onReject={onReject}
      verbose={verbose}
      setStickyFooter={setStickyFooter}
    />
  )
}
