/**
 * Conversation clearing utility.
 * This module has heavier dependencies and should be lazy-loaded when possible.
 */
import { randomUUID, type UUID } from 'crypto'
import {
  getLastMainRequestId,
  getOriginalCwd,
  getSessionId,
  regenerateSessionId,
} from '../../bootstrap/state.js'
import { isCoordinatorMode } from '../../coordinator/coordinatorMode.js'
import type { AppState } from '../../state/AppStateStore.js'
import {
  isLocalAgentTask,
  type LocalAgentTaskState,
} from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { isLocalShellTask } from '../../tasks/LocalShellTask/guards.js'
import { asAgentId } from '../../types/ids.js'
import type { Message } from '../../types/message.js'
import type { FileStateCache } from '../../utils/fileStateCache.js'
import {
  executeSessionEndHooks,
  getSessionEndHookTimeoutMs,
} from '../../utils/hooks.js'
import { logError } from '../../utils/log.js'
import { clearAllPlanSlugs } from '../../utils/plans.js'
import { setCwd } from '../../utils/Shell.js'
import { processSessionStartHooks } from '../../utils/sessionStart.js'
import {
  clearSessionMetadata,
  getAgentTranscriptPath,
  reAppendSessionMetadata,
  resetSessionFilePointer,
  saveMode,
  saveWorktreeState,
  truncateSessionTranscriptInPlace,
} from '../../utils/sessionStorage.js'
import { writeSessionTranscriptSegment } from '../../services/sessionTranscript/sessionTranscript.js'
import { isAssistantMode } from '../../assistant/index.js'
import {
  evictTaskOutput,
  initTaskOutputAsSymlink,
} from '../../utils/task/diskOutput.js'
import { getCurrentWorktreeSession } from '../../utils/worktree.js'
import { clearSessionCaches } from './caches.js'

export async function clearConversation({
  setMessages,
  readFileState,
  loadedNestedMemoryPaths,
  getAppState,
  setAppState,
  setConversationId,
  scrollToBottom,
  getMessages,
}: {
  setMessages: (updater: (prev: Message[]) => Message[]) => void
  readFileState: FileStateCache
  loadedNestedMemoryPaths?: Set<string>
  getAppState?: () => AppState
  setAppState?: (f: (prev: AppState) => AppState) => void
  setConversationId?: (id: UUID) => void
  scrollToBottom?: () => void
  /**
   * Snapshot of the conversation being cleared. Used by the assistant path
   * to flush the outgoing transcript segment before in-place truncation.
   */
  getMessages?: () => Message[]
}): Promise<void> {
  // Execute SessionEnd hooks before clearing (bounded by
  // sessionEndHooksTimeoutMs, default 1.5s)
  const sessionEndTimeoutMs = getSessionEndHookTimeoutMs()
  await executeSessionEndHooks('clear', {
    getAppState,
    setAppState,
    signal: AbortSignal.timeout(sessionEndTimeoutMs),
    timeoutMs: sessionEndTimeoutMs,
  })

  // Signal to inference that this conversation's cache can be evicted.
  const lastRequestId = getLastMainRequestId()

  // Compute preserved tasks up front so their per-agent state survives the
  // cache wipe below. A task is preserved unless it explicitly has
  // isBackgrounded === false. Main-session tasks (Ctrl+B) are preserved —
  // they write to an isolated per-task transcript and run under an agent
  // context, so they're safe across session ID regeneration. See
  // LocalMainSessionTask.ts startBackgroundSession.
  const preservedAgentIds = new Set<string>()
  const preservedLocalAgents: LocalAgentTaskState[] = []
  const shouldKillTask = (task: AppState['tasks'][string]): boolean =>
    'isBackgrounded' in task && task.isBackgrounded === false
  if (getAppState) {
    for (const task of Object.values(getAppState().tasks)) {
      if (shouldKillTask(task)) continue
      if (isLocalAgentTask(task)) {
        preservedAgentIds.add(task.agentId)
        preservedLocalAgents.push(task)
      }
    }
  }

  // Snapshot the outgoing conversation before the wipe: the assistant path
  // flushes it to the /dream transcript segment before truncating the
  // session file in place.
  const outgoingMessages = getMessages?.() ?? []

  setMessages(() => [])

  // Force logo re-render by updating conversationId
  if (setConversationId) {
    setConversationId(randomUUID())
  }

  // Re-pin scroll — conversationId bump invalidates useVirtualScroll's height
  // cache, collapsing offsets to estimates. Without this, stale scrollTop
  // lands in an empty range → blank screen.
  scrollToBottom?.()

  // Clear all session-related caches. Per-agent state for preserved background
  // tasks (invoked skills, pending permission callbacks, dump state, cache-break
  // tracking) is retained so those agents keep functioning.
  clearSessionCaches(preservedAgentIds)

  setCwd(getOriginalCwd())
  readFileState.clear()
  loadedNestedMemoryPaths?.clear()

  // Clean out necessary items from App State
  if (setAppState) {
    setAppState(prev => {
      // Partition tasks using the same predicate computed above:
      // kill+remove foreground tasks, preserve everything else.
      const nextTasks: AppState['tasks'] = {}
      for (const [taskId, task] of Object.entries(prev.tasks)) {
        if (!shouldKillTask(task)) {
          nextTasks[taskId] = task
          continue
        }
        // Foreground task: kill it and drop from state
        try {
          if (task.status === 'running') {
            if (isLocalShellTask(task)) {
              task.shellCommand?.kill()
              task.shellCommand?.cleanup()
              if (task.cleanupTimeoutId) {
                clearTimeout(task.cleanupTimeoutId)
              }
            }
            if ('abortController' in task) {
              task.abortController?.abort()
            }
            if ('unregisterCleanup' in task) {
              task.unregisterCleanup?.()
            }
          }
        } catch (error) {
          logError(error)
        }
        void evictTaskOutput(taskId)
      }

      return {
        ...prev,
        tasks: nextTasks,
        // Clear standalone agent context (name/color set by /rename, /color)
        // so the new session doesn't display the old session's identity badge
        standaloneAgentContext: undefined,
        // Drop any per-agent click-to-expand state from the prior session.
        expandedAgentToolUseIds: new Set<string>(),
        fileHistory: {
          snapshots: [],
          trackedFiles: new Set(),
          snapshotSequence: 0,
        },
        // Reset MCP state to default to trigger re-initialization.
        // Preserve pluginReconnectKey so /clear doesn't cause a no-op
        // (it's only bumped by /reload-plugins).
        mcp: {
          clients: [],
          tools: [],
          commands: [],
          resources: {},
          pluginReconnectKey: prev.mcp.pluginReconnectKey,
        },
      }
    })
  }

  // Clear plan slug cache so a new plan file is used after /clear
  clearAllPlanSlugs()

  // Clear cached session metadata (title, tag, agent name/color)
  // so the new session doesn't inherit the previous session's identity
  clearSessionMetadata()

  if (isAssistantMode()) {
    // The gateway's resume pointer is written at shutdown from the assistant
    // child's spawn-time session ID, so regenerating the ID here would strand
    // it and resurrect the pre-clear conversation on the next boot. Keep the
    // ID and empty the transcript file in place instead; the resume pointer
    // keeps pointing at a file that now holds only the post-clear session.
    // Flush the outgoing conversation to the /dream transcript segment first
    // so those bytes aren't lost with the file.
    writeSessionTranscriptSegment(outgoingMessages)
    await truncateSessionTranscriptInPlace()
  } else {
    // Generate new session ID to provide fresh state
    // Set the old session as parent for analytics lineage tracking
    regenerateSessionId({ setCurrentAsParent: true })
    // Update the environment variable so subprocesses use the new session ID
    await resetSessionFilePointer()
  }

  // Preserved local_agent tasks had their TaskOutput symlink baked against the
  // old session ID at spawn time, but post-clear transcript writes land under
  // the new session directory (appendEntry re-reads getSessionId()). Re-point
  // the symlinks so TaskOutput reads the live file instead of a frozen pre-clear
  // snapshot. Only re-point running tasks — finished tasks will never write
  // again, so re-pointing would replace a valid symlink with a dangling one.
  // Main-session tasks use the same per-agent path (they write via
  // recordSidechainTranscript to getAgentTranscriptPath), so no special case.
  for (const task of preservedLocalAgents) {
    if (task.status !== 'running') continue
    void initTaskOutputAsSymlink(
      task.id,
      getAgentTranscriptPath(asAgentId(task.agentId)),
    )
  }

  // Re-persist mode and worktree state after the clear so future --resume
  // knows what the new post-clear session was in. clearSessionMetadata
  // wiped both from the cache, but the process is still in the same mode
  // and (if applicable) the same worktree directory.
  saveMode(isCoordinatorMode() ? 'coordinator' : 'normal')
  const worktreeSession = getCurrentWorktreeSession()
  if (worktreeSession) {
    saveWorktreeState(worktreeSession)
  }
  if (isAssistantMode()) {
    // The truncated-in-place file keeps its materialized pointer, so the
    // lazy materialize-on-first-message write won't run again. Stamp the
    // just-cached mode/worktree entries straight to the (now empty) file so
    // a load of the truncated transcript sees a valid session header.
    reAppendSessionMetadata()
  }

  // Execute SessionStart hooks after clearing
  const hookMessages = await processSessionStartHooks('clear')

  // Update messages with hook results
  if (hookMessages.length > 0) {
    setMessages(() => hookMessages)
  }

  // Final re-pin: the multiple await points above (resetSessionFilePointer,
  // processSessionStartHooks) yield control to React. If the Ink reconciler
  // doesn't fully batch state updates after those awaits, intermediate renders
  // with empty messages + stale scrollTop can leave the screen blank. This
  // deferred scrollToBottom fires after the final render, ensuring stickyScroll
  // is true when the caller (processInitialMessage / /clear handler) continues.
  scrollToBottom?.()
}
