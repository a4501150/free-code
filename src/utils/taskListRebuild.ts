/**
 * Rebuilds a session's task list by replaying TaskCreate/TaskUpdate calls
 * found in a transcript JSONL. Session lists are deleted on process exit
 * (cleanupSessionTaskList), so a resume starts task-less; the transcript is
 * append-only (compaction never removes lines), making it the only durable
 * record of what the list held.
 *
 * Scans the RAW file, not the resume-loaded in-memory chain: buildConversation
 * stops at the compact boundary, so in-memory replay would miss every task op
 * from before the last compaction. Also bypasses loadTranscriptFile, whose
 * >5MB fast scan skips pre-boundary bytes.
 *
 * Replay is faithful: tasks resurrect with their final state, including
 * fully-completed lists (they re-enter the normal hide-timer lifecycle on
 * resume). Deletes cascade like deleteTask (references stripped from other
 * tasks' blocks/blockedBy). `owner` is not reconstructable — it only exists
 * via claimTask on tasks-mode queues, and rebuild never touches override
 * lists.
 */

import { readFile } from 'fs/promises'
import { TASK_CREATE_TOOL_NAME } from '../tools/TaskCreateTool/constants.js'
import { TASK_UPDATE_TOOL_NAME } from '../tools/TaskUpdateTool/constants.js'
import { logForDebugging } from './debug.js'
import { errorMessage } from './errors.js'
import { getTranscriptPathForSession } from './sessionStorage.js'
import { jsonParse } from './slowOperations.js'
import { TaskSchema, type Task } from './taskSchemas.js'
import {
  getMainTaskListId,
  isTaskListIdOverrideActive,
  listTasks,
  seedTaskList,
} from './tasks.js'

type ToolUseRecord = {
  name: string
  input: Record<string, unknown>
}

type ToolResultRecord = {
  structured: unknown
  text: string
}

/** Extract the assigned task ID from a persisted TaskCreate result. */
function taskIdFromCreateResult(result: ToolResultRecord): string | undefined {
  const structured = result.structured as
    | { task?: { id?: unknown } }
    | undefined
  if (
    structured &&
    typeof structured === 'object' &&
    typeof structured.task?.id === 'string'
  ) {
    return structured.task.id
  }
  const match = /Task #(\S+)/.exec(result.text)
  return match ? match[1] : undefined
}

/**
 * Collects, in file order, the task tool calls (assistant tool_use blocks)
 * and their results (user tool_result blocks), paired by tool_use id.
 * Dedupes by message uuid: compaction re-records kept messages post-boundary
 * and rewind re-records survivors — same uuid, same content, must replay once.
 */
function scanTaskOps(
  lines: string[],
): Map<string, { use: ToolUseRecord; result?: ToolResultRecord }> {
  const ops = new Map<
    string,
    { use: ToolUseRecord; result?: ToolResultRecord }
  >()
  const seenUuids = new Set<string>()
  const resultsById = new Map<string, ToolResultRecord>()

  // Result messages can trail their tool_use by a few lines; collect them
  // first so a single pass pairs each use with its final result.
  for (const line of lines) {
    if (!line.includes('tool_result')) continue
    let entry: Record<string, unknown>
    try {
      entry = jsonParse(line) as Record<string, unknown>
    } catch {
      continue
    }
    if (entry.isSidechain || typeof entry.uuid !== 'string') continue
    const message = entry.message as { content?: unknown } | undefined
    const blocks = Array.isArray(message?.content) ? message!.content : []
    for (const block of blocks as Array<Record<string, unknown>>) {
      if (block.type !== 'tool_result') continue
      const toolUseId = block.tool_use_id
      if (typeof toolUseId !== 'string') continue
      const content = block.content
      const text =
        typeof content === 'string' ? content : JSON.stringify(content ?? '')
      resultsById.set(toolUseId, { structured: entry.toolUseResult, text })
    }
  }

  for (const line of lines) {
    if (!line.includes('tool_use')) continue
    let entry: Record<string, unknown>
    try {
      entry = jsonParse(line) as Record<string, unknown>
    } catch {
      continue
    }
    if (entry.isSidechain || typeof entry.uuid !== 'string') continue
    if (seenUuids.has(entry.uuid)) continue
    const message = entry.message as { content?: unknown } | undefined
    const blocks = Array.isArray(message?.content) ? message!.content : []
    for (const block of blocks as Array<Record<string, unknown>>) {
      if (block.type !== 'tool_use') continue
      if (
        block.name !== TASK_CREATE_TOOL_NAME &&
        block.name !== TASK_UPDATE_TOOL_NAME
      )
        continue
      const toolUseId = block.id
      if (typeof toolUseId !== 'string') continue
      seenUuids.add(entry.uuid)
      const input = block.input
      if (typeof input !== 'object' || input === null) continue
      ops.set(toolUseId, {
        use: {
          name: block.name as string,
          input: input as Record<string, unknown>,
        },
        result: resultsById.get(toolUseId),
      })
    }
  }
  return ops
}

/**
 * Applies one replayed update to the in-memory task map, mirroring
 * TaskUpdateTool.call's semantics (see src/tools/TaskUpdateTool/TaskUpdateTool.ts):
 * field replacement, metadata merge with null-deletes, addBlocks/addBlockedBy
 * cross-referencing (only when the other task exists), and 'deleted' removing
 * the task plus its references from every other task.
 */
function applyUpdate(
  tasks: Map<string, Task>,
  taskId: string,
  input: Record<string, unknown>,
): void {
  const task = tasks.get(taskId)
  if (!task) return

  if (typeof input.subject === 'string') task.subject = input.subject
  if (typeof input.description === 'string')
    task.description = input.description
  if (typeof input.activeForm === 'string') task.activeForm = input.activeForm
  if (input.metadata !== null && typeof input.metadata === 'object') {
    const merged = { ...(task.metadata ?? {}) }
    for (const [key, value] of Object.entries(
      input.metadata as Record<string, unknown>,
    )) {
      if (value === null) delete merged[key]
      else merged[key] = value
    }
    task.metadata = merged
  }

  const status = input.status
  if (status === 'deleted') {
    tasks.delete(taskId)
    for (const other of tasks.values()) {
      other.blocks = other.blocks.filter(id => id !== taskId)
      other.blockedBy = other.blockedBy.filter(id => id !== taskId)
    }
    return
  }
  if (typeof status === 'string') task.status = status as Task['status']

  if (Array.isArray(input.addBlocks)) {
    for (const target of input.addBlocks as unknown[]) {
      if (typeof target !== 'string' || task.blocks.includes(target)) continue
      task.blocks.push(target)
      const blocked = tasks.get(target)
      if (blocked && !blocked.blockedBy.includes(taskId)) {
        blocked.blockedBy.push(taskId)
      }
    }
  }
  if (Array.isArray(input.addBlockedBy)) {
    for (const blocker of input.addBlockedBy as unknown[]) {
      if (typeof blocker !== 'string' || task.blockedBy.includes(blocker))
        continue
      task.blockedBy.push(blocker)
      const blockerTask = tasks.get(blocker)
      if (blockerTask && !blockerTask.blocks.includes(taskId)) {
        blockerTask.blocks.push(taskId)
      }
    }
  }
}

/**
 * Rebuilds the current session's task list from a transcript JSONL.
 * Returns true when tasks were seeded.
 *
 * Skips (returns false) when: a task-list override is active (never replay
 * into the --tasks cross-process queue, which holds state no transcript
 * contains), the target list already has tasks on disk (crash leftover or a
 * concurrent resumer seeded it — disk wins), or the file carries no task ops.
 */
export async function rebuildTaskListFromTranscript(
  sourceTranscriptPath: string,
): Promise<boolean> {
  if (isTaskListIdOverrideActive()) return false

  const taskListId = getMainTaskListId()
  if ((await listTasks(taskListId)).length > 0) return false

  let content: string
  try {
    content = await readFile(sourceTranscriptPath, 'utf-8')
  } catch {
    return false
  }

  const ops = scanTaskOps(content.split('\n'))
  const tasks = new Map<string, Task>()
  for (const { use, result } of ops.values()) {
    if (use.name === TASK_CREATE_TOOL_NAME) {
      if (!result) continue
      const id = taskIdFromCreateResult(result)
      if (id === undefined) continue
      const input = use.input
      const candidate = {
        id,
        subject: typeof input.subject === 'string' ? input.subject : '',
        description:
          typeof input.description === 'string' ? input.description : '',
        activeForm:
          typeof input.activeForm === 'string' ? input.activeForm : undefined,
        status: 'pending' as const,
        owner: undefined,
        blocks: [],
        blockedBy: [],
        metadata:
          input.metadata !== null && typeof input.metadata === 'object'
            ? (input.metadata as Record<string, unknown>)
            : undefined,
      }
      const parsed = TaskSchema.safeParse(candidate)
      if (parsed.success) tasks.set(id, parsed.data)
    } else if (use.name === TASK_UPDATE_TOOL_NAME) {
      // Skip updates the tool reported failed ("Task not found" etc.);
      // a missing structured result is treated as success — updates are
      // idempotent and self-guarding against absent tasks.
      const structured = result?.structured as { success?: unknown } | undefined
      if (structured && structured.success === false) continue
      const taskId = use.input.taskId
      if (typeof taskId === 'string') {
        applyUpdate(tasks, taskId, use.input)
      }
    }
  }

  if (tasks.size === 0) return false
  // Updates mutate validated creates; re-validate final states so a corrupt
  // input (e.g. a status outside the enum) drops the task, not the seed.
  const finalTasks: Task[] = []
  for (const task of tasks.values()) {
    const parsed = TaskSchema.safeParse(task)
    if (parsed.success) finalTasks.push(parsed.data)
  }
  if (finalTasks.length === 0) return false
  return seedTaskList(taskListId, finalTasks)
}

/**
 * Resume-path wrapper: resolves the source session's transcript file and
 * rebuilds the current session's task list from it. Fire-and-forget safe —
 * errors are logged, never propagated, so a rebuild bug cannot break resume.
 */
export async function maybeRebuildTaskListForResume(source: {
  sessionId: string | undefined
  transcriptPath?: string
}): Promise<void> {
  try {
    const path =
      source.transcriptPath ??
      (source.sessionId
        ? getTranscriptPathForSession(source.sessionId)
        : undefined)
    if (!path) return
    await rebuildTaskListFromTranscript(path)
  } catch (e) {
    logForDebugging(`[Tasks] Task list rebuild failed: ${errorMessage(e)}`)
  }
}
