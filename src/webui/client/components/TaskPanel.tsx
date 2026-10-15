import { useEffect, useState } from 'react'
import type { WireTask } from '../../../session/wire.js'
import { taskView } from '../itemViews.js'

function isTerminal(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'killed'
}

function count(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

/**
 * Background work — agents and shells the session spawned — as a collapsible
 * section. Rows carry the same facts the terminal's panel does — name,
 * description, run time, tool/token counts — and stop anything still running
 * through the session's kill path. Agent rows open the transcript panel;
 * shells and monitors have no transcript, so they are not clickable.
 */
export function TaskPanel({
  tasks,
  viewedTaskId,
  onOpenTask,
  onKillTask,
}: {
  tasks: WireTask[]
  viewedTaskId?: string
  onOpenTask?(taskId: string): void
  onKillTask?(taskId: string): void
}): React.ReactElement | null {
  const [open, setOpen] = useState(true)
  // The one-second tick the run timers need, mounted only while something is
  // still running — a finished list needs no clock.
  const [now, setNow] = useState(() => Date.now())
  const hasLive = tasks.some(task => !isTerminal(task.status))
  useEffect(() => {
    if (!hasLive) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [hasLive])

  if (tasks.length === 0) return null

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
            const openable = task.kind === 'local_agent' && !!onOpenTask
            const stoppable =
              (task.status === 'running' || task.status === 'pending') &&
              !!onKillTask
            const metaParts: string[] = []
            if (task.agentType && task.agentType !== 'general-purpose')
              metaParts.push(task.agentType)
            if (task.tokenCount !== undefined)
              metaParts.push(`${count(task.tokenCount)} tok`)
            if (task.toolUseCount !== undefined)
              metaParts.push(`${task.toolUseCount} tools`)
            if (task.pendingCount) metaParts.push(`${task.pendingCount} queued`)
            if (task.exitCode !== undefined)
              metaParts.push(`exit ${task.exitCode}`)
            return (
              <li
                key={task.id}
                className={`task ${view.statusCls}${
                  task.id === viewedTaskId ? ' is-viewed' : ''
                }`}
              >
                <span className="task__marker" aria-hidden>
                  {view.marker}
                </span>
                <div className="task__body">
                  <button
                    type="button"
                    className="task__main"
                    disabled={!openable}
                    onClick={() => openable && onOpenTask?.(task.id)}
                    title={openable ? 'View transcript' : undefined}
                  >
                    <span className={`task__status ${view.statusCls}`}>
                      {task.status}
                    </span>
                    <span className="task__label">
                      {task.name ? (
                        <span className="task__name">{task.name}</span>
                      ) : null}
                      {view.label}
                    </span>
                    {view.duration ? (
                      <span className="task__duration">{view.duration}</span>
                    ) : null}
                  </button>
                  {metaParts.length ? (
                    <span className="task__meta">{metaParts.join(' · ')}</span>
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
                {stoppable ? (
                  <button
                    type="button"
                    className="task__kill"
                    aria-label={`Stop ${task.name ?? task.description}`}
                    title="Stop"
                    onClick={() => onKillTask?.(task.id)}
                  >
                    ■
                  </button>
                ) : null}
              </li>
            )
          })}
        </ul>
      ) : null}
    </section>
  )
}
