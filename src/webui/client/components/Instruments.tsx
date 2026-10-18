import type {
  WebModelOption,
  WebSessionMeta,
  WebTaskSummary,
  WebTodo,
} from '../../protocol/attachSchemas.js'
import { ModePicker, type Mode } from './ModePicker.js'
import { SessionMeters } from './SessionMeters.js'
import { TaskList } from './TaskList.js'
import { TodoList } from './TodoList.js'

export function Instruments({
  meta,
  todos,
  tasks,
  models,
  viewedTaskId,
  onSetMode,
  onSetModel,
  onViewTask,
  onKillTask,
}: {
  meta: WebSessionMeta | null
  todos: WebTodo[]
  tasks: WebTaskSummary[]
  models: WebModelOption[]
  /** The task whose transcript the main pane is showing, if any. */
  viewedTaskId?: string
  onSetMode(mode: Mode): void
  onSetModel(model: string): void
  onViewTask(taskId: string): void
  onKillTask(taskId: string): void
}): React.ReactElement {
  return (
    <aside className="instruments" aria-label="Session details">
      <SessionMeters meta={meta} models={models} onSetModel={onSetModel} />
      <ModePicker active={meta?.permissionMode} onSetMode={onSetMode} />
      <TodoList todos={todos} />
      <TaskList
        tasks={tasks}
        viewedTaskId={viewedTaskId}
        onViewTask={onViewTask}
        onKillTask={onKillTask}
      />
    </aside>
  )
}
