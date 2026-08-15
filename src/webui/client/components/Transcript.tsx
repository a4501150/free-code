import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { WebTranscriptItem } from '../../protocol/transcriptWire.js'
import { renderMarkdown } from '../markdown.js'
import { ToolCard } from './ToolCard.js'

function sizeLabel(bytes: number): string {
  // Base64 characters, so the transferred size is about three quarters of it.
  const kb = Math.round((bytes * 0.75) / 1024)
  return kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb} KB`
}

const Row = memo(function Row({
  item,
  result,
  onOpenImage,
}: {
  item: WebTranscriptItem
  result?: WebTranscriptItem
  onOpenImage(item: WebTranscriptItem): void
}): React.ReactElement | null {
  switch (item.kind) {
    case 'user':
      return (
        <div className={`row row--user ${item.isMeta ? 'is-meta' : ''}`}>
          <span className="row__gutter">›</span>
          <div className="row__body">
            {item.image ? (
              <button
                type="button"
                className="row__image"
                onClick={() => onOpenImage(item)}
              >
                {item.text} · {sizeLabel(item.image.bytes)}
              </button>
            ) : (
              item.text
            )}
          </div>
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

/** How close to the bottom still counts as following the conversation. */
const FOLLOW_SLACK_PX = 80

type OpenImage = {
  item: WebTranscriptItem
  state: 'loading' | 'ready' | 'failed'
  /**
   * A data URL, which the page's CSP allows through `img-src 'self' data:`.
   * A blob URL is refused by that directive, and building one would need a
   * `fetch` that `connect-src` refuses in turn.
   */
  url?: string
  error?: string
}

export function Transcript({
  items,
  order,
  followSignal,
  onFetchImage,
}: {
  items: Map<string, WebTranscriptItem>
  order: string[]
  /**
   * Bumped when the reader does something that means "show me the newest",
   * which sending a message is. Without it, a reader who scrolled up to quote
   * something stays parked there and never sees their own prompt land.
   */
  followSignal: number
  /** Resolves the bytes for one image, which the wire deliberately omits. */
  onFetchImage(itemId: string): Promise<{ mediaType: string; data: string }>
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

  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const sticky = useRef(true)
  const [open, setOpen] = useState<OpenImage | null>(null)

  // Follow the bottom while the reader is already there. Observing the inner
  // wrapper rather than the scroller is what makes this work: the scroller's
  // own box never changes, so an observer on it would never fire. This one
  // mechanism covers streaming text, a late-decoding image and reflowed
  // markdown alike.
  useLayoutEffect(() => {
    const scroller = scrollRef.current
    const content = contentRef.current
    if (!scroller || !content) return
    const follow = (): void => {
      if (sticky.current) scroller.scrollTop = scroller.scrollHeight
    }
    follow()
    const observer = new ResizeObserver(follow)
    observer.observe(content)
    return () => observer.disconnect()
  }, [])

  // Sending is an explicit "show me what happens next", so it re-arms the
  // follow even for a reader parked further up.
  useLayoutEffect(() => {
    const scroller = scrollRef.current
    if (!scroller) return
    sticky.current = true
    scroller.scrollTop = scroller.scrollHeight
  }, [followSignal])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  async function openImage(item: WebTranscriptItem): Promise<void> {
    setOpen({ item, state: 'loading' })
    try {
      const image = await onFetchImage(item.id)
      setOpen({
        item,
        state: 'ready',
        url: `data:${image.mediaType};base64,${image.data}`,
      })
    } catch (err) {
      setOpen({
        item,
        state: 'failed',
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return (
    <div
      className="transcript"
      ref={scrollRef}
      onScroll={event => {
        const el = event.currentTarget
        sticky.current =
          el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_SLACK_PX
      }}
    >
      <div className="transcript__content" ref={contentRef}>
        {rows.length ? (
          rows.map(({ item, result }) => (
            <Row
              key={item.id}
              item={item}
              result={result}
              onOpenImage={target => void openImage(target)}
            />
          ))
        ) : (
          <div className="transcript--empty">No messages yet.</div>
        )}
      </div>

      {open ? (
        <div
          className="lightbox"
          role="dialog"
          aria-label={open.item.text ?? 'image'}
          onClick={() => setOpen(null)}
        >
          {open.state === 'ready' && open.url ? (
            <img src={open.url} alt={open.item.text ?? 'image'} />
          ) : (
            <p className="lightbox__note">
              {open.state === 'loading' ? 'loading…' : open.error}
            </p>
          )}
          <button type="button" className="lightbox__close">
            close
          </button>
        </div>
      ) : null}
    </div>
  )
}
