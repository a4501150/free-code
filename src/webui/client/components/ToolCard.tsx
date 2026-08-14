import { useState } from 'react'
import type { WebTranscriptItem } from '../../protocol/transcriptWire.js'
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
    case 'WebFetch':
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

export function ToolCard({
  item,
  result,
}: {
  item: WebTranscriptItem
  result?: WebTranscriptItem
}): React.ReactElement {
  const [open, setOpen] = useState(false)
  const input = (item.toolInput ?? {}) as Record<string, unknown>
  const isEdit =
    item.toolName === 'Edit' &&
    typeof input.old_string === 'string' &&
    typeof input.new_string === 'string'

  return (
    <div className={`tool ${result?.isError ? 'is-error' : ''}`}>
      <button
        type="button"
        className="tool__head"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
      >
        <span className="tool__caret">{open ? '▾' : '▸'}</span>
        <span className="tool__name">{item.toolName}</span>
        <span className="tool__summary">{summarizeInput(item)}</span>
        {result?.isError ? <span className="tool__badge">error</span> : null}
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
