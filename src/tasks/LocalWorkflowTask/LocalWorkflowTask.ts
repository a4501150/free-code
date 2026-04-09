import type { Task, TaskStateBase, SetAppState } from '../../Task.js'

export type LocalWorkflowTaskState = TaskStateBase & {
  type: 'local_workflow'
}

export const LocalWorkflowTask: Task = {
  name: 'local_workflow',
  type: 'local_workflow',
  async kill(_taskId: string, _setAppState: SetAppState): Promise<void> {},
}

export function killWorkflowTask(
  _taskId: string,
  _setAppState: SetAppState,
): void {}

export function skipWorkflowAgent(
  _taskId: string,
  _agentId: string,
  _setAppState: SetAppState,
): void {}

export function retryWorkflowAgent(
  _taskId: string,
  _agentId: string,
  _setAppState: SetAppState,
): void {}
