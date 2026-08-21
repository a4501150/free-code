import { feature } from 'bun:bundle'
import { useCallback } from 'react'
import type { UUID } from 'crypto'
import { randomUUID } from 'crypto'
import { dirname } from 'path'
import type { ResumeEntrypoint } from '../../commands.js'
import type { LogOption } from '../../types/logs.js'
import type { Message as MessageType } from '../../types/message.js'
import type { AgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js'
import type { SetToolJSXArgs } from './useReplToolJSX.js'
import { asSessionId } from '../../types/ids.js'
import { deserializeMessages } from '../../utils/conversationRecovery.js'
import {
  getOriginalCwd,
  getSessionId,
  switchSession,
  setCostStateForRestore,
} from '../../bootstrap/state.js'
import {
  saveCurrentSessionCosts,
  resetCostState,
  getStoredSessionCosts,
} from '../../cost-tracker.js'
import {
  clearSessionMetadata,
  resetSessionFilePointer,
  adoptResumedSessionFile,
  restoreSessionMetadata,
  saveWorktreeState,
  saveMode,
} from '../../utils/sessionStorage.js'
import {
  checkResumeSessionOwnership,
  computeStandaloneAgentContext,
  restoreAgentFromSession,
  restoreSessionStateFromLog,
  restoreWorktreeForResume,
  exitRestoredWorktree,
} from '../../utils/sessionRestore.js'
import { updateSessionName } from '../../utils/concurrentSessions.js'
import { renameRecordingForSession } from '../../utils/asciicast.js'
import { copyPlanForFork, copyPlanForResume } from '../../utils/plans.js'
import { copyFileHistoryForResume } from '../../utils/fileHistory.js'
import { processSessionStartHooks } from '../../utils/sessionStart.js'
import {
  executeSessionEndHooks,
  getSessionEndHookTimeoutMs,
} from '../../utils/hooks.js'
import { getCurrentWorktreeSession } from '../../utils/worktree.js'
import { readAttachDescriptor } from '../../webui/attach/attachDescriptor.js'
import { createSystemMessage } from '../../utils/messages.js'
import { reconstructContentReplacementState } from '../../utils/toolResultStorage.js'
import { recordContentReplacement } from '../../utils/sessionStorage.js'
import {
  ResumeSessionConflictDialog,
  type ResumeSessionConflictChoice,
} from '../../components/ResumeSessionConflictDialog.js'
import * as React from 'react'
import * as loadAgentsDirNs from '../../tools/AgentTool/loadAgentsDir.js'

// Dead code elimination: conditional import for coordinator mode
/* eslint-disable @typescript-eslint/no-require-imports */
const coordinatorModeModule = feature('COORDINATOR_MODE')
  ? (require('../../coordinator/coordinatorMode.js') as typeof import('../../coordinator/coordinatorMode.js'))
  : null
/* eslint-enable @typescript-eslint/no-require-imports */

export function useReplSessionResume({
  setToolJSX,
  setMessages,
  setInputValue,
  setAbortController,
  setConversationId,
  setAutoTitle,
  autoTitleAttemptedRef,
  setMainThreadAgentDefinition,
  initialMainThreadAgentDefinition,
  agentDefinitions,
  mainLoopModel,
  mainThreadAgentDefinition,
  setAppState,
  store,
  contentReplacementStateRef,
  resetLoadingState,
  restoreReadFileState,
}: {
  setToolJSX: (args: SetToolJSXArgs) => void
  setMessages: (action: React.SetStateAction<MessageType[]>) => void
  setInputValue: (value: string) => void
  setAbortController: (controller: AbortController | null) => void
  setConversationId: (id: UUID) => void
  setAutoTitle: (title: string | undefined) => void
  autoTitleAttemptedRef: React.MutableRefObject<boolean>
  setMainThreadAgentDefinition: (def: AgentDefinition | undefined) => void
  initialMainThreadAgentDefinition?: AgentDefinition
  agentDefinitions: any
  mainLoopModel: string
  mainThreadAgentDefinition?: AgentDefinition
  setAppState: (fn: (prev: any) => any) => void
  store: { getState: () => any; setState: (fn: (prev: any) => any) => void }
  contentReplacementStateRef: { current: any }
  resetLoadingState: () => void
  restoreReadFileState: (messages: MessageType[], cwd: string) => void
}) {
  const resume = useCallback(
    async (sessionId: UUID, log: LogOption, entrypoint: ResumeEntrypoint) => {
      try {
        if (entrypoint !== 'fork') {
          const conflict = await checkResumeSessionOwnership(sessionId)
          if (conflict) {
            const choice = await new Promise<ResumeSessionConflictChoice>(
              resolve => {
                setToolJSX({
                  jsx: null,
                  shouldHidePromptInput: false,
                  clearLocalJSX: true,
                })
                setToolJSX({
                  jsx: (
                    <ResumeSessionConflictDialog
                      sessionId={conflict.sessionId}
                      holders={conflict.holders}
                      holderAttachable={
                        conflict.holders[0]
                          ? readAttachDescriptor(conflict.holders[0].pid).ok
                          : false
                      }
                      onChoice={resolve}
                    />
                  ),
                  shouldHidePromptInput: true,
                })
              },
            )
            setToolJSX({
              jsx: null,
              shouldHidePromptInput: false,
              clearLocalJSX: true,
            })
            if (choice === 'cancel' || choice === 'join') return
            if (choice === 'fork') {
              sessionId = randomUUID()
              log = { ...log, fullPath: undefined }
              entrypoint = 'ownership_fork'
            }
          }
        }
        const isFork = entrypoint === 'fork' || entrypoint === 'ownership_fork'

        const messages = deserializeMessages(log.messages)

        if (feature('COORDINATOR_MODE') && coordinatorModeModule) {
          const warning = coordinatorModeModule.matchSessionMode(log.mode)
          if (warning) {
            const {
              getAgentDefinitionsWithOverrides,
              getActiveAgentsFromList,
            } = loadAgentsDirNs
            getAgentDefinitionsWithOverrides.cache.clear?.()
            const freshAgentDefs =
              await getAgentDefinitionsWithOverrides(getOriginalCwd())

            setAppState(prev => ({
              ...prev,
              agentDefinitions: {
                ...freshAgentDefs,
                allAgents: freshAgentDefs.allAgents,
                activeAgents: getActiveAgentsFromList(freshAgentDefs.allAgents),
              },
            }))
            messages.push(createSystemMessage(warning, 'warning'))
          }
        }

        const sessionEndTimeoutMs = getSessionEndHookTimeoutMs()
        await executeSessionEndHooks('resume', {
          getAppState: () => store.getState(),
          setAppState,
          signal: AbortSignal.timeout(sessionEndTimeoutMs),
          timeoutMs: sessionEndTimeoutMs,
        })

        const hookMessages = await processSessionStartHooks('resume', {
          sessionId,
          agentType: mainThreadAgentDefinition?.agentType,
          model: mainLoopModel,
        })

        messages.push(...hookMessages)

        if (isFork) {
          void copyPlanForFork(log, asSessionId(sessionId))
        } else {
          void copyPlanForResume(log, asSessionId(sessionId))
        }

        restoreSessionStateFromLog(log, setAppState)
        if (log.fileHistorySnapshots) {
          void copyFileHistoryForResume(log)
        }

        const { agentDefinition: restoredAgent } = restoreAgentFromSession(
          log.agentSetting,
          initialMainThreadAgentDefinition,
          agentDefinitions,
        )
        setMainThreadAgentDefinition(restoredAgent)
        setAppState(prev => ({ ...prev, agent: restoredAgent?.agentType }))

        setAppState(prev => ({
          ...prev,
          standaloneAgentContext: computeStandaloneAgentContext(
            log.agentName,
            log.agentColor,
          ),
        }))
        void updateSessionName(log.agentName)

        restoreReadFileState(messages, log.projectPath ?? getOriginalCwd())

        resetLoadingState()
        setAbortController(null)

        setConversationId(sessionId)

        const targetSessionCosts = getStoredSessionCosts(sessionId)
        saveCurrentSessionCosts()
        resetCostState()

        switchSession(
          asSessionId(sessionId),
          log.fullPath ? dirname(log.fullPath) : null,
        )
        await renameRecordingForSession()
        await resetSessionFilePointer()

        clearSessionMetadata()
        restoreSessionMetadata(log)
        autoTitleAttemptedRef.current = true
        setAutoTitle(undefined)

        if (!isFork) {
          exitRestoredWorktree()
          restoreWorktreeForResume(log.worktreeSession)
          adoptResumedSessionFile()
        } else {
          const ws = getCurrentWorktreeSession()
          if (ws) saveWorktreeState(ws)
        }

        if (feature('COORDINATOR_MODE') && coordinatorModeModule) {
          saveMode(
            coordinatorModeModule.isCoordinatorMode()
              ? 'coordinator'
              : 'normal',
          )
        }

        if (targetSessionCosts) {
          setCostStateForRestore(targetSessionCosts)
        }

        if (contentReplacementStateRef.current && entrypoint !== 'fork') {
          contentReplacementStateRef.current =
            reconstructContentReplacementState(
              messages,
              log.contentReplacements ?? [],
            )
        }

        if (
          entrypoint === 'ownership_fork' &&
          log.contentReplacements?.length
        ) {
          await recordContentReplacement(log.contentReplacements)
        }

        setMessages(() => messages)
        setToolJSX(null)
        setInputValue('')
      } catch (error) {
        throw error
      }
    },
    [resetLoadingState, setAppState],
  )

  return { resume }
}
