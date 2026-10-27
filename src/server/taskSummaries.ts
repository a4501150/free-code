/**
 * Shared AppState → WireTask mapping and task control helpers.
 *
 * Every host that serves a task panel (the REPL bridge, the headless bridge,
 * sessiond) owns an AppState, so the mapping lives here once. Keep this
 * module free of React and of anything that renders.
 */
import { closeSync, fstatSync, openSync, readSync } from 'fs'
import { isTerminalTaskStatus } from '../Task.js'
import type { AppState } from '../state/AppStateStore.js'
import type { AgentId } from '../types/ids.js'
import type { TaskState } from '../tasks/types.js'
import { stopTask } from '../tasks/stopTask.js'
import { getTaskOutputTail } from '../utils/task/diskOutput.js'
import type { WireTask, WireTaskOutput } from '../session/wire.js'

/**
 * The main session registers itself as a `local_agent` task so the terminal's
 * panel can treat it uniformly. It is not a subagent, so the wire list drops
 * it — the same exclusion `isPanelAgentTask` makes in the TUI.
 */
function isWireVisibleTask(task: TaskState): boolean {
  return !(task.type === 'local_agent' && task.agentType === 'main-session')
}

function findAgentName(
  appState: AppState,
  agentId: AgentId,
): string | undefined {
  for (const [name, id] of appState.agentNameRegistry ?? []) {
    if (id === agentId) return name
  }
  return undefined
}

/** The last bytes of a shell's output, read fresh so no stale tail exists. */
function readOutputTail(path: string | undefined): string | undefined {
  if (!path) return undefined
  try {
    const fd = openSync(path, 'r')
    try {
      const size = fstatSync(fd).size
      if (size === 0) return undefined
      const len = Math.min(size, 1024)
      const buffer = Buffer.alloc(len)
      readSync(fd, buffer, 0, len, size - len)
      const text = buffer.toString('utf8')
      // Start at a line boundary; a clipped first line reads as garbage.
      const firstBreak = text.indexOf('\n')
      return firstBreak === -1 || firstBreak === text.length - 1
        ? text
        : text.slice(firstBreak + 1)
    } finally {
      closeSync(fd)
    }
  } catch {
    // A task whose output file is gone has nothing to tail.
    return undefined
  }
}

/**
 * One background task as the wire sees it: the display fields of `TaskState`
 * and its variants, with nothing that would drag live objects (messages,
 * abort controllers) across the socket.
 *
 * `outputTail` is read only for shells, and only the last kilobyte: agents'
 * output files are full JSONL transcripts (tailing one puts a wall of raw
 * records in a status row), and reading whole files on every publish would
 * make the panel the most expensive thing on the wire.
 */
export function buildWireTaskSummary(
  task: TaskState,
  appState: AppState,
): WireTask {
  const summary: WireTask = {
    id: task.id,
    kind: task.type,
    description: task.description,
    status: task.status,
    startTime: task.startTime,
    ...(task.endTime ? { endTime: task.endTime } : {}),
    ...(task.toolUseId ? { toolUseId: task.toolUseId } : {}),
  }
  if (task.type === 'local_bash' && task.command) {
    summary.command = task.command
  }
  if (task.type === 'local_agent') {
    summary.agentId = task.agentId
    summary.agentType = task.agentType
    if (task.model) summary.model = task.model
    const name = findAgentName(appState, task.agentId as AgentId)
    if (name) summary.name = name
    if (task.progress) {
      summary.toolUseCount = task.progress.toolUseCount
      summary.tokenCount = task.progress.tokenCount
    }
    const pending = task.pendingMessages?.length
    if (pending) summary.pendingCount = pending
  }
  if (task.type === 'local_bash') {
    summary.command = task.command
    const tail = readOutputTail(task.outputFile)
    if (tail !== undefined) summary.outputTail = tail
    if (task.result?.code !== undefined) summary.exitCode = task.result.code
  }
  return summary
}

/**
 * One task's output tail for the browser viewer. The id is looked up in the
 * session's own tasks first, which both answers "gone from the session" and
 * keeps an attacker-shaped route param from naming any file on the host.
 */
export async function buildWireTaskOutput(
  appState: AppState,
  taskId: string,
  tailBytes: number,
): Promise<WireTaskOutput | null> {
  const task = appState.tasks?.[taskId]
  if (!task) return null
  const tail = await getTaskOutputTail(taskId, tailBytes)
  return {
    content: tail.content,
    offset: tail.offset,
    bytesTotal: tail.bytesTotal,
    done: isTerminalTaskStatus(task.status),
  }
}

/** The panel list: visible tasks, newest first. */
export function buildWireTaskSummaries(appState: AppState): WireTask[] {
  const out: WireTask[] = []
  for (const task of Object.values(appState.tasks ?? {})) {
    if (isWireVisibleTask(task)) out.push(buildWireTaskSummary(task, appState))
  }
  // Newest first: the list reads like a timeline, and a long-running old
  // task must not push today's agents off the bottom of the panel.
  out.sort((a, b) => (b.startTime ?? 0) - (a.startTime ?? 0))
  return out
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
