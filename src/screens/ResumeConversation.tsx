import { feature } from 'bun:bundle'
// Dead code elimination: conditional import for coordinator mode
/* eslint-disable @typescript-eslint/no-require-imports */
const coordinatorModeModule = feature('COORDINATOR_MODE')
  ? (require('../coordinator/coordinatorMode.js') as typeof import('../coordinator/coordinatorMode.js'))
  : null
/* eslint-enable @typescript-eslint/no-require-imports */
import React from 'react'
import { useTerminalSize } from 'src/hooks/useTerminalSize.js'
import { getOriginalCwd } from '../bootstrap/state.js'
import type { Command } from '../commands.js'
import { LogSelector } from '../components/LogSelector.js'
import {
  ResumeSessionConflictDialog,
  type ResumeSessionConflictChoice,
} from '../components/ResumeSessionConflictDialog.js'
import { Spinner } from '../components/Spinner.js'
import { setClipboard } from '../ink/termio/osc.js'
import { Box, Text } from '../ink.js'
import type {
  MCPServerConnection,
  ScopedMcpServerConfig,
} from '../services/mcp/types.js'
import { useAppState, useSetAppState } from '../state/AppState.js'
import type { Tool } from '../Tool.js'
import type { AgentColorName } from '../tools/AgentTool/agentColorManager.js'
import type { AgentDefinition } from '../tools/AgentTool/loadAgentsDir.js'
import type { LogOption } from '../types/logs.js'
import type { Message } from '../types/message.js'
import { agenticSessionSearch } from '../utils/agenticSessionSearch.js'
import { updateSessionName } from '../utils/concurrentSessions.js'
import { loadConversationForResume } from '../utils/conversationRecovery.js'
import { checkCrossProjectResume } from '../utils/crossProjectResume.js'
import type { FileHistorySnapshot } from '../utils/fileHistory.js'
import { gracefulShutdownSync } from '../utils/gracefulShutdown.js'
import { logError } from '../utils/log.js'
import { createSystemMessage } from '../utils/messages.js'
import {
  adoptResumedSessionAtStartup,
  checkResumeSessionOwnership,
  computeStandaloneAgentContext,
  ResumeCancelledError,
  type ResumeSessionConflict,
  restoreAgentFromSession,
} from '../utils/sessionRestore.js'
import {
  enrichLogs,
  isCustomTitleEnabled,
  loadAllProjectsMessageLogsProgressive,
  loadSameRepoMessageLogsProgressive,
  saveMode,
  type SessionLogResult,
} from '../utils/sessionStorage.js'
import * as loadAgentsDirNs from '../tools/AgentTool/loadAgentsDir.js'
import type { ThinkingConfig } from '../utils/thinking.js'
import type { ContentReplacementRecord } from '../utils/toolResultStorage.js'
import { REPL } from './REPL.js'
import { readAttachDescriptor } from '../webui/attach/attachDescriptor.js'
import { AttachedSession } from './AttachedSession.js'

function parsePrIdentifier(value: string): number | null {
  const directNumber = parseInt(value, 10)
  if (!isNaN(directNumber) && directNumber > 0) {
    return directNumber
  }
  const urlMatch = value.match(/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/)
  if (urlMatch?.[1]) {
    return parseInt(urlMatch[1], 10)
  }
  return null
}

type Props = {
  commands: Command[]
  worktreePaths: string[]
  initialTools: Tool[]
  mcpClients?: MCPServerConnection[]
  dynamicMcpConfig?: Record<string, ScopedMcpServerConfig>
  debug: boolean
  mainThreadAgentDefinition?: AgentDefinition
  autoConnectIdeFlag?: boolean
  strictMcpConfig?: boolean
  systemPrompt?: string
  appendSystemPrompt?: string
  initialSearchQuery?: string
  disableSlashCommands?: boolean
  forkSession?: boolean
  taskListId?: string
  filterByPr?: boolean | number | string
  thinkingConfig: ThinkingConfig
  onTurnComplete?: (messages: Message[]) => void | Promise<void>
}

export function ResumeConversation({
  commands,
  worktreePaths,
  initialTools,
  mcpClients,
  dynamicMcpConfig,
  debug,
  mainThreadAgentDefinition,
  autoConnectIdeFlag,
  strictMcpConfig = false,
  systemPrompt,
  appendSystemPrompt,
  initialSearchQuery,
  disableSlashCommands = false,
  forkSession,
  taskListId,
  filterByPr,
  thinkingConfig,
  onTurnComplete,
}: Props): React.ReactNode {
  const { rows } = useTerminalSize()
  const agentDefinitions = useAppState(s => s.agentDefinitions)
  const setAppState = useSetAppState()
  const [logs, setLogs] = React.useState<LogOption[]>([])
  const [loading, setLoading] = React.useState(true)
  const [resuming, setResuming] = React.useState(false)
  const [showAllProjects, setShowAllProjects] = React.useState(false)
  const [resumeData, setResumeData] = React.useState<{
    messages: Message[]
    fileHistorySnapshots?: FileHistorySnapshot[]
    contentReplacements?: ContentReplacementRecord[]
    agentName?: string
    agentColor?: AgentColorName
    mainThreadAgentDefinition?: AgentDefinition
  } | null>(null)
  const [crossProjectCommand, setCrossProjectCommand] = React.useState<
    string | null
  >(null)
  const [ownershipConflict, setOwnershipConflict] = React.useState<{
    conflict: ResumeSessionConflict
    resolve: (choice: ResumeSessionConflictChoice) => void
  } | null>(null)
  const [joinPid, setJoinPid] = React.useState<number | null>(null)
  const sessionLogResultRef = React.useRef<SessionLogResult | null>(null)
  // Mirror of logs.length so loadMoreLogs can compute value indices outside
  // the setLogs updater (keeping it pure per React's contract).
  const logCountRef = React.useRef(0)

  const filteredLogs = React.useMemo(() => {
    let result = logs.filter(l => !l.isSidechain)
    if (filterByPr !== undefined) {
      if (filterByPr === true) {
        result = result.filter(l => l.prNumber !== undefined)
      } else if (typeof filterByPr === 'number') {
        result = result.filter(l => l.prNumber === filterByPr)
      } else if (typeof filterByPr === 'string') {
        const prNumber = parsePrIdentifier(filterByPr)
        if (prNumber !== null) {
          result = result.filter(l => l.prNumber === prNumber)
        }
      }
    }
    return result
  }, [logs, filterByPr])
  const isResumeWithRenameEnabled = isCustomTitleEnabled()

  React.useEffect(() => {
    loadSameRepoMessageLogsProgressive(worktreePaths)
      .then(result => {
        sessionLogResultRef.current = result
        logCountRef.current = result.logs.length
        setLogs(result.logs)
        setLoading(false)
      })
      .catch(error => {
        logError(error)
        setLoading(false)
      })
  }, [worktreePaths])

  const loadMoreLogs = React.useCallback((count: number) => {
    const ref = sessionLogResultRef.current
    if (!ref || ref.nextIndex >= ref.allStatLogs.length) return

    void enrichLogs(ref.allStatLogs, ref.nextIndex, count).then(result => {
      ref.nextIndex = result.nextIndex
      if (result.logs.length > 0) {
        // enrichLogs returns fresh unshared objects — safe to mutate in place.
        // Offset comes from logCountRef so the setLogs updater stays pure.
        const offset = logCountRef.current
        result.logs.forEach((log, i) => {
          log.value = offset + i
        })
        setLogs(prev => prev.concat(result.logs))
        logCountRef.current += result.logs.length
      } else if (ref.nextIndex < ref.allStatLogs.length) {
        loadMoreLogs(count)
      }
    })
  }, [])

  const loadLogs = React.useCallback(
    (allProjects: boolean) => {
      setLoading(true)
      const promise = allProjects
        ? loadAllProjectsMessageLogsProgressive()
        : loadSameRepoMessageLogsProgressive(worktreePaths)
      promise
        .then(result => {
          sessionLogResultRef.current = result
          logCountRef.current = result.logs.length
          setLogs(result.logs)
        })
        .catch(error => {
          logError(error)
        })
        .finally(() => {
          setLoading(false)
        })
    },
    [worktreePaths],
  )

  const handleToggleAllProjects = React.useCallback(() => {
    const newValue = !showAllProjects
    setShowAllProjects(newValue)
    loadLogs(newValue)
  }, [showAllProjects, loadLogs])

  function onCancel() {
    // eslint-disable-next-line custom-rules/no-process-exit
    process.exit(1)
  }

  async function onSelect(log: LogOption) {
    setResuming(true)
    const resumeStart = performance.now()

    const crossProjectCheck = checkCrossProjectResume(
      log,
      showAllProjects,
      worktreePaths,
    )
    if (crossProjectCheck.isCrossProject) {
      if (!crossProjectCheck.isSameRepoWorktree) {
        const raw = await setClipboard(crossProjectCheck.command)
        if (raw) process.stdout.write(raw)
        setCrossProjectCommand(crossProjectCheck.command)
        return
      }
    }

    // Adopting a session another live process already holds makes both append
    // to one transcript and share every store keyed on the session ID. Asked
    // inside the loader, before it copies anything or runs a resume hook.
    let effectiveForkSession = !!forkSession
    try {
      const result = await loadConversationForResume(log, undefined, {
        beforeResumeSideEffects: async ({ sessionId }) => {
          if (effectiveForkSession) return
          const conflict = await checkResumeSessionOwnership(sessionId)
          if (!conflict) return
          const choice = await new Promise<ResumeSessionConflictChoice>(
            resolve => setOwnershipConflict({ conflict, resolve }),
          )
          setOwnershipConflict(null)
          if (choice === 'cancel') {
            gracefulShutdownSync(1)
            throw new ResumeCancelledError()
          }
          if (choice === 'join') {
            const holderPid = conflict.holders[0]?.pid
            if (holderPid) {
              setJoinPid(holderPid)
              throw new ResumeCancelledError()
            }
          }
          if (choice === 'fork') effectiveForkSession = true
        },
      })
      if (!result) {
        throw new Error('Failed to load conversation')
      }

      if (feature('COORDINATOR_MODE') && coordinatorModeModule) {
        const warning = coordinatorModeModule.matchSessionMode(result.mode)
        if (warning) {
          const { getAgentDefinitionsWithOverrides, getActiveAgentsFromList } =
            loadAgentsDirNs
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
          result.messages.push(createSystemMessage(warning, 'warning'))
        }
      }

      await adoptResumedSessionAtStartup(result, {
        fork: effectiveForkSession,
        ...(log.fullPath ? { transcriptPath: log.fullPath } : {}),
      })

      const { agentDefinition: resolvedAgentDef } = restoreAgentFromSession(
        result.agentSetting,
        mainThreadAgentDefinition,
        agentDefinitions,
      )
      setAppState(prev => ({ ...prev, agent: resolvedAgentDef?.agentType }))

      if (feature('COORDINATOR_MODE') && coordinatorModeModule) {
        saveMode(
          coordinatorModeModule.isCoordinatorMode() ? 'coordinator' : 'normal',
        )
      }

      const standaloneAgentContext = computeStandaloneAgentContext(
        result.agentName,
        result.agentColor,
      )
      if (standaloneAgentContext) {
        setAppState(prev => ({ ...prev, standaloneAgentContext }))
      }
      void updateSessionName(result.agentName)

      setLogs([])
      setResumeData({
        messages: result.messages,
        fileHistorySnapshots: result.fileHistorySnapshots,
        contentReplacements: result.contentReplacements,
        agentName: result.agentName,
        agentColor: (result.agentColor === 'default'
          ? undefined
          : result.agentColor) as AgentColorName | undefined,
        mainThreadAgentDefinition: resolvedAgentDef,
      })
    } catch (e) {
      // The user declined; shutdown is already under way.
      if (e instanceof ResumeCancelledError) return
      logError(e as Error)
      throw e
    }
  }

  if (joinPid !== null) {
    return <AttachedSession pid={joinPid} />
  }

  if (ownershipConflict) {
    return (
      <ResumeSessionConflictDialog
        sessionId={ownershipConflict.conflict.sessionId}
        holders={ownershipConflict.conflict.holders}
        holderAttachable={
          ownershipConflict.conflict.holders[0]
            ? readAttachDescriptor(ownershipConflict.conflict.holders[0].pid).ok
            : false
        }
        onChoice={ownershipConflict.resolve}
      />
    )
  }

  if (crossProjectCommand) {
    return <CrossProjectMessage command={crossProjectCommand} />
  }

  if (resumeData) {
    return (
      <REPL
        debug={debug}
        commands={commands}
        initialTools={initialTools}
        initialMessages={resumeData.messages}
        initialFileHistorySnapshots={resumeData.fileHistorySnapshots}
        initialContentReplacements={resumeData.contentReplacements}
        initialAgentName={resumeData.agentName}
        initialAgentColor={resumeData.agentColor}
        mcpClients={mcpClients}
        dynamicMcpConfig={dynamicMcpConfig}
        strictMcpConfig={strictMcpConfig}
        systemPrompt={systemPrompt}
        appendSystemPrompt={appendSystemPrompt}
        mainThreadAgentDefinition={resumeData.mainThreadAgentDefinition}
        autoConnectIdeFlag={autoConnectIdeFlag}
        disableSlashCommands={disableSlashCommands}
        taskListId={taskListId}
        thinkingConfig={thinkingConfig}
        onTurnComplete={onTurnComplete}
      />
    )
  }

  if (loading) {
    return (
      <Box>
        <Spinner />
        <Text> Loading conversations…</Text>
      </Box>
    )
  }

  if (resuming) {
    return (
      <Box>
        <Spinner />
        <Text> Resuming conversation…</Text>
      </Box>
    )
  }

  return (
    <LogSelector
      logs={filteredLogs}
      maxHeight={rows}
      onCancel={onCancel}
      onSelect={onSelect}
      onLogsChanged={
        isResumeWithRenameEnabled ? () => loadLogs(showAllProjects) : undefined
      }
      onLoadMore={loadMoreLogs}
      initialSearchQuery={initialSearchQuery}
      showAllProjects={showAllProjects}
      onToggleAllProjects={handleToggleAllProjects}
      onAgenticSearch={agenticSessionSearch}
    />
  )
}

function CrossProjectMessage({
  command,
}: {
  command: string
}): React.ReactNode {
  React.useEffect(() => {
    const timeout = setTimeout(() => {
      // eslint-disable-next-line custom-rules/no-process-exit
      process.exit(0)
    }, 100)
    return () => clearTimeout(timeout)
  }, [])

  return (
    <Box flexDirection="column" gap={1}>
      <Text>This conversation is from a different directory.</Text>
      <Box flexDirection="column">
        <Text>To resume, run:</Text>
        <Text> {command}</Text>
      </Box>
      <Text dimColor>(Command copied to clipboard)</Text>
    </Box>
  )
}
