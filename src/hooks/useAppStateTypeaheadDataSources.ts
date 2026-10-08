/**
 * Store-backed default TypeaheadDataSources for the classic REPL host:
 * reads the AppState store (reactively where the palette needs a snapshot,
 * imperatively where it needs call-time freshness), the session-title
 * index, and the file-index side module.
 */
import { useMemo } from 'react'
import { useNotifications } from '../context/notifications.js'
import { useAppState, useAppStateStore } from '../state/AppState.js'
import { formatLogMetadata } from '../utils/format.js'
import {
  getSessionIdFromLog,
  searchSessionsByCustomTitle,
} from '../utils/sessionStorage.js'
import { hasSlackMcpServer } from '../utils/suggestions/slackChannelSuggestions.js'
import type {
  TypeaheadAgentMember,
  TypeaheadDataSources,
} from '../components/panels/commandPalette/dataSources.js'
import {
  onIndexBuildComplete,
  startBackgroundCacheRefresh,
} from './fileSuggestions.js'

export function useAppStateTypeaheadDataSources(): TypeaheadDataSources {
  const store = useAppStateStore()
  const mcpResources = useAppState(s => s.mcp.resources)
  const promptSuggestion = useAppState(s => s.promptSuggestion)
  const isViewingAgentTask = useAppState(s => !!s.viewingAgentTaskId)
  const { addNotification } = useNotifications()

  return useMemo<TypeaheadDataSources>(
    () => ({
      mcpResources,
      promptSuggestion,
      isViewingAgentTask,
      getMcpClients: () => store.getState().mcp.clients,
      hasSlackMcpServer: () => hasSlackMcpServer(store.getState().mcp.clients),
      getAgentDirectMessages: () => {
        const state = store.getState()
        const members: TypeaheadAgentMember[] = []
        for (const [name, agentId] of state.agentNameRegistry) {
          members.push({ name, status: state.tasks[agentId]?.status })
        }
        return members
      },
      searchSessionTitleSuggestions: async query => {
        const matches = await searchSessionsByCustomTitle(query, {
          limit: 10,
        })
        return matches.map(log => ({
          sessionId: getSessionIdFromLog(log),
          customTitle: log.customTitle,
          metadataLine: formatLogMetadata(log),
        }))
      },
      startFileIndexRefresh: () => {
        // Skipped under NODE_ENV=test: REPL-mounting tests would spawn git
        // ls-files against the real CI workspace (270k+ files on Windows
        // runners), and the background build outlives the test — its
        // setImmediate chain leaks into subsequent tests in the shard. The
        // subscriber below still registers so fileSuggestions tests that
        // trigger a refresh directly work correctly.
        if (('production' as string) !== 'test') {
          startBackgroundCacheRefresh()
        }
      },
      onFileIndexBuildComplete: (callback: () => void) =>
        onIndexBuildComplete(callback),
      addNotification: content => addNotification(content),
    }),
    [
      store,
      mcpResources,
      promptSuggestion,
      isViewingAgentTask,
      addNotification,
    ],
  )
}
