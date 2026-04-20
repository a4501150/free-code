import { feature } from 'bun:bundle'
import type { Task, TaskType } from './Task.js'
import { DreamTask } from './tasks/DreamTask/DreamTask.js'
import { LocalAgentTask } from './tasks/LocalAgentTask/LocalAgentTask.js'
import { LocalShellTask } from './tasks/LocalShellTask/LocalShellTask.js'

import * as localWorkflowTaskNs from './tasks/LocalWorkflowTask/LocalWorkflowTask.js'
const LocalWorkflowTask: Task | null = feature('WORKFLOW_SCRIPTS')
  ? localWorkflowTaskNs.LocalWorkflowTask
  : null

/**
 * Get all tasks.
 * Mirrors the pattern from tools.ts
 * Note: Returns array inline to avoid circular dependency issues with top-level const
 */
export function getAllTasks(): Task[] {
  const tasks: Task[] = [
    LocalShellTask,
    LocalAgentTask,
    DreamTask,
  ]
  if (LocalWorkflowTask) tasks.push(LocalWorkflowTask)
  return tasks
}

/**
 * Get a task by its type.
 */
export function getTaskByType(type: TaskType): Task | undefined {
  return getAllTasks().find(t => t.type === type)
}
