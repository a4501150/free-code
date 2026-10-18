import { useEffect, useState } from 'react'
import type { WebTaskSummary } from '../../protocol/attachSchemas.js'

const TYPE_ICON: Record<WebTaskSummary['taskType'], string> = {
  local_agent: '◆',
  remote_agent: '◈',
  local_bash: '$',
  monitor_mcp: '~',
  dream: '◇',
}

/** The task type as the panel labels it. */
const TYPE_LABEL: Record<WebTaskSummary['taskType'], string> = {
  local_agent: 'agent',
  remote_agent: 'remote',
  local_bash: 'shell',
  monitor_mcp: 'monitor',
  dream: 'dream',
}

function isTerminal(status: WebTaskSummary['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'killed'
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return `${h}h${m % 60}m`
}

function count(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

function elapsed(task: WebTaskSummary, now: number): string {
  const end = task.endTime ?? now
  const ran = ago(end - task.startTime)
  return isTerminal(task.status) ? `${ran} ago` : ran
}

/**
 * Background tasks and subagents of the attached session.
 *
 * Rows carry the same facts the terminal's coordinator panel does — name,
 * description, run time, tool/token counts — and stop controls for anything
 * still running. Agent rows open the transcript viewer; shells and monitors
 * have no transcript to show, so they are not clickable.
 */
export function TaskList({
  tasks,
  viewedTaskId,
  onViewTask,
  onKillTask,
}: {
  tasks: WebTaskSummary[]
  viewedTaskId?: string
  onViewTask(taskId: string): void
  onKillTask(taskId: string): void
}): React.ReactElement {
  // The one-second tick the run timers need, mounted only while something is
  // still running — a finished list needs no clock.
  const [now, setNow] = useState(() => Date.now())
  const hasLive = tasks.some(task => !isTerminal(task.status))
  useEffect(() => {
    if (!hasLive) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [hasLive])

  const running = tasks.filter(task => !isTerminal(task.status)).length

  return (
    <section className="panel">
      <h2 className="panel__title">
        tasks{' '}
        {running > 0 ? <span className="panel__count">{running}</span> : null}
      </h2>
      {tasks.length === 0 ? (
        <p className="panel__empty">None.</p>
      ) : (
        <ul className="tasks">
          {tasks.map(task => {
            const viewable = task.taskType === 'local_agent'
            const stoppable =
              task.status === 'running' || task.status === 'pending'
            return (
              <li
                key={task.id}
                className={`task is-${task.status}${
                  task.id === viewedTaskId ? ' is-viewed' : ''
                }`}
              >
                <button
                  type="button"
                  className="task__main"
                  disabled={!viewable}
                  onClick={() => viewable && onViewTask(task.id)}
                  title={viewable ? 'View transcript' : undefined}
                >
                  <span className="task__icon" aria-hidden>
                    {TYPE_ICON[task.taskType]}
                  </span>
                  <span className="task__body">
                    <span className="task__desc">
                      {task.name ? (
                        <span className="task__name">{task.name}</span>
                      ) : null}
                      {task.description}
                    </span>
                    <span className="task__meta">
                      {TYPE_LABEL[task.taskType]}
                      {task.agentType && task.agentType !== 'general-purpose'
                        ? `:${task.agentType}`
                        : ''}
                      {' · '}
                      {elapsed(task, now)}
                      {task.tokenCount !== undefined
                        ? ` · ${count(task.tokenCount)} tok`
                        : ''}
                      {task.toolUseCount !== undefined
                        ? ` · ${task.toolUseCount} tools`
                        : ''}
                      {task.pendingCount
                        ? ` · ${task.pendingCount} queued`
                        : ''}
                      {task.exitCode !== undefined
                        ? ` · exit ${task.exitCode}`
                        : ''}
                    </span>
                  </span>
                  <span className={`task__status is-${task.status}`}>
                    {task.status}
                  </span>
                </button>
                {stoppable ? (
                  <button
                    type="button"
                    className="task__kill"
                    aria-label={`Stop ${task.name ?? task.description}`}
                    title="Stop"
                    onClick={() => onKillTask(task.id)}
                  >
                    ■
                  </button>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
