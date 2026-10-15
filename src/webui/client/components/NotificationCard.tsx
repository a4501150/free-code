import type {
  WireItem,
  WireTask,
  WireTaskNotification,
} from '../../../session/wire.js'

const TYPE_LABEL: Record<string, string> = {
  local_agent: 'agent',
  remote_agent: 'remote',
  local_bash: 'shell',
  monitor_mcp: 'monitor',
  dream: 'dream',
}

function count(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

/** Live status wins over what the notice reported: the task may have moved. */
function liveStatus(
  notice: WireTaskNotification,
  task: WireTask | undefined,
): string | undefined {
  return task?.status ?? notice.status
}

/**
 * A background-task notice as a card, mirroring the terminal's
 * UserAgentNotificationMessage. Fields arrive parsed (`item.notification`);
 * the browser never sees the XML. While the task is still in the session's
 * list, the card tracks its live status, and an agent card opens the same
 * transcript viewer the task panel uses.
 */
export function NotificationCard({
  item,
  tasks,
  onOpenTask,
}: {
  item: WireItem
  tasks?: WireTask[]
  onOpenTask?(taskId: string): void
}): React.ReactElement | null {
  const notice = item.notification
  if (!notice) return null
  const task = notice.taskId
    ? tasks?.find(candidate => candidate.id === notice.taskId)
    : undefined
  const status = liveStatus(notice, task)

  const dot =
    status === 'running' || status === 'pending'
      ? 'is-running'
      : status === 'failed'
        ? 'is-error'
        : status === 'killed'
          ? 'is-killed'
          : 'is-done'

  const typeLabel =
    notice.taskType === 'monitor'
      ? 'monitor'
      : task
        ? (TYPE_LABEL[task.kind] ?? 'task')
        : 'task'

  const openable =
    task && task.kind === 'local_agent' && onOpenTask
      ? notice.taskId
      : undefined

  const metaParts: string[] = []
  if (notice.usage?.durationMs !== undefined)
    metaParts.push(`ran ${duration(notice.usage.durationMs)}`)
  if (notice.usage?.totalTokens !== undefined)
    metaParts.push(`${count(notice.usage.totalTokens)} tok`)
  if (notice.usage?.toolUses !== undefined)
    metaParts.push(`${notice.usage.toolUses} tools`)

  return (
    <div
      className={`notif ${openable ? 'is-openable' : ''}`}
      role={openable ? 'button' : undefined}
      onClick={openable && onOpenTask ? () => onOpenTask(openable) : undefined}
      title={openable ? 'View transcript' : undefined}
    >
      <span className={`notif__dot ${dot}`} aria-hidden />
      <div className="notif__body">
        <div className="notif__head">
          <span className="notif__type">{typeLabel}</span>
          {task?.name ? (
            <span className="notif__name">{task.name}</span>
          ) : notice.taskId ? (
            <span className="notif__name">{notice.taskId}</span>
          ) : null}
          <span className={`notif__status is-${status ?? 'unknown'}`}>
            {status ?? 'reported'}
          </span>
        </div>
        <div className="notif__summary">{notice.summary || notice.raw}</div>
        {metaParts.length ? (
          <div className="notif__meta">{metaParts.join(' · ')}</div>
        ) : null}
        {notice.result ? (
          <details className="notif__details">
            <summary>result</summary>
            <pre className="notif__pre">{notice.result}</pre>
          </details>
        ) : null}
        {notice.outputTail ? (
          <details className="notif__details">
            <summary>output</summary>
            <pre className="notif__pre">{notice.outputTail}</pre>
          </details>
        ) : null}
      </div>
    </div>
  )
}
