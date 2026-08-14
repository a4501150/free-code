import type {
  WebModelOption,
  WebSessionMeta,
  WebTodo,
} from '../../protocol/attachSchemas.js'
import { ModePicker, type Mode } from './ModePicker.js'
import { SessionMeters } from './SessionMeters.js'
import { TodoList } from './TodoList.js'

export function Instruments({
  meta,
  todos,
  models,
  onSetMode,
  onSetModel,
}: {
  meta: WebSessionMeta | null
  todos: WebTodo[]
  models: WebModelOption[]
  onSetMode(mode: Mode): void
  onSetModel(model: string): void
}): React.ReactElement {
  return (
    <aside className="instruments" aria-label="Session details">
      <SessionMeters meta={meta} models={models} onSetModel={onSetModel} />
      <ModePicker active={meta?.permissionMode} onSetMode={onSetMode} />
      <TodoList todos={todos} />
    </aside>
  )
}
