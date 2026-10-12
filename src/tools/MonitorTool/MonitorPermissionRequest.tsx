/**
 * Permission dialog for the Monitor tool.
 *
 * Monitor commands run shell commands, so their permission UX is the Bash
 * dialog: per-prefix "don't ask again" grants, compound-command breakdown,
 * sed delegation, explainer support. Two adaptations:
 *
 * 1. BashPermissionRequest parses toolUseConfirm.input with BashTool's
 *    strictObject schema, which rejects Monitor's extra `notify_interval`
 *    key — narrow the input to the command before delegating. The permission
 *    decision derives from the command alone, so nothing is lost. But the
 *    dialog returns its updatedInput derived from the NARROWED input, so
 *    `onAllow` is wrapped to re-merge the Monitor-only keys — without the
 *    merge, call() sees notify_interval missing and fails.
 * 2. Saved rules are Bash(prefix) rules. MonitorTool delegates its whole
 *    permission pipeline to Bash, including rule matching (content rules
 *    are keyed to the Bash name, and permissionRuleToolName makes bare
 *    Bash allow/deny/ask rules cover Monitor too). A Monitor-scoped rule
 *    would silently never match.
 */
import * as React from 'react'
import { BashPermissionRequest } from '../../components/permissions/BashPermissionRequest/BashPermissionRequest.js'
import type { PermissionRequestProps } from '../../components/permissions/PermissionRequest.js'

export function MonitorPermissionRequest(
  props: PermissionRequestProps,
): React.ReactNode {
  const { toolUseConfirm } = props
  const fullInput = toolUseConfirm.input as Record<string, unknown>
  return (
    <BashPermissionRequest
      {...props}
      toolUseConfirm={{
        ...toolUseConfirm,
        input: { command: fullInput.command },
        onAllow: (updatedInput, ...rest) => {
          toolUseConfirm.onAllow(
            { ...fullInput, ...updatedInput } as typeof toolUseConfirm.input,
            ...rest,
          )
        },
      }}
    />
  )
}
