import { useState, useRef, useEffect, useMemo } from 'react'
import { useTabStatus } from '../../ink.js'
import {
  startPreventSleep,
  stopPreventSleep,
} from '../../services/preventSleep.js'
import { getCurrentSessionTitle } from '../../utils/sessionStorage.js'
import { getSessionId } from '../../bootstrap/state.js'
import { getInitialSettings } from '../../utils/settings/settings.js'
import { useAppState } from '../../state/AppState.js'
import type { TabStatusKind } from '../../ink/hooks/use-tab-status.js'
import type { AgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js'
import type { Message as MessageType } from '../../types/message.js'

export function useReplTerminalStatus({
  titleDisabled,
  mainThreadAgentDefinition,
  initialMessages,
  isLoading,
  isWaitingForApproval,
  isShowingLocalJSXCommand,
}: {
  titleDisabled: boolean
  mainThreadAgentDefinition?: AgentDefinition
  initialMessages?: MessageType[]
  isLoading: boolean
  isWaitingForApproval: boolean
  isShowingLocalJSXCommand: boolean
}) {
  const terminalTitleFromRename =
    useAppState(s => s.settings.terminalTitleFromRename) !== false
  const sessionTitle = terminalTitleFromRename
    ? getCurrentSessionTitle(getSessionId())
    : undefined
  const [autoTitle, setAutoTitle] = useState<string>()
  const autoTitleAttemptedRef = useRef((initialMessages?.length ?? 0) > 0)
  const agentTitle = mainThreadAgentDefinition?.agentType
  const terminalTitle = sessionTitle ?? agentTitle ?? autoTitle ?? 'Claude Code'

  const titleIsAnimating =
    isLoading && !isWaitingForApproval && !isShowingLocalJSXCommand

  // Prevent macOS from sleeping while Claude is working
  useEffect(() => {
    if (isLoading && !isWaitingForApproval && !isShowingLocalJSXCommand) {
      startPreventSleep()
      return () => stopPreventSleep()
    }
  }, [isLoading, isWaitingForApproval, isShowingLocalJSXCommand])

  const sessionStatus: TabStatusKind =
    isWaitingForApproval || isShowingLocalJSXCommand
      ? 'waiting'
      : isLoading
        ? 'busy'
        : 'idle'

  const showStatusInTerminalTab =
    getInitialSettings().showStatusInTerminalTab ?? false
  useTabStatus(titleDisabled || !showStatusInTerminalTab ? null : sessionStatus)

  return {
    sessionTitle,
    autoTitle,
    setAutoTitle,
    autoTitleAttemptedRef,
    agentTitle,
    terminalTitle,
    titleIsAnimating,
    sessionStatus,
    showStatusInTerminalTab,
  }
}
