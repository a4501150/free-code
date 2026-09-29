/**
 * The attached-session transcript, rendered through the classic REPL's own
 * message components.
 *
 * `transcriptBridge` rebuilds Message-shaped inputs from the flat wire
 * items; this feeds each one to `<Message>` — the very dispatcher the
 * REPL's list uses — so markdown, tool cards, thinking rows and user
 * prompts look identical, not retyped. Rows whose tool is not in this
 * process's tool registry (MCP tools on a remote attach, a tool added
 * after the host's build) fall back to the viewer-native one-line row, so
 * nothing disappears when a card can't be built.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Box, Text, type ClickEvent } from '../../ink.js'
import { Message } from '../../components/Message.js'
import { findToolByName, type Tools } from '../../Tool.js'
import {
  createUserMessage,
  isInjectedContextText,
  normalizeMessages,
} from '../../utils/messages.js'
import { getUserContext } from '../../context.js'
import { formatUserContextMessageContent } from '../../utils/contextInjection.js'
import { USER_CONTEXT_ROW_UUID } from '../../constants/messages.js'
import type { UUID } from 'crypto'
import type { WireItem } from '../../session/wire.js'
import type { SessionView } from '../../session/viewStore.js'
import { bridgeTranscript, type BridgedTranscript } from './transcriptBridge.js'
import { attachmentGutter, compactDividerText, foldText } from './itemViews.js'
import { attachmentView, progressView } from '../../webui/client/itemViews.js'
import { InjectedContextMessage } from '../../components/messages/InjectedContextMessage.js'
import { UserTextMessage } from '../../components/messages/UserTextMessage.js'
import { InVirtualListContext } from '../../components/messageActions.js'

type Props = {
  view: SessionView
  tools: Tools
  showInjectedContext: boolean
  /**
   * Render the classic's rebuilt `Session context (n lines)` row — the
   * virtual first row the REPL's Messages list reconstructs from
   * getUserContext() to stand in for the user-context attachments. Only the
   * hosting terminal (and any viewer whose cwd is the session's cwd) can
   * rebuild it honestly, so the launcher opts in.
   */
  showSessionContextRow?: boolean
}

export function AttachedTranscript({
  view,
  tools,
  showInjectedContext,
  showSessionContextRow,
}: Props): React.ReactNode {
  const snapshot = useMemo(
    () => ({
      items: view.order
        .map(id => view.items.get(id))
        .filter((item): item is WireItem => Boolean(item)),
      order: view.order,
    }),
    [view.items, view.order],
  )
  // The in-flight tool partials, keyed stably by block position so the
  // streaming cards' React keys never churn while the JSON trickles in.
  const draftTools = useMemo(
    () => (view.streamDraft?.tools ?? []).map(tool => ({ ...tool })),
    [view.streamDraft],
  )
  const bridge = useMemo<BridgedTranscript>(
    () => bridgeTranscript(snapshot, showInjectedContext, tools, draftTools),
    [snapshot, showInjectedContext, tools, draftTools],
  )

  // The classic pane's virtual first row: the user-context block is built
  // per-request and never stored, so the REPL reconstructs it for display
  // from getUserContext() — same bytes, same `Session context (n lines)`
  // collapsed row. Rebuilt here the same way, in this process's cwd.
  const [userContextText, setUserContextText] = useState<string | null>(null)
  useEffect(() => {
    if (!showSessionContextRow || !showInjectedContext) return
    let cancelled = false
    void getUserContext().then(context => {
      if (!cancelled) {
        setUserContextText(formatUserContextMessageContent(context))
      }
    })
    return () => {
      cancelled = true
    }
  }, [showSessionContextRow, showInjectedContext, view.meta?.sessionId])

  // Classic's per-row click-to-expand (the Messages.tsx expandedKeys fold):
  // rows render collapsed and a click on a clickable row toggles its own
  // verbose rendering. Visibility of injected rows is the separate
  // showInjectedContext switch — conflating the two expanded every row at
  // startup while leaving nothing clickable, the opposite of the classic pane.
  const [expandedKeys, setExpandedKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  )
  const toggleExpanded = useCallback((key: string): void => {
    setExpandedKeys(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])
  // The row-level click handler, gated like VirtualMessageList: a click that
  // lands on a blank cell is ignored, so only the row's own text toggles it.
  const rowClickHandler = useCallback(
    (key: string) =>
      (event: ClickEvent): void => {
        if (!event.cellIsBlank) toggleExpanded(key)
      },
    [toggleExpanded],
  )

  // For the fallback rows: which tool card each tool_use/tool_result would
  // have become, and whether this process can build it.
  const callNames = useMemo(() => {
    const map = new Map<string, string>()
    for (const item of snapshot.items) {
      if (item.kind === 'tool_use' && item.toolUseId) {
        map.set(item.toolUseId, item.toolName ?? 'tool')
      }
    }
    return map
  }, [snapshot.items])
  const inProgress = useMemo(
    () => new Set(view.meta?.inProgressToolUseIds ?? []),
    [view.meta],
  )
  const toolNamesByUseId = useMemo(() => {
    const map = new Map<string, string>()
    for (const item of snapshot.items) {
      if (item.kind === 'tool_use' && item.toolUseId) {
        map.set(item.toolUseId, item.toolName ?? 'tool')
      }
    }
    return map
  }, [snapshot.items])

  const itemById = useMemo(() => {
    const map = new Map<string, WireItem>()
    for (const item of snapshot.items) map.set(item.id, item)
    return map
  }, [snapshot.items])

  // The classic prompt-screen margin rule (MessageRow): every rendered row
  // carries its own top margin, except an injected-context row whose
  // previous rendered row is also injected context (a run shares one gap),
  // and tool_result rows, which hang under their tool card with no gap.
  const body: React.ReactNode[] = []
  let prevRenderedInjected = false
  for (const unit of bridge.units) {
    if (unit.kind === 'message') {
      const blocks = Array.isArray(unit.message.message.content)
        ? unit.message.message.content
        : []
      const unknownCall = blocks.find(
        block =>
          block.type === 'tool_use' && !findToolByName(tools, block.name),
      ) as { type: 'tool_use'; id: string; name: string } | undefined
      if (unknownCall) {
        // The dispatcher would log-and-null this row; show the viewer row
        // for the whole unit instead so the call and its result stay put.
        for (const itemId of unit.itemIds) {
          const item = itemById.get(itemId)
          if (item) {
            body.push(
              <FallbackToolUnitRow
                key={`${item.id}:${item.rev}`}
                item={item}
                itemById={itemById}
                callNames={callNames}
                inProgress={inProgress}
              />,
            )
          }
        }
        prevRenderedInjected = false
        continue
      }
      // A tool_result whose call it stands for is unresolvable here: its
      // card renders nothing, so keep the viewer's fold instead. The
      // lookup check mirrors what UserToolResultMessage does.
      const orphanResult = blocks.find(
        block =>
          block.type === 'tool_result' &&
          !bridge.lookups.toolUseByToolUseID.get(block.tool_use_id),
      ) as { type: 'tool_result'; tool_use_id: string } | undefined
      if (orphanResult) {
        const item = itemById.get(unit.itemIds[0]!)
        if (item) {
          body.push(
            <Box key={`${item.id}:${item.rev}`} paddingX={2}>
              <ToolResultFold item={item} />
            </Box>,
          )
        }
        continue
      }
      // The pipeline's rows for this unit — grouped/collapsed exactly as
      // the classic pane folds them. Absorbed units have none; a unit
      // rendered before any pipeline ran (no tools) falls back to its own
      // normalized message.
      const rows = unit.rows ?? normalizeMessages([unit.message as never])
      for (const row of rows) {
        const rowBlock = (
          row as {
            message?: {
              content: Array<{
                type: string
                id?: string
                tool_use_id?: string
                text?: string
              }>
            }
          }
        ).message?.content?.[0]
        const isFold =
          row.type === 'collapsed_read_search' ||
          row.type === 'grouped_tool_use'
        // Mirrors Messages.expandKey: a tool card and the result riding
        // under it share the tool_use_id so they expand together; a
        // collapsed group keys on its uuid; every other row keys on its
        // uuid.
        const rowKey =
          (rowBlock?.type === 'tool_use'
            ? rowBlock.id
            : rowBlock?.type === 'tool_result'
              ? rowBlock.tool_use_id
              : undefined) ?? (row as { uuid: string }).uuid
        // The classic pane's isItemClickable set, as far as these rows
        // reach: a collapsed read/search/bash group is always clickable
        // (it exists to be opened), injected-context rows while the
        // setting shows them, and thinking rows with a body.
        const clickable =
          isFold ||
          (showInjectedContext &&
            (rowBlock?.type === 'text'
              ? isInjectedContextText(row as never)
              : rowBlock?.type === 'reasoning' && Boolean(rowBlock.text)))
        body.push(
          <Box
            key={`${(row as { uuid: string }).uuid}:${(row as { message?: { content?: unknown[] } }).message?.content?.length ?? 0}`}
            onClick={clickable ? rowClickHandler(rowKey) : undefined}
          >
            <Message
              message={row}
              lookups={bridge.lookups}
              showInjectedContext={showInjectedContext}
              // Classic dispatch: a tool_result rides under its card with
              // no gap; every other row carries its own top margin.
              addMargin={
                !(
                  Array.isArray(
                    (row as { message?: { content?: unknown } }).message
                      ?.content,
                  ) &&
                  (
                    (row as { message: { content: Array<{ type: string }> } })
                      .message.content[0] as { type: string } | undefined
                  )?.type === 'tool_result'
                )
              }
              tools={tools}
              commands={[]}
              // Per-row expansion, like the classic's expandedKeys fold:
              // rows start collapsed and a click reveals this row's body —
              // the default pane stays byte-identical to the classic.
              verbose={expandedKeys.has(rowKey)}
              inProgressToolUseIDs={inProgress}
              progressMessagesForMessage={[]}
              shouldAnimate={false}
              shouldShowDot={true}
              isTranscriptMode={false}
              isStatic={false}
              width="100%"
            />
          </Box>,
        )
      }
      prevRenderedInjected = false
      continue
    }

    if (unit.kind === 'system') {
      // Command output rides the wire as a system/local_command row whose
      // text is the synthetic `<local-command-stdout>` message. The classic
      // dispatcher (Message.tsx) renders exactly this subtype through
      // UserTextMessage — the `⎿` output block; mount the same component
      // with the same dispatch, not the divider row the compact seam gets.
      if (unit.item.subtype === 'local_command') {
        body.push(
          <Box key={unit.item.id}>
            <UserTextMessage
              addMargin={false}
              param={{ type: 'text', text: unit.item.text ?? '' }}
              verbose={false}
              isTranscriptMode={false}
              showInjectedContext={showInjectedContext}
            />
          </Box>,
        )
        prevRenderedInjected = false
        continue
      }
      const divider = compactDividerText(unit.item)
      body.push(
        <Box key={unit.item.id} marginTop={1}>
          <Text dimColor>── {divider ?? unit.item.text} ──</Text>
        </Box>,
      )
      prevRenderedInjected = false
      continue
    }

    if (unit.kind === 'progress') {
      const progress = progressView(unit.item, toolNamesByUseId)
      if (!progress) continue
      body.push(
        <Box key={unit.item.id} paddingX={6}>
          <Text dimColor>
            └ {progress.label}
            {progress.detail ? `: ${progress.detail}` : ''}
          </Text>
        </Box>,
      )
      prevRenderedInjected = false
      continue
    }

    // attachment
    if (unit.injected) {
      // The classic collapsed row: `▸ System reminder · type (n lines)`,
      // expanded on click like the classic's reminder disclosures. The
      // reminder body rides the wire for exactly this; without one (host
      // older than the field, or a type that injects no reminder) the type
      // name alone still matches what the classic pane would say for an
      // empty body. These rows are always clickable while shown — they
      // carry a reminder, the classic's own click gate for attachments.
      const reminder = unit.item.attachment?.reminder ?? ''
      const attKey = `att:${unit.item.id}`
      body.push(
        <Box
          key={unit.item.id}
          flexDirection="column"
          onClick={rowClickHandler(attKey)}
        >
          <InjectedContextMessage
            addMargin={!prevRenderedInjected}
            label={`System reminder · ${unit.item.attachment?.type ?? 'context'}`}
            content={reminder}
            verbose={expandedKeys.has(attKey)}
          />
        </Box>,
      )
      prevRenderedInjected = true
      continue
    }
    const view0 = attachmentView(unit.item)
    if (!view0) continue
    body.push(
      <Box key={unit.item.id} marginTop={1} paddingX={2}>
        <Text dimColor>
          {attachmentGutter(unit.item.attachment?.type ?? '')} {view0.label}
          {view0.detail ? ` (${view0.detail.slice(0, 100)})` : ''}
        </Text>
      </Box>,
    )
    prevRenderedInjected = false
  }

  // The streaming tool cards, hung at the transcript's tail — the
  // viewer's twin of the REPL's synthetic streaming tool-use messages.
  // The partial JSON has already been mined for complete fields, so the
  // card shows what has landed and grows as the block closes.
  for (const row of bridge.draftRows) {
    body.push(
      <Box
        key={String(row.uuid)}
        onClick={
          row.type === 'collapsed_read_search' ||
          row.type === 'grouped_tool_use'
            ? rowClickHandler(String(row.uuid))
            : undefined
        }
      >
        <Message
          message={row as never}
          lookups={bridge.lookups}
          showInjectedContext={showInjectedContext}
          addMargin
          tools={tools}
          commands={[]}
          verbose={expandedKeys.has(String(row.uuid))}
          inProgressToolUseIDs={inProgress}
          progressMessagesForMessage={[]}
          shouldAnimate={false}
          shouldShowDot={true}
          isTranscriptMode={false}
          isStatic={false}
          width="100%"
        />
      </Box>,
    )
  }

  // The reconstructed `Session context` row leads the list, as the
  // classic's displayCollapsed prepends it before every other row.
  const sessionContextRow = useMemo(() => {
    if (!showSessionContextRow || !showInjectedContext || !userContextText) {
      return null
    }
    const msg = createUserMessage({ content: userContextText, isMeta: true })
    msg.uuid = USER_CONTEXT_ROW_UUID as UUID
    const row = normalizeMessages([msg as never])[0]
    if (!row) return null
    return (
      <Box
        key="session-context-row"
        flexDirection="column"
        onClick={rowClickHandler(`ctx:${USER_CONTEXT_ROW_UUID}`)}
      >
        <Message
          message={row as never}
          lookups={bridge.lookups}
          // Without this the meta context row renders NOTHING (the prop
          // defaults false and UserTextMessage hides meta reminders),
          // which is how the `Session context` row silently disappeared.
          showInjectedContext={showInjectedContext}
          addMargin
          tools={tools}
          commands={[]}
          // Collapsed until clicked — the classic's own behaviour for the
          // rebuilt context row.
          verbose={expandedKeys.has(`ctx:${USER_CONTEXT_ROW_UUID}`)}
          inProgressToolUseIDs={new Set<string>()}
          progressMessagesForMessage={[]}
          shouldAnimate={false}
          shouldShowDot={true}
          isTranscriptMode={false}
          isStatic={false}
          width="100%"
        />
      </Box>
    )
  }, [
    showSessionContextRow,
    showInjectedContext,
    userContextText,
    expandedKeys,
    bridge.lookups,
    tools,
    rowClickHandler,
  ])

  // The classic pane renders its rows inside the virtual message list,
  // which is what keeps the thinking/tool rows from printing a per-row
  // `(ctrl+o to expand)` hint (the reminder rows carry their own). The
  // viewer's ScrollBox is the same no-terminal-scrollback situation, so
  // it claims the context to get the same look.
  return (
    <InVirtualListContext.Provider value={true}>
      {sessionContextRow}
      {body}
    </InVirtualListContext.Provider>
  )
}

function ToolResultFold({ item }: { item: WireItem }): React.ReactNode {
  const fold = foldText(item.text, 4)
  if (!fold.text) return null
  return (
    <Text dimColor color={item.isError ? 'error' : undefined}>
      {item.isError ? '✗ ' : '└ '}
      {fold.text}
      {fold.hidden > 0 ? `\n… +${fold.hidden} more lines` : ''}
    </Text>
  )
}

/**
 * The pre-bridge look for a tool this process cannot render a card for:
 * one dimmed line per call, plus the result fold. Mirrors what the viewer
 * showed before real cards existed.
 */
function FallbackToolUnitRow({
  item,
  itemById,
  callNames,
  inProgress,
}: {
  item: WireItem
  itemById: Map<string, WireItem>
  callNames: Map<string, string>
  inProgress: ReadonlySet<string>
}): React.ReactNode {
  if (item.kind === 'tool_result') {
    return (
      <Box paddingX={4}>
        <ToolResultFold item={item} />
      </Box>
    )
  }
  if (item.kind !== 'tool_use') return null
  const result = item.toolUseId
    ? findResult(item.toolUseId, itemById)
    : undefined
  const failed = result?.isError === true
  return (
    <Box flexDirection="column" marginTop={1} paddingX={4}>
      <Text dimColor>
        {failed ? '✗ ' : '⚡ '}
        <Text bold>
          {item.toolName ?? callNames.get(item.toolUseId ?? '') ?? 'tool'}
        </Text>
      </Text>
      {result?.text ? (
        <Box paddingX={6}>
          <ToolResultFold item={result} />
        </Box>
      ) : null}
    </Box>
  )
}

function findResult(
  toolUseId: string,
  itemById: Map<string, WireItem>,
): WireItem | undefined {
  for (const item of itemById.values()) {
    if (item.kind === 'tool_result' && item.toolUseId === toolUseId) {
      return item
    }
  }
  return undefined
}
