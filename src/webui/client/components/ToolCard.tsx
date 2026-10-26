import { useState } from 'react'
import type { WebTaskSummary } from '../../protocol/attachSchemas.js'
import type { WebTranscriptItem } from '../../protocol/transcriptWire.js'
import { sizeLabel, type WebImageRef } from '../images.js'
import { DiffView } from './DiffView.js'

/** Tools whose input is better shown as a diff or a command than as JSON. */
function summarizeInput(item: WebTranscriptItem): string {
  const input = (item.toolInput ?? {}) as Record<string, unknown>
  const first = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = input[key]
      if (typeof value === 'string' && value) return value
    }
    return undefined
  }
  switch (item.toolName) {
    case 'Bash':
      return first('command') ?? ''
    case 'Read':
    case 'Write':
    case 'Edit':
      return first('file_path', 'path') ?? ''
    case 'Glob':
    case 'Grep':
      return first('pattern', 'query') ?? ''
    // Legacy built-in name; MCP agent-browser web_fetch replaced it.
    case 'WebFetch':
    case 'mcp__agent-browser__web_fetch':
      return first('url') ?? ''
    case 'Task':
    case 'Agent':
      return first('description', 'prompt') ?? ''
    default: {
      const keys = Object.keys(input)
      return keys.length
        ? `${keys.length} argument${keys.length > 1 ? 's' : ''}`
        : ''
    }
  }
}

type ToolStatus = 'running' | 'completed' | 'error' | 'pending'

function getToolStatus(
  item: WebTranscriptItem,
  result?: WebTranscriptItem,
  inProgressToolUseIds?: string[],
): ToolStatus {
  if (result?.isError) return 'error'
  if (result) return 'completed'
  if (item.toolUseId && inProgressToolUseIds?.includes(item.toolUseId)) {
    return 'running'
  }
  return 'pending'
}

function StatusDot({ status }: { status: ToolStatus }): React.ReactElement {
  return <span className={`tool__status is-${status}`} />
}

export function ToolCard({
  item,
  result,
  inProgressToolUseIds,
  compact,
  onOpenImage,
  tasks,
  onOpenTask,
}: {
  item: WebTranscriptItem
  result?: WebTranscriptItem
  inProgressToolUseIds?: string[]
  compact?: boolean
  /** Opens the lightbox for an image the result carried. */
  onOpenImage(image: WebImageRef): void
  /** The session's background tasks, to spot a backgrounded shell. */
  tasks?: WebTaskSummary[]
  /** Opens a task's viewer; the chip only shows when this exists. */
  onOpenTask?(taskId: string): void
}): React.ReactElement {
  const [open, setOpen] = useState(false)
  const input = (item.toolInput ?? {}) as Record<string, unknown>
  // The Bash call that backgrounded itself becomes a shell task carrying this
  // tool's id; that link is what makes the output reachable from here.
  const backgrounded =
    onOpenTask && item.toolUseId
      ? tasks?.find(
          task =>
            task.toolUseId === item.toolUseId &&
            (task.taskType === 'local_bash' || task.taskType === 'monitor_mcp'),
        )
      : undefined
  const isEdit =
    item.toolName === 'Edit' &&
    typeof input.old_string === 'string' &&
    typeof input.new_string === 'string'

  const status = getToolStatus(item, result, inProgressToolUseIds)

  return (
    <div
      className={`tool ${result?.isError ? 'is-error' : ''} ${compact ? 'is-compact' : ''}`}
    >
      <button
        type="button"
        className="tool__head"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
      >
        <StatusDot status={status} />
        <span className="tool__caret">{open ? '▾' : '▸'}</span>
        <span className="tool__name">{item.toolName}</span>
        <span className="tool__summary">{summarizeInput(item)}</span>
        {status === 'running' ? (
          <span className="tool__badge tool__badge--running">running</span>
        ) : null}
        {result?.isError ? <span className="tool__badge">error</span> : null}
      </button>

      {open ? (
        <div className="tool__body">
          {backgrounded ? (
            <button
              type="button"
              className="tool__bgchip"
              title="This command is running as a background task"
              onClick={() => onOpenTask?.(backgrounded.id)}
            >
              ▸ background task: {backgrounded.description}
            </button>
          ) : null}
          {isEdit ? (
            <DiffView
              before={String(input.old_string)}
              after={String(input.new_string)}
            />
          ) : (
            <pre className="tool__pre">{JSON.stringify(input, null, 2)}</pre>
          )}
          {result?.text ? <pre className="tool__pre">{result.text}</pre> : null}
          {result?.images?.length ? (
            <div className="tool__images">
              {result.images.map(image => (
                <button
                  key={image.id}
                  type="button"
                  className="row__image"
                  onClick={() =>
                    onOpenImage({ id: image.id, label: '[image]' })
                  }
                >
                  [image] · {sizeLabel(image.bytes)}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
