import type {
  WireCatalog,
  WirePermissionMode,
  WireSessionMeta,
  WireTodo,
} from '../../../session/wire.js'
import { ModePicker } from './ModePicker.js'
import { SessionMeters } from './SessionMeters.js'
import { TodoList } from './TodoList.js'

export function Instruments({
  meta,
  todos,
  catalog,
  onSetMode,
  onSetModel,
}: {
  meta: WireSessionMeta | null
  todos: WireTodo[]
  catalog: WireCatalog
  onSetMode(mode: WirePermissionMode): void
  /** null returns to the account default. */
  onSetModel(model: string | null): void
}): React.ReactElement {
  return (
    <aside className="instruments" aria-label="Session details">
      <SessionMeters
        meta={meta}
        models={catalog.models}
        onSetModel={onSetModel}
      />
      <ModePicker
        active={meta?.permissionMode}
        modes={catalog.permissionModes}
        onSetMode={onSetMode}
      />
      <TodoList todos={todos} />
    </aside>
  )
}
