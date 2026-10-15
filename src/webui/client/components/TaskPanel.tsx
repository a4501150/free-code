import { useState } from 'react'
import type { WireTask } from '../../../session/wire.js'
import { taskView } from '../itemViews.js'

/**
 * Background work — agents and shells the session spawned — as a collapsible
 * section. Read-only by design: lifecycle actions need an rpc the session
 * does not serve for tasks yet, and a button that cannot act is a lie.
 */
export function TaskPanel({
  tasks,
}: {
  tasks: WireTask[]
}): React.ReactElement | null {
  const [open, setOpen] = useState(true)
  if (tasks.length === 0) return null

  // One clock per render; running rows tick when the store re-renders.
  const now = Date.now()

  return (
    <section className={`tasks${open ? ' is-open' : ''}`}>
      <button
        type="button"
        className="tasks__head"
        aria-expanded={open}
        onClick={() => setOpen(o => !o)}
      >
        <span className="tasks__caret">{open ? '▾' : '▸'}</span>
        tasks
        <span className="tasks__count">{tasks.length}</span>
      </button>
      {open ? (
        <ul className="tasks__list">
          {tasks.map(task => {
            const view = taskView(task, now)
            return (
              <li key={task.id} className={`task ${view.statusCls}`}>
                <span className="task__marker" aria-hidden>
                  {view.marker}
                </span>
                <div className="task__body">
                  <span className={`task__status ${view.statusCls}`}>
                    {task.status}
                  </span>
                  <span className="task__label">{view.label}</span>
                  {view.duration ? (
                    <span className="task__duration">{view.duration}</span>
                  ) : null}
                  {view.command ? (
                    <pre className="task__detail is-mono">{view.command}</pre>
                  ) : null}
                  {view.outputTail ? (
                    <pre className="task__detail is-mono">
                      {view.outputTail}
                    </pre>
                  ) : null}
                </div>
              </li>
            )
          })}
        </ul>
      ) : null}
    </section>
  )
}
