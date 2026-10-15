import { useState } from 'react'
import type { WireItem } from '../../../session/wire.js'
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
  onOpenAgent,
}: {
  item: WireItem
  result?: WireItem
  inProgressToolUseIds?: string[]
  compact?: boolean
  /**
   * Present when the session can serve sidechain transcripts. An agent
   * tool whose receipt carries an agent id gets an affordance; the id is
   * the receipt's, never a guess from the tool input.
   */
  onOpenAgent?: (agentId: string) => void
}): React.ReactElement {
  const [open, setOpen] = useState(false)
  const input = (item.toolInput ?? {}) as Record<string, unknown>
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
          {isEdit ? (
            <DiffView
              before={String(input.old_string)}
              after={String(input.new_string)}
            />
          ) : (
            <pre className="tool__pre">{JSON.stringify(input, null, 2)}</pre>
          )}
          {result?.text ? <pre className="tool__pre">{result.text}</pre> : null}
        </div>
      ) : null}
    </div>
  )
}
