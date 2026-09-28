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
import React, { useMemo } from 'react'
import { Box, Text } from '../../ink.js'
import { Message } from '../../components/Message.js'
import { findToolByName, type Tools } from '../../Tool.js'
import { normalizeMessages } from '../../utils/messages.js'
import type { WireItem } from '../../session/wire.js'
import type { SessionView } from '../../session/viewStore.js'
import { bridgeTranscript, type BridgedTranscript } from './transcriptBridge.js'
import { attachmentGutter, compactDividerText, foldText } from './itemViews.js'
import { attachmentView, progressView } from '../../webui/client/itemViews.js'

type Props = {
  view: SessionView
  tools: Tools
  showInjectedContext: boolean
}

export function AttachedTranscript({
  view,
  tools,
  showInjectedContext,
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
  const bridge = useMemo<BridgedTranscript>(
    () => bridgeTranscript(snapshot, showInjectedContext),
    [snapshot, showInjectedContext],
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

  const body: React.ReactNode[] = []
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
      const rows = normalizeMessages([unit.message as never])
      for (const row of rows) {
        body.push(
          <Box
            key={`${(row as { uuid: string }).uuid}:${(row as { message?: { content?: unknown[] } }).message?.content?.length ?? 0}`}
            paddingX={2}
          >
            <Message
              message={row}
              lookups={bridge.lookups}
              addMargin={false}
              tools={tools}
              commands={[]}
              verbose={false}
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
      continue
    }

    if (unit.kind === 'system') {
      const divider = compactDividerText(unit.item)
      body.push(
        <Box key={unit.item.id} paddingX={2}>
          <Text dimColor>── {divider ?? unit.item.text} ──</Text>
        </Box>,
      )
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
      continue
    }

    // attachment (revealed)
    const view0 = attachmentView(unit.item)
    if (!view0) continue
    body.push(
      <Box key={unit.item.id} paddingX={4}>
        <Text dimColor>
          {attachmentGutter(unit.item.attachment?.type ?? '')} {view0.label}
          {view0.detail ? ` (${view0.detail.slice(0, 100)})` : ''}
        </Text>
      </Box>,
    )
  }

  return <>{body}</>
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
    <Box flexDirection="column" paddingX={4}>
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
