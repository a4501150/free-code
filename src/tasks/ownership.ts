// Task-ownership rules shared by BackgroundTaskStop (validation) and
// BackgroundTaskList (scoping). React-free so plain-.ts consumers (tool
// validation, headless stopTask paths) don't pull ink into their module graph.

import type { AgentId } from '../types/ids.js'
import { isLocalShellTask } from './LocalShellTask/guards.js'
import type { TaskState } from './types.js'

/**
 * Whether `callerAgentId` may stop `task` via BackgroundTaskStop.
 *
 * Main thread (agentId undefined) may stop anything. A subagent may stop the
 * shell/monitor tasks it spawned (agentId stamp) and the background agents it
 * spawned (parentAgentId stamp); everything else is foreign and can only be
 * coordinated via SendMessage.
 */
export function mayStopTask(
  task: TaskState,
  callerAgentId: AgentId | undefined,
): boolean {
  // The main-session pseudo-task is never stoppable — its abortController is
  // the session itself, so "stopping" it would abort the whole session.
  if (task.type === 'local_agent' && task.agentType === 'main-session') {
    return false
  }
  if (callerAgentId === undefined) return true
  if (task.type === 'local_bash') return task.agentId === callerAgentId
  if (task.type === 'local_agent') {
    // The agent's own task entry (id === its agentId) is not stoppable by
    // itself — an agent ends itself by finishing, not by killing its task.
    return (
      task.parentAgentId === callerAgentId && task.agentId !== callerAgentId
    )
  }
  return false
}

/**
 * Running shell/monitor tasks owned by `agentId` — the park condition for the
 * strict end_turn model (an agent that still owns running background tasks
 * does not complete on an implicit end) and the kill list for
 * killShellTasksForAgent, so the predicate lives in one place. Structural on
 * the state reader so React-free callers don't import the store.
 */
export function getRunningOwnedShellTasks(
  agentId: AgentId,
  getAppState: () => { tasks?: { [taskId: string]: TaskState } },
): TaskState[] {
  const tasks = getAppState().tasks ?? {}
  return Object.values(tasks).filter(
    task =>
      isLocalShellTask(task) &&
      task.agentId === agentId &&
      task.status === 'running',
  )
}

/**
 * The agent to SendMessage about a foreign task: the owning agent for
 * shell/monitor tasks, the agent itself for agent tasks. Undefined = the task
 * belongs to the main session (not addressable via SendMessage).
 */
export function taskCoordinationAgentId(task: TaskState): AgentId | undefined {
  if (task.type === 'local_bash') return task.agentId
  if (task.type === 'local_agent') {
    // Never point at the main-session pseudo-task or at an agent's parent;
    // the agent itself is the autonomous party.
    return task.agentType === 'main-session'
      ? undefined
      : (task.agentId as AgentId)
  }
  return undefined
}
