import type { WebSessionMeta, WebTodo } from '../../protocol/attachSchemas.js'

const MODES = ['default', 'acceptEdits', 'plan'] as const

/**
 * Keeps the tail of a path, which is the informative end. Done here rather than
 * with `direction: rtl`, which reverses mixed content: "+0 -0" became "0- 0+".
 */
function tail(path: string, max = 28): string {
  return path.length <= max ? path : `…${path.slice(-max)}`
}

function Meter({
  label,
  value,
}: {
  label: string
  value: string
}): React.ReactElement {
  return (
    <div className="meter">
      <span className="meter__label">{label}</span>
      <span className="meter__value">{value}</span>
    </div>
  )
}

export function Instruments({
  meta,
  todos,
  onSetMode,
}: {
  meta: WebSessionMeta | null
  todos: WebTodo[]
  onSetMode(mode: (typeof MODES)[number]): void
}): React.ReactElement {
  const open = todos.filter(t => t.status !== 'completed')

  return (
    <aside className="instruments" aria-label="Session details">
      <section className="panel">
        <h2 className="panel__title">session</h2>
        <Meter label="state" value={meta?.state ?? '—'} />
        <Meter label="model" value={meta?.model ?? '—'} />
        <Meter
          label="cost"
          value={meta ? `$${(meta.costUsd ?? 0).toFixed(4)}` : '—'}
        />
        <Meter
          label="lines"
          value={
            meta ? `+${meta.linesAdded ?? 0} −${meta.linesRemoved ?? 0}` : '—'
          }
        />
        <Meter label="cwd" value={meta ? tail(meta.cwd) : '—'} />
      </section>

      <section className="panel">
        <h2 className="panel__title">permission mode</h2>
        <div className="modes">
          {MODES.map(mode => (
            <button
              key={mode}
              type="button"
              className={`mode ${meta?.permissionMode === mode ? 'is-active' : ''}`}
              onClick={() => onSetMode(mode)}
            >
              {mode}
            </button>
          ))}
        </div>
        {/* bypassPermissions is deliberately absent: this UI is reachable from
            the public internet behind one password. */}
      </section>

      <section className="panel">
        <h2 className="panel__title">
          todos{' '}
          {open.length ? (
            <span className="panel__count">{open.length}</span>
          ) : null}
        </h2>
        {todos.length === 0 ? (
          <p className="panel__empty">None.</p>
        ) : (
          <ul className="todos">
            {todos.map((todo, index) => (
              <li key={index} className={`todo is-${todo.status}`}>
                <span className="todo__box">
                  {todo.status === 'completed'
                    ? '×'
                    : todo.status === 'in_progress'
                      ? '·'
                      : ' '}
                </span>
                <span className="todo__text">
                  {todo.status === 'in_progress' && todo.activeForm
                    ? todo.activeForm
                    : todo.content}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </aside>
  )
}
