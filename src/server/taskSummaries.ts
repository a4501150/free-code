/**
 * Shared AppState → WebTaskSummary mapping and task control helpers.
 *
 * Both attach runtimes (the REPL bridge and the headless bridge) own an
 * AppState, so the mapping lives here once rather than twice. Keep this
 * module free of React and of anything that renders.
 */
import type { AppState } from '../state/AppStateStore.js'
import type { AgentId } from '../types/ids.js'
import type { Message } from '../types/message.js'
import { isTerminalTaskStatus } from '../Task.js'
import type { TaskState } from '../tasks/types.js'
import { stopTask } from '../tasks/stopTask.js'
import { getAgentTranscript } from '../utils/sessionStorage.js'
import type { WebTaskSummary } from '../webui/protocol/attachSchemas.js'

/**
 * The main session registers itself as a `local_agent` task so the terminal's
 * panel can treat it uniformly. It is not a subagent, so the browser list
 * drops it — the same exclusion `isPanelAgentTask` makes in the TUI.
 */
function isWebVisibleTask(task: TaskState): boolean {
  return !(task.type === 'local_agent' && task.agentType === 'main-session')
}

function findAgentName(
  appState: AppState,
  agentId: string,
): string | undefined {
  for (const [name, id] of appState.agentNameRegistry ?? []) {
    if (id === agentId) return name
  }
  return undefined
}

export function buildWebTaskSummary(
  task: TaskState,
  appState: AppState,
): WebTaskSummary {
  const summary: WebTaskSummary = {
    id: task.id,
    taskType: task.type,
    status: task.status,
    description: task.description,
    startTime: task.startTime,
    ...(task.endTime ? { endTime: task.endTime } : {}),
    ...(task.toolUseId ? { toolUseId: task.toolUseId } : {}),
  }
  if (task.type === 'local_bash' && task.command) {
    summary.command = task.command
  }
  if (task.type === 'local_agent') {
    summary.agentType = task.agentType
    if (task.model) summary.model = task.model
    const name = findAgentName(appState, task.agentId)
    if (name) summary.name = name
    if (task.progress) {
      summary.toolUseCount = task.progress.toolUseCount
      summary.tokenCount = task.progress.tokenCount
    }
    const pending = task.pendingMessages?.length
    if (pending) summary.pendingCount = pending
  }
  if (task.type === 'local_bash' && task.result?.code !== undefined) {
    summary.exitCode = task.result.code
  }
  return summary
}

export function buildWebTaskSummaries(appState: AppState): WebTaskSummary[] {
  const tasks = appState.tasks ?? {}
  const out: WebTaskSummary[] = []
  for (const task of Object.values(tasks)) {
    if (isWebVisibleTask(task)) out.push(buildWebTaskSummary(task, appState))
  }
  // Newest first: the list reads like a timeline, and a long-running old
  // task must not push today's agents off the bottom of the panel.
  out.sort((a, b) => b.startTime - a.startTime)
  return out
}

export type TaskTranscriptMessages = {
  messages: readonly Message[]
}

/**
 * The transcript behind one task.
 *
 * Running agents keep their chain in memory (streaming, no disk lag); once a
 * task is evicted the sidechain JSONL on disk is the only copy, which is why
 * this must work from disk too. Returns null for a task that has no
 * transcript (a shell, a monitor, or an agent that wrote nothing).
 */
export async function getTaskTranscriptMessages(
  appState: AppState,
  taskId: string,
): Promise<TaskTranscriptMessages | null> {
  const task = appState.tasks?.[taskId]
  if (!task) return null
  // `TaskState` has no remote_agent variant today: a remote agent's chain
  // lives in another process, and only its host would be able to read it.
  if (task.type !== 'local_agent') {
    return null
  }
  if (task.messages?.length) {
    return { messages: task.messages }
  }
  const disk = await getAgentTranscript(task.agentId as AgentId, {
    includePreCompactHistory: true,
  })
  return disk ? { messages: disk.messages } : { messages: [] }
}

/** True once the task will not transition further. */
export function isTaskDone(appState: AppState, taskId: string): boolean {
  const task = appState.tasks?.[taskId]
  return task ? isTerminalTaskStatus(task.status) : true
}

/**
 * Stop a task through the same kill path the terminal uses
 * (`stopTask` → `Task.kill`), so notifications and cleanup are identical.
 * Throws `StopTaskError` (with a `code`) when the task cannot be stopped.
 */
export function killAttachTask(
  taskId: string,
  context: {
    getAppState: () => AppState
    setAppState: (f: (prev: AppState) => AppState) => void
  },
): Promise<void> {
  return stopTask(taskId, context).then(() => undefined)
}
