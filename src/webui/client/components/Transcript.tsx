import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { WireItem } from '../../../session/wire.js'
import { renderMarkdown } from '../markdown.js'
import {
  agentIdsByToolUse,
  attachmentGutter,
  attachmentView,
  compactDividerText,
  progressView,
  toolNamesByUseId,
  type AttachmentView,
  type ProgressView,
} from '../itemViews.js'
import { ToolCard } from './ToolCard.js'

function sizeLabel(bytes: number): string {
  // Base64 characters, so the transferred size is about three quarters of it.
  const kb = Math.round((bytes * 0.75) / 1024)
  return kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb} KB`
}

type ToolGroup = {
  kind: 'tool_group'
  messageId: string
  toolName: string
  items: Array<{ item: WireItem; result?: WireItem }>
}

type RowEntry = { kind: 'row'; item: WireItem; result?: WireItem } | ToolGroup

/** A muted, single-line system-ish row shared by progress and attachments. */
function SideRow({
  gutter,
  cls,
  label,
  detail,
  mono,
}: {
  gutter: string
  cls: string
  label: string
  detail?: string
  mono?: boolean
}): React.ReactElement {
  return (
    <div className={`row ${cls}`}>
      <span className="row__gutter">{gutter}</span>
      <div className="row__body">
        <span className="row__label">{label}</span>
        {detail ? (
          <pre className={`row__detail${mono ? ' is-mono' : ''}`}>{detail}</pre>
        ) : null}
      </div>
    </div>
  )
}

function ProgressRow({ view }: { view: ProgressView }): React.ReactElement {
  return (
    <SideRow
      gutter="⋯"
      cls="row--progress"
      label={`${view.label}${view.detail ? ` — ${view.detail}` : ''}`}
    />
  )
}

function AttachmentRow({
  view,
  item,
}: {
  view: AttachmentView
  item: WireItem
}): React.ReactElement {
  return (
    <SideRow
      gutter={attachmentGutter(item.attachment?.type ?? '')}
      cls={`row--attachment ${view.cls}`}
      label={view.label}
      detail={view.detail}
      mono={view.mono}
    />
  )
}

const Row = memo(function Row({
  item,
  result,
  inProgressToolUseIds,
  toolNames,
  agentIds,
  onOpenImage,
  onOpenAgent,
}: {
  item: WireItem
  result?: WireItem
  inProgressToolUseIds?: string[]
  toolNames: Map<string, string>
  /** tool_use ids whose agent receipt proved a sidechain exists. */
  agentIds: Map<string, string>
  onOpenImage(item: WireItem): void
  onOpenAgent?: (agentId: string) => void
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
      return (
        <ToolCard
          item={item}
          result={result}
          inProgressToolUseIds={inProgressToolUseIds}
          onOpenAgent={
            onOpenAgent && item.toolUseId && agentIds.has(item.toolUseId)
              ? () => {
                  const id = agentIds.get(item.toolUseId!)
                  if (id) onOpenAgent(id)
                }
              : undefined
          }
        />
      )

    case 'system': {
      const divider = compactDividerText(item)
      if (divider) {
        return (
          <div className="row row--compact-seam" role="separator">
            <span className="row__rule" aria-hidden />
            <span className="row__seam-label">{divider}</span>
            <span className="row__rule" aria-hidden />
          </div>
        )
      }
      if (!item.text) return null
      return (
        <div className={`row row--system is-${item.level ?? 'info'}`}>
          <div className="row__body">{item.text}</div>
        </div>
      )
    }

    case 'progress': {
      const view = progressView(item, toolNames)
      if (!view) return null
      return <ProgressRow view={view} />
    }

    case 'attachment': {
      const view = attachmentView(item)
      if (!view) return null
      return <AttachmentRow view={view} item={item} />
    }

    // Tool results render inside their tool card.
    case 'tool_result':
      return null
  }
})

const AgentGroup = memo(function AgentGroup({
  group,
  inProgressToolUseIds,
  agentIds,
  onOpenAgent,
}: {
  group: ToolGroup
  inProgressToolUseIds?: string[]
  agentIds: Map<string, string>
  onOpenAgent?: (agentId: string) => void
}): React.ReactElement {
  const running = group.items.filter(
    ({ item }) =>
      item.toolUseId && inProgressToolUseIds?.includes(item.toolUseId),
  ).length
  const completed = group.items.filter(({ result }) => result).length
  const errored = group.items.filter(({ result }) => result?.isError).length
  const total = group.items.length

  let header: string
  if (running > 0) {
    header = `Running ${total} agent${total > 1 ? 's' : ''}…`
  } else if (errored > 0) {
    header = `${total} agent${total > 1 ? 's' : ''} finished (${errored} error${errored > 1 ? 's' : ''})`
  } else if (completed === total) {
    header = `${total} agent${total > 1 ? 's' : ''} finished`
  } else {
    header = `${total} agent${total > 1 ? 's' : ''}`
  }

  return (
    <div className="agent-group">
      <div className="agent-group__header">
        <span
          className={`agent-group__dot ${running > 0 ? 'is-running' : errored > 0 ? 'is-error' : 'is-done'}`}
        />
        {header}
      </div>
      {group.items.map(({ item, result }) => (
        <ToolCard
          key={item.id}
          item={item}
          result={result}
          inProgressToolUseIds={inProgressToolUseIds}
          compact
          onOpenAgent={
            onOpenAgent && item.toolUseId && agentIds.has(item.toolUseId)
              ? () => {
                  const id = agentIds.get(item.toolUseId!)
                  if (id) onOpenAgent(id)
                }
              : undefined
          }
        />
      ))}
    </div>
  )
})

/** How close to the bottom still counts as following the conversation. */
const FOLLOW_SLACK_PX = 80

type OpenImage = {
  item: WireItem
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
  inProgressToolUseIds,
  activity,
  followSignal,
  onFetchImage,
  onOpenAgent,
}: {
  items: Map<string, WireItem>
  order: string[]
  inProgressToolUseIds?: string[]
  activity?: string
  /**
   * Bumped when the reader does something that means "show me the newest",
   * which sending a message is. Without it, a reader who scrolled up to quote
   * something stays parked there and never sees their own prompt land.
   */
  followSignal: number
  /** Resolves the bytes for one image, which the wire deliberately omits. */
  onFetchImage(itemId: string): Promise<{ mediaType: string; data: string }>
  /**
   * Opens one agent's sidechain transcript. Absent in the sidechain panel
   * itself: a drill-down that drills down is how you get lost.
   */
  onOpenAgent?: (agentId: string) => void
}): React.ReactElement {
  const { entries, toolNames, agentIds } = useMemo(() => {
    const list = order
      .map(id => items.get(id))
      .filter((item): item is WireItem => Boolean(item))
    const toolNames = toolNamesByUseId(list)

    // Pair each result with its tool_use so a card owns its output.
    const resultsByToolUse = new Map<string, WireItem>()
    for (const item of list) {
      if (item.kind === 'tool_result' && item.toolUseId) {
        resultsByToolUse.set(item.toolUseId, item)
      }
    }

    // Build entries, grouping consecutive Agent tool_use items by messageId.
    const entries: RowEntry[] = []
    let i = 0
    while (i < list.length) {
      const item = list[i]!
      if (
        item.kind === 'tool_use' &&
        item.toolName === 'Agent' &&
        item.messageId
      ) {
        // Collect consecutive Agent calls with same messageId
        const groupItems: Array<{
          item: WireItem
          result?: WireItem
        }> = []
        const messageId = item.messageId
        while (
          i < list.length &&
          list[i]!.kind === 'tool_use' &&
          list[i]!.toolName === 'Agent' &&
          list[i]!.messageId === messageId
        ) {
          const cur = list[i]!
          groupItems.push({
            item: cur,
            result: cur.toolUseId
              ? resultsByToolUse.get(cur.toolUseId)
              : undefined,
          })
          i++
        }
        if (groupItems.length > 1) {
          entries.push({
            kind: 'tool_group',
            messageId,
            toolName: 'Agent',
            items: groupItems,
          })
        } else {
          entries.push({
            kind: 'row',
            item: groupItems[0]!.item,
            result: groupItems[0]!.result,
          })
        }
      } else {
        entries.push({
          kind: 'row',
          item,
          result:
            item.kind === 'tool_use' && item.toolUseId
              ? resultsByToolUse.get(item.toolUseId)
              : undefined,
        })
        i++
      }
    }
    return { entries, toolNames, agentIds: agentIdsByToolUse(list) }
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

  async function openImage(item: WireItem): Promise<void> {
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
        {entries.length || activity === 'compacting' ? (
          <>
            {entries.map(entry =>
              entry.kind === 'tool_group' ? (
                <AgentGroup
                  key={`group:${entry.messageId}`}
                  group={entry}
                  inProgressToolUseIds={inProgressToolUseIds}
                  agentIds={agentIds}
                  onOpenAgent={onOpenAgent}
                />
              ) : (
                <Row
                  key={entry.item.id}
                  item={entry.item}
                  result={entry.result}
                  inProgressToolUseIds={inProgressToolUseIds}
                  toolNames={toolNames}
                  agentIds={agentIds}
                  onOpenImage={target => void openImage(target)}
                  onOpenAgent={onOpenAgent}
                />
              ),
            )}
            {/* Queued prompts are edited from the composer's queued list,
                not shown again here. */}
            {activity === 'compacting' ? (
              <div className="row row--system is-info">
                <div className="row__body">Compacting…</div>
              </div>
            ) : null}
          </>
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
