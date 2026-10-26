import { useEffect, useRef, useState } from 'react'
import type { WebTaskSummary } from '../../protocol/attachSchemas.js'

/** What the shell/monitor viewer holds while the task streams. */
export type ShellOutputState = {
  /** Seed tail plus every `task_output` append received since. */
  text: string
  /** Task terminal: no further frames will arrive. */
  done: boolean
  /** The seed failed because the task is no longer in the session. */
  gone: boolean
  /** The seed read is still in flight. */
  loading: boolean
}

function isRunning(task: WebTaskSummary | undefined): boolean {
  return !task || (task.status !== 'completed' && task.status !== 'failed')
}

/**
 * The live output pane for a background shell or monitor, the web twin of the
 * TUI's ShellDetailDialog: the command it runs, where it stands, and its
 * output file streamed from the host.
 *
 * Long lines scroll horizontally rather than wrapping — the same discipline
 * `.md-table` established, so a stack trace or a JSON line keeps its shape on
 * a phone. The body auto-follows the tail while the reader is already at the
 * bottom; scrolling up anywhere breaks the stick until they scroll back down.
 */
export function TaskOutputView({
  taskId,
  task,
  state,
  onKillTask,
}: {
  taskId: string
  task: WebTaskSummary | undefined
  state: ShellOutputState
  onKillTask(taskId: string): void
}): React.ReactElement {
  const bodyRef = useRef<HTMLPreElement>(null)
  // Stick to the tail until the reader scrolls away from it. Starts stuck:
  // whoever opens a running task wants to watch it, not to scroll.
  const [follow, setFollow] = useState(true)

  useEffect(() => {
    const body = bodyRef.current
    if (body && follow) body.scrollTop = body.scrollHeight
  }, [state.text, follow])

  function onScroll(): void {
    const body = bodyRef.current
    if (!body) return
    const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 24
    setFollow(atBottom)
  }

  const running = task ? isRunning(task) : !state.done && !state.gone
  const stoppable =
    !task && !state.gone
      ? false
      : task && (task.status === 'running' || task.status === 'pending')

  return (
    <div className="shellout">
      <header className="shellout__head">
        {task?.command ? (
          <pre className="shellout__command">{task.command}</pre>
        ) : null}
        <div className="shellout__meta">
          <span className={`task__status is-${task?.status ?? 'unknown'}`}>
            {task?.status ?? 'gone'}
          </span>
          {task?.exitCode !== undefined ? (
            <span
              className={`shellout__exit${task.exitCode === 0 ? ' is-clean' : ''}`}
            >
              exit {task.exitCode}
            </span>
          ) : null}
          {stoppable ? (
            <button
              type="button"
              className="task__kill"
              aria-label="Stop task"
              title="Stop"
              onClick={() => onKillTask(taskId)}
            >
              ■ stop
            </button>
          ) : null}
          {!follow && running ? (
            <button
              type="button"
              className="shellout__follow"
              onClick={() => {
                setFollow(true)
                const body = bodyRef.current
                if (body) body.scrollTop = body.scrollHeight
              }}
            >
              ↓ follow tail
            </button>
          ) : null}
        </div>
      </header>
      {state.gone || (!task && !state.loading) ? (
        <p className="shellout__gone">
          {state.gone
            ? 'This task is no longer running in the session; its output was not recovered.'
            : 'This task has left the session; what is shown is the last output read.'}
        </p>
      ) : null}
      <pre
        ref={bodyRef}
        className="shellout__body"
        onScroll={onScroll}
        aria-live={running ? 'off' : undefined}
      >
        {state.loading && !state.text
          ? 'reading output…'
          : state.text || (running ? 'no output yet' : '')}
      </pre>
    </div>
  )
}
