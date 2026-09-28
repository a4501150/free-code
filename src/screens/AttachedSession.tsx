import React, {
  useState,
  useEffect,
  useRef,
  useMemo,
  useCallback,
  useSyncExternalStore,
} from 'react'
import { randomUUID } from 'crypto'
import { Box, Text, useApp, useInput } from '../ink.js'
import ScrollBox, { type ScrollBoxHandle } from '../ink/components/ScrollBox.js'
import { ScrollKeybindingHandler } from '../components/ScrollKeybindingHandler.js'
import { useExitOnCtrlCDWithKeybindings } from '../hooks/useExitOnCtrlCDWithKeybindings.js'
import {
  connectSurfaceClient,
  type SurfaceClient,
  type SurfaceCommandPath,
} from '../webui/gateway/surfaceClient.js'
import type { WireItem, WireRequest, WireSessionMeta } from '../session/wire.js'
import {
  createViewStore,
  type SessionView,
  type ViewStore,
} from '../session/viewStore.js'
import {
  attachmentGutter,
  compactDividerText,
  foldText,
} from './attached/itemViews.js'
import {
  activityLabel,
  draftView,
  formatDuration,
  toolRowView,
  userRowView,
} from './attached/itemViews.js'
import {
  agentIdsByToolUse,
  attachmentView,
  progressView,
  taskView,
  toolNamesByUseId,
} from '../webui/client/itemViews.js'
import {
  queueRows,
  queueEditBody,
  queueRemoveBody,
  rpcBody,
  slashSuggestions,
} from '../webui/client/composerViews.js'
import { AttachedTrays } from './attached/AttachedTrays.js'
import { Select } from '../components/CustomSelect/index.js'
import { KeybindingSetup } from '../keybindings/KeybindingProviderSetup.js'

type ConnectionState =
  | { status: 'connecting' }
  | { status: 'connected'; client: SurfaceClient }
  | { status: 'disconnected'; reason: string }
  | { status: 'error'; message: string }

export type AttachedSessionProps = {
  /** The process whose attach descriptor carries the port and token. */
  pid: number
  /**
   * Attach a session other than the descriptor's primary (a hosted session
   * on a multi-session host). Also shown in the header.
   */
  sessionId?: string
  /** Reach the surface at this origin instead of the descriptor's port. */
  url?: string
  /** Header label; defaults to the PID. */
  label?: string
  /**
   * Submit this prompt once, right after the first connect — the hosted
   * launcher's seam for the CLI's positional initial prompt. Slash
   * commands ride the session's own input processing, as in the REPL.
   */
  initialPrompt?: string
  onExit?: () => void
}

// The transcript projection is the shared view store
// (`src/session/viewStore.ts`) — the same reducer the browser client runs,
// so one projection serves both UIs. `useSyncExternalStore` adapts it to
// this tree; transcript churn re-renders only what subscribes.

function useWireStore(store: ViewStore): SessionView {
  return useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot)
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export function AttachedSession({
  pid,
  sessionId,
  url,
  label,
  initialPrompt,
  onExit,
}: AttachedSessionProps): React.ReactNode {
  const store = useMemo(() => createViewStore(), [])
  const view = useWireStore(store)
  const [connection, setConnection] = useState<ConnectionState>({
    status: 'connecting',
  })
  const clientRef = useRef<SurfaceClient | null>(null)
  const scrollRef = useRef<ScrollBoxHandle>(null)
  const [inputText, setInputText] = useState('')
  const [submitError, setSubmitError] = useState<string | null>(null)
  const historyRef = useRef<string[]>([])
  const historyAtRef = useRef(-1)
  const [editingQueueId, setEditingQueueId] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [runningSince, setRunningSince] = useState<number | null>(null)
  const [, setTick] = useState(0)
  const { exit } = useApp()

  const cancel = useCallback(() => {
    void clientRef.current?.command('cancel', { kind: 'cancel' })
  }, [])

  const doExit = useCallback(() => {
    clientRef.current?.close()
    if (onExit) onExit()
    else exit()
  }, [onExit, exit])

  const exitState = useExitOnCtrlCDWithKeybindings(doExit, () => {
    if (view.meta?.state === 'running' && clientRef.current) {
      cancel()
      return true
    }
    return false
  })

  useEffect(() => {
    let cancelled = false
    let client: SurfaceClient | null = null

    async function connect(): Promise<void> {
      try {
        // connectSurfaceClient reads and verifies the descriptor and the
        // surface delivers a full snapshot as the stream's first event, so
        // there is nothing to send after the handshake resolves.
        client = await connectSurfaceClient(
          pid,
          {
            onEvent(seq, event) {
              store.apply(seq, event)
            },
            onClose(reason) {
              if (!cancelled) {
                clientRef.current = null
                setConnection({ status: 'disconnected', reason })
              }
            },
          },
          { sessionId, url },
        )

        if (cancelled) {
          client.close()
          return
        }

        clientRef.current = client
        setConnection({ status: 'connected', client })
      } catch (err) {
        if (!cancelled) {
          setConnection({
            status: 'error',
            message: err instanceof Error ? err.message : String(err),
          })
        }
      }
    }

    void connect()

    return () => {
      cancelled = true
      client?.close()
      clientRef.current = null
    }
  }, [pid, sessionId, url, store])

  const send = useCallback(
    async (body: Record<string, unknown>): Promise<void> => {
      const client = clientRef.current
      if (!client || !view.meta) return
      const response = await client.command(
        String(body.kind) as SurfaceCommandPath,
        body,
      )
      // A stale epoch comes back as 409 {ok:false} with the reason attached.
      if (!response.ok) {
        setSubmitError(response.error?.message ?? 'Command failed')
        setTimeout(() => setSubmitError(null), 3000)
      }
    },
    [view.meta],
  )

  // One-shot initial prompt (the launcher's `initialPrompt`): fired once
  // the snapshot has landed, so it carries the stream's session epoch and
  // the transcript shows the user row in the right place.
  const initialPromptSentRef = useRef(false)
  useEffect(() => {
    if (
      !initialPrompt ||
      initialPromptSentRef.current ||
      connection.status !== 'connected' ||
      !view.meta
    )
      return
    initialPromptSentRef.current = true
    void send({
      kind: 'prompt',
      content: initialPrompt,
      delivery: 'next',
      commandId: randomUUID(),
      sessionEpoch: view.meta.sessionEpoch ?? 0,
    } as Record<string, unknown>)
  }, [initialPrompt, connection.status, view.meta, send])

  const handleSubmit = useCallback(
    async (text: string) => {
      // /compact and /clear render nothing when the host runs them, so the
      // viewer sends those two as rpc — the same buttons the browser has.
      const word = text.trim().split(/\s/)[0] ?? ''
      if (word === '/compact' || word === '/clear') {
        setEditingQueueId(null)
        await send(
          rpcBody(word === '/compact' ? 'compact' : 'clear') as Record<
            string,
            unknown
          >,
        )
        return
      }
      if (editingQueueId) {
        setEditingQueueId(null)
        await send(
          queueEditBody(editingQueueId, text) as Record<string, unknown>,
        )
        return
      }
      await send({
        kind: 'prompt',
        content: text,
        delivery: 'next',
        commandId: randomUUID(),
        sessionEpoch: view.meta?.sessionEpoch ?? 0,
      } as Record<string, unknown>)
    },
    [send, editingQueueId, view.meta],
  )

  const items = useMemo(
    () =>
      view.order
        .map(id => view.items.get(id))
        .filter((item): item is WireItem => Boolean(item)),
    [view.items, view.order],
  )
  const toolNames = useMemo(() => toolNamesByUseId(items), [items])
  const resultsByToolUse = useMemo(() => {
    const map = new Map<string, WireItem>()
    for (const item of items) {
      if (item.kind === 'tool_result' && item.toolUseId) {
        map.set(item.toolUseId, item)
      }
    }
    return map
  }, [items])
  const agentIds = useMemo(() => agentIdsByToolUse(items), [items])

  const isRunning = view.meta?.state === 'running'
  const isConnected = connection.status === 'connected'
  const pendingRequest = view.requests[0] ?? null
  const composerActive = isConnected && !pendingRequest

  // A running-turn clock for the status line: starts on the transition into
  // running, and a 1s tick keeps the elapsed time and task durations fresh.
  useEffect(() => {
    if (isRunning && runningSince === null) setRunningSince(Date.now())
    if (!isRunning && runningSince !== null) setRunningSince(null)
  }, [isRunning, runningSince])
  useEffect(() => {
    const timer = setInterval(() => setTick(t => t + 1), 1000)
    timer.unref?.()
    return () => clearInterval(timer)
  }, [])

  // The newest host toast (settings errors, rate limits): shown briefly.
  const notification =
    view.notifications.error ??
    view.notifications.warn ??
    view.notifications.info
  const notificationKey = notification?.text
  useEffect(() => {
    if (!notificationKey) return
    setToast(notificationKey)
    const timer = setTimeout(() => setToast(null), 5000)
    return () => clearTimeout(timer)
  }, [notificationKey])

  const paletteToken = inputText.startsWith('/')
    ? inputText.split(/\s/)[0]!
    : ''
  const palette = useMemo(
    () =>
      paletteToken ? slashSuggestions(view.catalog.commands, paletteToken) : [],
    [paletteToken, view.catalog.commands],
  )
  const queued = queueRows(view.queue)

  useInput(
    (input, key) => {
      if (!composerActive) return

      if (key.return) {
        const trimmed = inputText.trim()
        if (key.shift && isRunning && !trimmed) {
          // Steer: an empty Shift+Enter is the browser's interrupt affordance.
          cancel()
          return
        }
        if (trimmed) {
          historyRef.current.push(trimmed)
          if (historyRef.current.length > 50) historyRef.current.shift()
          historyAtRef.current = -1
          void handleSubmit(inputText)
          setInputText('')
        }
        return
      }

      if (key.backspace || key.delete) {
        setInputText(prev => prev.slice(0, -1))
        return
      }

      if (key.escape) {
        if (editingQueueId) {
          setEditingQueueId(null)
          setInputText('')
          return
        }
        if (isRunning) cancel()
        return
      }

      if (key.upArrow || key.downArrow) {
        // History ring, newest first; only while the line is single-line.
        const history = historyRef.current
        if (history.length === 0 || inputText.includes('\n')) return
        let at = historyAtRef.current
        at = key.upArrow
          ? at < 0
            ? history.length - 1
            : Math.max(0, at - 1)
          : at < 0
            ? at
            : Math.min(history.length - 1, at + 1)
        historyAtRef.current = at
        if (at >= 0) setInputText(history[at]!)
        return
      }

      // Queue row hotkeys on the first queued row, composer-empty only:
      // ctrl+x drops it, ctrl+e loads it back for editing (the submit then
      // rides rpc queue_edit). Ctrl so a prompt starting with e/x is never
      // swallowed by a hotkey.
      if (key.ctrl && inputText === '' && queued.length > 0) {
        const row = queued[0]!
        if (input === 'x') {
          void send(queueRemoveBody(row.id) as Record<string, unknown>)
          return
        }
        if (input === 'e') {
          setEditingQueueId(row.id)
          setInputText(row.text)
          return
        }
      }

      if (key.ctrl || key.meta) return
      if (key.leftArrow || key.rightArrow) return
      if (key.pageUp || key.pageDown) return
      if (key.tab) return

      if (input) setInputText(prev => prev + input)
    },
    { isActive: composerActive },
  )

  const draft = isRunning ? draftView(view.streamDraft) : null

  // The screen brings its own keybinding provider: CustomSelect's
  // accept/next/previous (every tray keystroke) rides useKeybindings, which
  // silently no-ops without one — the `App` wrapper does not install it, so
  // joining from main.tsx or the hosted launcher needs it here, not at
  // every call site. Callers that already provide one nest a redundant but
  // harmless instance.
  return (
    <KeybindingSetup>
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        <ScrollBox
          ref={scrollRef}
          flexGrow={1}
          flexDirection="column"
          stickyScroll
        >
          {/* Session header */}
          <Box paddingX={2} paddingY={1}>
            <Text dimColor>
              ── Attached to {label ?? `PID ${pid}`}
              {view.meta ? ` · ${view.meta.cwd}` : ''} ──
            </Text>
          </Box>

          {connection.status === 'connecting' && (
            <Box paddingX={2}>
              <Text dimColor>Connecting to session...</Text>
            </Box>
          )}

          {connection.status === 'error' && (
            <Box paddingX={2}>
              <Text color="error">Connection failed: {connection.message}</Text>
            </Box>
          )}

          {/* Transcript items */}
          {items.map(item => (
            <TranscriptItemRow
              key={`${item.id}:${item.rev}`}
              item={item}
              result={
                item.kind === 'tool_use' && item.toolUseId
                  ? resultsByToolUse.get(item.toolUseId)
                  : undefined
              }
              agentId={
                item.kind === 'tool_use' && item.toolUseId
                  ? agentIds.get(item.toolUseId)
                  : undefined
              }
              inProgress={new Set(view.meta?.inProgressToolUseIds ?? [])}
              toolNames={toolNames}
            />
          ))}

          {/* Streaming preview at the transcript tail */}
          {draft && <StreamDraftRow draft={draft} />}
        </ScrollBox>

        <ScrollKeybindingHandler scrollRef={scrollRef} isActive />

        {/* Disconnected banner */}
        {connection.status === 'disconnected' && (
          <Box flexShrink={0} flexDirection="column" paddingX={2} paddingY={1}>
            <Text color="warning" bold>
              Session engine exited
            </Text>
            <Text dimColor>{connection.reason}</Text>
            <Box marginTop={1}>
              <Select
                options={[{ label: 'Exit', value: 'exit' }]}
                onChange={doExit}
              />
            </Box>
          </Box>
        )}

        {/* Blocking request trays take the keys while anything is pending */}
        {pendingRequest && isConnected && (
          <Box flexShrink={0} paddingX={2} paddingTop={1}>
            <AttachedTrays
              requests={view.requests}
              submit={(requestId, response) => {
                void send({
                  kind: 'request_respond',
                  requestId,
                  response,
                })
              }}
            />
          </Box>
        )}

        {/* Queued prompts, todos, and background tasks */}
        {isConnected &&
          (queued.length > 0 ||
            view.todos.length > 0 ||
            view.tasks.length > 0) && (
            <Box flexShrink={0} flexDirection="column" paddingX={2}>
              {queued.length > 0 && (
                <Box>
                  <Text dimColor>
                    queued:{' '}
                    {queued
                      .map(row => row.text)
                      .join(' · ')
                      .slice(0, 120)}
                    {inputText === '' ? '  (^e edit · ^x drop)' : ''}
                  </Text>
                </Box>
              )}
              {view.todos.length > 0 && (
                <Box>
                  <Text dimColor>
                    todos:{' '}
                    {view.todos
                      .map(
                        todo =>
                          `${todo.status === 'completed' ? '✓' : todo.status === 'in_progress' ? '▶' : '·'} ${todo.content}`,
                      )
                      .slice(0, 4)
                      .join(' · ')
                      .slice(0, 160)}
                  </Text>
                </Box>
              )}
              {view.tasks.length > 0 && (
                <Box>
                  <Text dimColor>
                    tasks:{' '}
                    {view.tasks
                      .map(task => {
                        const view0 = taskView(task, Date.now())
                        return `${view0.marker} ${view0.label}${view0.duration ? ` ${view0.duration}` : ''}`
                      })
                      .slice(0, 4)
                      .join(' · ')
                      .slice(0, 160)}
                  </Text>
                </Box>
              )}
            </Box>
          )}

        {/* Composer */}
        {isConnected && (
          <Box flexShrink={0} flexDirection="column">
            {pendingRequest ? (
              <Box paddingX={2}>
                <Text dimColor>
                  Answer the pending prompt above to continue
                </Text>
              </Box>
            ) : (
              <Box paddingX={2}>
                <Text color="claude">
                  {editingQueueId ? '✎ ' : isRunning ? '⏳ ' : '❯ '}
                </Text>
                <Text>{inputText}</Text>
                <Text inverse> </Text>
              </Box>
            )}
            {editingQueueId && (
              <Box paddingX={2}>
                <Text dimColor>
                  editing a queued command — Enter saves, Esc discards
                </Text>
              </Box>
            )}
            {palette.length > 0 && !editingQueueId && (
              <Box paddingX={2}>
                <Text dimColor>
                  {palette
                    .slice(0, 5)
                    .map(
                      item =>
                        `${item.value}${item.hint ? ` ${item.hint}` : ''}${item.detail ? ` — ${item.detail}` : ''}`,
                    )
                    .join('\n')}
                </Text>
              </Box>
            )}
            {(submitError || toast) && (
              <Box paddingX={2}>
                <Text
                  color={submitError ? 'error' : 'warning'}
                  dimColor={!submitError}
                >
                  {submitError ?? toast}
                </Text>
              </Box>
            )}
            <Box paddingX={2} height={1}>
              <Text dimColor>
                {exitState.pending
                  ? `Press ${exitState.keyName} again to exit`
                  : isRunning
                    ? 'Esc to interrupt · Enter to queue'
                    : 'Enter to send'}
              </Text>
            </Box>
          </Box>
        )}

        {/* Status bar */}
        {isConnected && (
          <AttachedStatusBar
            meta={view.meta}
            runningSince={runningSince}
            hasTray={pendingRequest !== null}
          />
        )}
      </Box>
    </KeybindingSetup>
  )
}

// ---------------------------------------------------------------------------
// Transcript item rendering
// ---------------------------------------------------------------------------

function TranscriptItemRow({
  item,
  result,
  agentId,
  inProgress,
  toolNames,
}: {
  item: WireItem
  result?: WireItem
  agentId?: string
  inProgress: ReadonlySet<string>
  toolNames: Map<string, string>
}): React.ReactNode {
  switch (item.kind) {
    case 'user': {
      const row = userRowView(item)
      if (!row.visible) return null
      return (
        <Box paddingX={2} paddingTop={1}>
          <Text color="claude" bold>
            ❯{' '}
          </Text>
          <Text bold>{row.text}</Text>
          {row.imageLabel ? <Text dimColor> {row.imageLabel}</Text> : null}
        </Box>
      )
    }

    case 'assistant': {
      if (!item.text) return null
      return (
        <Box paddingX={2} paddingTop={1}>
          <Text>{item.text}</Text>
          {item.messageId ? null : null}
        </Box>
      )
    }

    case 'reasoning': {
      if (!item.text) return null
      return (
        <Box paddingX={2}>
          <Text dimColor italic>
            {foldText(item.text, 6).text}
            {foldText(item.text, 6).hidden > 0
              ? `\n… +${foldText(item.text, 6).hidden} lines of thinking`
              : ''}
          </Text>
        </Box>
      )
    }

    case 'tool_use': {
      const row = toolRowView(item, result, inProgress)
      const failed = result?.isError === true
      return (
        <Box flexDirection="column" paddingX={4}>
          <Text dimColor>
            {row.running ? '⚡' : failed ? '✗' : '⚡'}{' '}
            <Text bold>{row.name}</Text>
            {row.summary ? ` ${row.summary}` : ''}
            {agentId ? ` → agent ${agentId.slice(0, 8)}` : ''}
          </Text>
          {result?.text ? <ToolResultFold item={result} /> : null}
        </Box>
      )
    }

    case 'tool_result': {
      // Results under a tool_use render inside that row; an orphan result
      // (its call scrolled out of the wire's window) still prints.
      if (item.toolUseId) return null
      return <ToolResultFold item={item} />
    }

    case 'progress': {
      const progress = progressView(item, toolNames)
      if (!progress) return null
      return (
        <Box paddingX={6}>
          <Text dimColor>
            └ {progress.label}
            {progress.detail ? `: ${progress.detail}` : ''}
          </Text>
        </Box>
      )
    }

    case 'system': {
      if (item.isMeta) return null
      const divider = compactDividerText(item)
      return (
        <Box paddingX={2}>
          <Text dimColor>── {divider ?? item.text} ──</Text>
        </Box>
      )
    }

    case 'attachment': {
      const view0 = attachmentView(item)
      if (!view0) return null
      return (
        <Box paddingX={4}>
          <Text dimColor>
            {attachmentGutter(item.attachment?.type ?? '')} {view0.label}
            {view0.detail ? ` (${view0.detail.slice(0, 100)})` : ''}
          </Text>
        </Box>
      )
    }

    default:
      // Any kind this screen does not render yet.
      return null
  }
}

function ToolResultFold({ item }: { item: WireItem }): React.ReactNode {
  const fold = foldText(item.text, 4)
  if (!fold.text) return null
  return (
    <Box paddingX={6}>
      <Text dimColor color={item.isError ? 'error' : undefined}>
        {item.isError ? '✗ ' : '└ '}
        {fold.text}
        {fold.hidden > 0 ? `\n… +${fold.hidden} more lines` : ''}
      </Text>
    </Box>
  )
}

/**
 * The in-flight preview: what the model is writing NOW, before any of it
 * is a committed transcript row. Cumulative by contract, so this render is
 * a whole take — no stale fragment can survive a frame.
 */
function StreamDraftRow({
  draft,
}: {
  draft: NonNullable<ReturnType<typeof draftView>>
}): React.ReactNode {
  return (
    <Box flexDirection="column" paddingX={2} paddingTop={1}>
      {draft.thinking ? (
        <Box>
          <Text dimColor italic>
            {draft.thinking}
          </Text>
        </Box>
      ) : null}
      {draft.text ? (
        <Box>
          <Text>{draft.text}</Text>
        </Box>
      ) : null}
      {draft.tools.map((tool, at) => (
        <Box key={at}>
          <Text dimColor>
            ⚡ {tool.toolName ?? 'tool'} {tool.partialJson}…
          </Text>
        </Box>
      ))}
    </Box>
  )
}

// ---------------------------------------------------------------------------
// Status bar
// ---------------------------------------------------------------------------

function AttachedStatusBar({
  meta,
  runningSince,
  hasTray,
}: {
  meta: WireSessionMeta | null
  runningSince: number | null
  hasTray: boolean
}): React.ReactNode {
  if (!meta) return null

  const parts: string[] = []
  const activity = hasTray
    ? 'waiting for you'
    : activityLabel(meta.activity, meta.state)
  if (activity) parts.push(activity)
  if (runningSince !== null)
    parts.push(formatDuration(Date.now() - runningSince))
  if (meta.model) parts.push(meta.model)
  if (meta.context) parts.push(`${meta.context.usedPercent}% context`)
  if (meta.costUsd !== undefined) parts.push(`$${meta.costUsd.toFixed(2)}`)

  return (
    <Box
      paddingX={2}
      height={1}
      borderStyle="single"
      borderLeft={false}
      borderRight={false}
      borderBottom={false}
    >
      <Text dimColor>{parts.join(' · ')}</Text>
    </Box>
  )
}
