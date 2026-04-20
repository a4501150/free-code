import { errorMessage } from '../utils/errors.js'
import { logError } from '../utils/log.js'
import {
  DEFAULT_TASKS_MODE_TASK_LIST_ID,
  TASK_STATUSES,
  type Task,
  type TaskStatus,
  createTask,
  getTask,
  getTasksDir,
  listTasks,
  updateTask,
} from '../utils/tasks.js'

type ListId = { list?: string }

function listIdOf(opts: ListId): string {
  return opts.list || DEFAULT_TASKS_MODE_TASK_LIST_ID
}

function formatTask(task: Task, indent = ''): string {
  const parts = [
    `${indent}#${task.id} [${task.status}] ${task.subject}`,
  ]
  if (task.owner) parts.push(`${indent}  owner: ${task.owner}`)
  if (task.blockedBy.length > 0)
    parts.push(`${indent}  blockedBy: ${task.blockedBy.join(', ')}`)
  if (task.blocks.length > 0)
    parts.push(`${indent}  blocks: ${task.blocks.join(', ')}`)
  if (task.description)
    parts.push(`${indent}  description: ${task.description}`)
  return parts.join('\n')
}

/** `claude task create <subject>` */
export async function taskCreateHandler(
  subject: string,
  opts: { description?: string; list?: string },
): Promise<void> {
  try {
    const id = await createTask(listIdOf(opts), {
      subject,
      description: opts.description ?? '',
      status: 'pending',
      blocks: [],
      blockedBy: [],
    })
    // biome-ignore lint/suspicious/noConsole:: user-facing CLI output
    console.log(`Created task #${id}: ${subject}`)
  } catch (e) {
    logError(e)
    // biome-ignore lint/suspicious/noConsole:: user-facing CLI output
    console.error(`Failed to create task: ${errorMessage(e)}`)
    // eslint-disable-next-line custom-rules/no-process-exit
    process.exit(1)
  }
}

/** `claude task list` */
export async function taskListHandler(opts: {
  list?: string
  pending?: boolean
  json?: boolean
}): Promise<void> {
  try {
    let tasks = await listTasks(listIdOf(opts))
    if (opts.pending) {
      tasks = tasks.filter(t => t.status === 'pending')
    }
    tasks.sort((a, b) => Number(a.id) - Number(b.id))
    if (opts.json) {
      // biome-ignore lint/suspicious/noConsole:: user-facing CLI output
      console.log(JSON.stringify(tasks, null, 2))
      return
    }
    if (tasks.length === 0) {
      // biome-ignore lint/suspicious/noConsole:: user-facing CLI output
      console.log('No tasks')
      return
    }
    for (const task of tasks) {
      // biome-ignore lint/suspicious/noConsole:: user-facing CLI output
      console.log(formatTask(task))
    }
  } catch (e) {
    logError(e)
    // biome-ignore lint/suspicious/noConsole:: user-facing CLI output
    console.error(`Failed to list tasks: ${errorMessage(e)}`)
    // eslint-disable-next-line custom-rules/no-process-exit
    process.exit(1)
  }
}

/** `claude task get <id>` */
export async function taskGetHandler(
  id: string,
  opts: { list?: string },
): Promise<void> {
  try {
    const task = await getTask(listIdOf(opts), id)
    if (!task) {
      // biome-ignore lint/suspicious/noConsole:: user-facing CLI output
      console.error(`Task #${id} not found`)
      // eslint-disable-next-line custom-rules/no-process-exit
      process.exit(1)
    }
    // biome-ignore lint/suspicious/noConsole:: user-facing CLI output
    console.log(JSON.stringify(task, null, 2))
  } catch (e) {
    logError(e)
    // biome-ignore lint/suspicious/noConsole:: user-facing CLI output
    console.error(`Failed to get task: ${errorMessage(e)}`)
    // eslint-disable-next-line custom-rules/no-process-exit
    process.exit(1)
  }
}

/** `claude task update <id>` */
export async function taskUpdateHandler(
  id: string,
  opts: {
    list?: string
    status?: string
    subject?: string
    description?: string
    owner?: string
    clearOwner?: boolean
  },
): Promise<void> {
  try {
    const updates: Partial<Omit<Task, 'id'>> = {}
    if (opts.status !== undefined) {
      if (!TASK_STATUSES.includes(opts.status as TaskStatus)) {
        // biome-ignore lint/suspicious/noConsole:: user-facing CLI output
        console.error(
          `Invalid status "${opts.status}". Expected one of: ${TASK_STATUSES.join(', ')}`,
        )
        // eslint-disable-next-line custom-rules/no-process-exit
        process.exit(1)
      }
      updates.status = opts.status as TaskStatus
    }
    if (opts.subject !== undefined) updates.subject = opts.subject
    if (opts.description !== undefined) updates.description = opts.description
    if (opts.clearOwner) {
      updates.owner = undefined
    } else if (opts.owner !== undefined) {
      updates.owner = opts.owner
    }
    const updated = await updateTask(listIdOf(opts), id, updates)
    if (!updated) {
      // biome-ignore lint/suspicious/noConsole:: user-facing CLI output
      console.error(`Task #${id} not found`)
      // eslint-disable-next-line custom-rules/no-process-exit
      process.exit(1)
    }
    // biome-ignore lint/suspicious/noConsole:: user-facing CLI output
    console.log(`Updated task #${id}`)
    // biome-ignore lint/suspicious/noConsole:: user-facing CLI output
    console.log(formatTask(updated))
  } catch (e) {
    logError(e)
    // biome-ignore lint/suspicious/noConsole:: user-facing CLI output
    console.error(`Failed to update task: ${errorMessage(e)}`)
    // eslint-disable-next-line custom-rules/no-process-exit
    process.exit(1)
  }
}

/** `claude task dir` */
export async function taskDirHandler(opts: {
  list?: string
}): Promise<void> {
  // biome-ignore lint/suspicious/noConsole:: user-facing CLI output
  console.log(getTasksDir(listIdOf(opts)))
}
