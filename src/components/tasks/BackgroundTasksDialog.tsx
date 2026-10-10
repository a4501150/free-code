/**
 * REPL host adapter for the background-tasks dialog: reads the AppState
 * task store, wires the static Task.kill dispatch, and delegates rendering
 * to the host-agnostic panels/BackgroundTasksDialog component. Both mounts
 * (the /tasks command and the REPL's Shift+Down path) go through this
 * adapter.
 */

import * as React from 'react'
import { useAppState, useSetAppState } from 'src/state/AppState.js'
import { DreamTask } from 'src/tasks/DreamTask/DreamTask.js'
import { LocalAgentTask } from 'src/tasks/LocalAgentTask/LocalAgentTask.js'
import { LocalShellTask } from 'src/tasks/LocalShellTask/LocalShellTask.js'
import type { TaskState } from 'src/tasks/types.js'
import type { CommandResultDisplay } from '../../commands.js'
import {
  BackgroundTasksDialog as BackgroundTasksDialogPanel,
  type KillableTaskType,
} from '../panels/BackgroundTasksDialog/BackgroundTasksDialog.js'

type Props = {
  onDone: (
    result?: string,
    options?: { display?: CommandResultDisplay },
  ) => void
  initialDetailTaskId?: string
}

export function BackgroundTasksDialog({
  onDone,
  initialDetailTaskId,
}: Props): React.ReactNode {
  const tasks = useAppState(s => s.tasks) as
    | Record<string, TaskState>
    | undefined
  const foregroundedTaskId = useAppState(s => s.foregroundedTaskId)
  const setAppState = useSetAppState()

  const onKill = (type: KillableTaskType, taskId: string): void => {
    switch (type) {
      case 'local_bash':
        void LocalShellTask.kill(taskId, setAppState)
        break
      case 'local_agent':
        void LocalAgentTask.kill(taskId, setAppState)
        break
      case 'dream':
        void DreamTask.kill(taskId, setAppState)
        break
    }
  }

  return (
    <BackgroundTasksDialogPanel
      onDone={onDone}
      initialDetailTaskId={initialDetailTaskId}
      tasks={tasks}
      foregroundedTaskId={foregroundedTaskId}
      onKill={onKill}
    />
  )
}
