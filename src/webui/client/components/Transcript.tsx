import { memo, useMemo } from 'react'
import type { WebTranscriptItem } from '../../protocol/transcriptWire.js'
import { renderMarkdown } from '../markdown.js'
import { ToolCard } from './ToolCard.js'

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
