import { useState } from 'react'
import type { WireItem, WireTask } from '../../../session/wire.js'
import { sizeLabel, type WebImageRef } from '../images.js'
import { summarizeToolInput as summarizeInput } from '../itemViews.js'
import { DiffView } from './DiffView.js'

type ToolStatus = 'running' | 'completed' | 'error' | 'pending'

function getToolStatus(
  item: WireItem,
  result?: WireItem,
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
  onOpenAgent,
}: {
  item: WireItem
  result?: WireItem
  inProgressToolUseIds?: string[]
  compact?: boolean
  /** Opens the lightbox for an image the result carried. */
  onOpenImage(image: WebImageRef): void
  /** The session's background tasks, to spot a backgrounded shell. */
  tasks?: WireTask[]
  /** Opens a task's viewer; the chip only shows when this exists. */
  onOpenTask?(taskId: string): void
  /**
   * Present when the session can serve sidechain transcripts. An agent
   * tool whose receipt carries an agent id gets an affordance; the id is
   * the receipt's, never a guess from the tool input.
   */
  onOpenAgent?: (agentId: string) => void
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
            (task.kind === 'local_bash' || task.kind === 'monitor_mcp'),
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
        {onOpenAgent && result?.agentId ? (
          <button
            type="button"
            className="tool__agent"
            title="Open the agent transcript"
            onClick={event => {
              // The card head toggles the body; this button is a different
              // action and must not also collapse or expand it.
              event.stopPropagation()
              onOpenAgent(result.agentId!)
            }}
          >
            transcript
          </button>
        ) : null}
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
