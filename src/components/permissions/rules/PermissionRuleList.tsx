/**
 * REPL host adapter for the /permissions dialog: reads the tool permission
 * context from AppState, wires the context write-back, and delegates
 * rendering to the host-agnostic panels/PermissionRulesDialog component.
 */

import * as React from 'react'
import { useCallback } from 'react'
import { useAppState, useSetAppState } from 'src/state/AppState.js'
import type { CommandResultDisplay } from '../../../commands.js'
import type { ToolPermissionContext } from '../../../Tool.js'
import {
  PermissionRuleList as PermissionRuleListPanel,
  type TabType,
} from '../../panels/PermissionRulesDialog/PermissionRuleList.js'

type Props = {
  onExit: (
    result?: string,
    options?: {
      display?: CommandResultDisplay
      shouldQuery?: boolean
      metaMessages?: string[]
    },
  ) => void
  initialTab?: TabType
  onRetryDenials?: (commands: string[]) => void
}

export function PermissionRuleList({
  onExit,
  initialTab,
  onRetryDenials,
}: Props): React.ReactNode {
  const toolPermissionContext = useAppState(s => s.toolPermissionContext)
  const setAppState = useSetAppState()

  const onToolPermissionContextChange = useCallback(
    (context: ToolPermissionContext): void => {
      setAppState(prev => ({
        ...prev,
        toolPermissionContext: context,
      }))
    },
    [setAppState],
  )

  return (
    <PermissionRuleListPanel
      toolPermissionContext={toolPermissionContext}
      onToolPermissionContextChange={onToolPermissionContextChange}
      onExit={onExit}
      initialTab={initialTab}
      onRetryDenials={onRetryDenials}
    />
  )
}
