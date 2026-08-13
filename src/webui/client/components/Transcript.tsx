import { memo, useMemo, useState } from 'react'
import type { WebTranscriptItem } from '../../protocol/transcriptWire.js'
import { renderMarkdown } from '../markdown.js'
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

function ToolCard({
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

const Row = memo(function Row({
  item,
  result,
}: {
  item: WebTranscriptItem
  result?: WebTranscriptItem
}): React.ReactElement | null {
  switch (item.kind) {
    case 'user':
      return (
        <div className={`row row--user ${item.isMeta ? 'is-meta' : ''}`}>
          <span className="row__gutter">›</span>
          <div className="row__body">{item.text}</div>
        </div>
      )

    case 'assistant':
      return (
        <div className="row row--assistant">
          <div
            className="row__body md"
            // The gateway is the only writer and renderMarkdown sanitizes, but
            // treat every transcript string as untrusted regardless.
            dangerouslySetInnerHTML={{
              __html: renderMarkdown(item.text ?? ''),
            }}
          />
        </div>
      )

    case 'reasoning':
      return (
        <div className="row row--reasoning">
          <span className="row__gutter">✳</span>
          <div className="row__body">{item.text}</div>
        </div>
      )

    case 'tool_use':
      return <ToolCard item={item} result={result} />

    case 'system':
      if (!item.text) return null
      return (
        <div className={`row row--system is-${item.level ?? 'info'}`}>
          <div className="row__body">{item.text}</div>
        </div>
      )

    // Tool results render inside their tool card, and attachments are noise.
    case 'tool_result':
    case 'attachment':
      return null
  }
})

export function Transcript({
  items,
  order,
}: {
  items: Map<string, WebTranscriptItem>
  order: string[]
}): React.ReactElement {
  const rows = useMemo(() => {
    const list = order
      .map(id => items.get(id))
      .filter((item): item is WebTranscriptItem => Boolean(item))

    // Pair each result with its tool_use so a card owns its output.
    const resultsByToolUse = new Map<string, WebTranscriptItem>()
    for (const item of list) {
      if (item.kind === 'tool_result' && item.toolUseId) {
        resultsByToolUse.set(item.toolUseId, item)
      }
    }
    return list.map(item => ({
      item,
      result:
        item.kind === 'tool_use' && item.toolUseId
          ? resultsByToolUse.get(item.toolUseId)
          : undefined,
    }))
  }, [items, order])

  if (!rows.length) {
    return <div className="transcript transcript--empty">No messages yet.</div>
  }

  return (
    <div className="transcript">
      {rows.map(({ item, result }) => (
        <Row key={item.id} item={item} result={result} />
      ))}
    </div>
  )
}
