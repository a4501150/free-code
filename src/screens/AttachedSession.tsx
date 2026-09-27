import React, {
  useState,
  useEffect,
  useRef,
  useMemo,
  useCallback,
  useSyncExternalStore,
} from 'react'
import { randomUUID } from 'crypto'
import { Box, Text, useInput, useApp } from '../ink.js'
import ScrollBox, { type ScrollBoxHandle } from '../ink/components/ScrollBox.js'
import { ScrollKeybindingHandler } from '../components/ScrollKeybindingHandler.js'
import { useExitOnCtrlCDWithKeybindings } from '../hooks/useExitOnCtrlCDWithKeybindings.js'
import {
  connectSurfaceClient,
  type SurfaceClient,
} from '../webui/gateway/surfaceClient.js'
import type {
  WireEvent,
  WireItem,
  WireRequest,
  WireSessionMeta,
  WireTranscriptPatch,
} from '../session/wire.js'
import { PermissionDialog } from '../components/permissions/PermissionDialog.js'
import { Select } from '../components/CustomSelect/index.js'

type ConnectionState =
  | { status: 'connecting' }
  | { status: 'connected'; client: SurfaceClient }
  | { status: 'disconnected'; reason: string }
  | { status: 'error'; message: string }

export type AttachedSessionProps = {
  pid: number
  onExit?: () => void
}

// ---------------------------------------------------------------------------
// Joined-session view state
//
// Self-contained on purpose: the browser store (`src/webui/client/store.ts`)
// is ported on its own schedule and this screen must not race its edits.
// ---------------------------------------------------------------------------

type SessionView = {
  meta: WireSessionMeta | null
  items: Map<string, WireItem>
  order: string[]
  requests: WireRequest[]
  lastSeq: number
}

function emptyView(): SessionView {
  return {
    meta: null,
    items: new Map(),
    order: [],
    requests: [],
    lastSeq: 0,
  }
}

/**
 * Applies one wire event.
 *
 * Every operation is idempotent by sequence, item id and revision, so a replay
 * after a reconnect cannot duplicate or reorder anything. The snapshot is the
 * exception to the seq gate: it carries the journal watermark rather than a
 * new seq, and it always rebuilds the view wholesale.
 */
function applyEvent(
  view: SessionView,
  seq: number,
  event: WireEvent,
): SessionView {
  if (seq <= view.lastSeq && event.kind !== 'snapshot') return view
  const next: SessionView = { ...view, lastSeq: Math.max(view.lastSeq, seq) }

  switch (event.kind) {
    case 'snapshot': {
      next.meta = event.meta
      next.items = new Map(event.transcript.items.map(item => [item.id, item]))
      next.order = [...event.transcript.order]
      next.requests = event.requests
      next.lastSeq = seq
      return next
    }

    case 'transcript': {
      return applyPatch(view, next, event.patch)
    }

    case 'meta':
      next.meta = event.meta
      return next

    case 'request_opened':
      next.requests = [
        ...view.requests.filter(r => r.requestId !== event.request.requestId),
        event.request,
      ]
      return next

    case 'request_closed':
      next.requests = view.requests.filter(r => r.requestId !== event.requestId)
      return next

    case 'session_changed':
      // The process moved to another session. Everything below is stale; the
      // replace patch the surface publishes after this event rebuilds the
      // transcript under the new identity.
      next.items = new Map()
      next.order = []
      next.requests = []
      if (next.meta) {
        next.meta = {
          ...next.meta,
          sessionId: event.sessionId,
          sessionEpoch: event.sessionEpoch,
        }
      }
      return next

    case 'todos':
    case 'queue':
    case 'tasks':
    case 'catalog':
      // This screen does not render them yet; the seq bump above still counts.
      return next

    case 'resync_required':
      // The server follows it with a fresh snapshot on this same stream.
      return next

    default:
      // Additive kinds within a release are forward-safe: ignore, never fail.
      return next
  }
}

function applyPatch(
  view: SessionView,
  next: SessionView,
  patch: WireTranscriptPatch,
): SessionView {
  if (patch.type === 'replace') {
    next.items = new Map(patch.snapshot.items.map(i => [i.id, i]))
    next.order = [...patch.snapshot.order]
    return next
  }
  const items = new Map(view.items)
  for (const id of patch.remove) items.delete(id)
  for (const item of patch.upsert) items.set(item.id, item)
  next.items = items
  if (patch.order) next.order = [...patch.order]
  else if (patch.orderAppend) next.order = [...view.order, ...patch.orderAppend]
  return next
}

/** A tiny external store, so transcript churn does not re-render the shell. */
function createWireStore() {
  let view = emptyView()
  const listeners = new Set<() => void>()

  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    snapshot(): SessionView {
      return view
    },
    apply(seq: number, event: WireEvent): void {
      const next = applyEvent(view, seq, event)
      if (next === view) return
      view = next
      for (const listener of listeners) listener()
    },
  }
}

type WireStore = ReturnType<typeof createWireStore>

function useWireStore(store: WireStore): SessionView {
  return useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot)
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export function AttachedSession({
  pid,
  onExit,
}: AttachedSessionProps): React.ReactNode {
  const store = useMemo(() => createWireStore(), [])
  const view = useWireStore(store)
  const [connection, setConnection] = useState<ConnectionState>({
    status: 'connecting',
  })
  const clientRef = useRef<SurfaceClient | null>(null)
  const scrollRef = useRef<ScrollBoxHandle>(null)
  const [inputText, setInputText] = useState('')
  const [submitError, setSubmitError] = useState<string | null>(null)
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
        client = await connectSurfaceClient(pid, {
          onEvent(seq, event) {
            store.apply(seq, event)
          },
          onClose(reason) {
            if (!cancelled) {
              clientRef.current = null
              setConnection({ status: 'disconnected', reason })
            }
          },
        })

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
  }, [pid, store])

  const handleSubmit = useCallback(
    async (text: string) => {
      const client = clientRef.current
      if (!client || !view.meta) return

      const response = await client.command('prompt', {
        kind: 'prompt',
        content: text,
        delivery: 'next',
        commandId: randomUUID(),
        sessionEpoch: view.meta.sessionEpoch,
      })
      // A stale epoch comes back as 409 {ok:false} with the reason attached.
      if (!response.ok) {
        setSubmitError(response.error?.message ?? 'Submission failed')
        setTimeout(() => setSubmitError(null), 3000)
      }
    },
    [view.meta],
  )

  const handlePermissionDecision = useCallback(
    (requestId: string, behavior: string) => {
      const client = clientRef.current
      if (!client) return

      void client.command('request_respond', {
        kind: 'request_respond',
        requestId,
        response: {
          kind: 'permission',
          decision:
            behavior === 'allow'
              ? ({ behavior: 'allow' } as const)
              : ({ behavior: 'deny' } as const),
        },
      })
    },
    [],
  )

  const items = useMemo(
    () =>
      view.order
        .map(id => view.items.get(id))
        .filter((item): item is WireItem => Boolean(item)),
    [view.items, view.order],
  )

  const isRunning = view.meta?.state === 'running'
  const isConnected = connection.status === 'connected'
  const pendingRequest = view.requests[0] ?? null
  const composerActive = isConnected && !pendingRequest

  useInput((input, key) => {
    if (!composerActive) return

    if (key.return) {
      const trimmed = inputText.trim()
      if (trimmed) {
        void handleSubmit(trimmed)
        setInputText('')
      }
      return
    }

    if (key.backspace || key.delete) {
      setInputText(prev => prev.slice(0, -1))
      return
    }

    if (key.escape) {
      if (isRunning) {
        cancel()
      }
      return
    }

    if (key.ctrl || key.meta) return
    if (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) return
    if (key.pageUp || key.pageDown) return
    if (key.tab) return

    if (input) setInputText(prev => prev + input)
  })

  return (
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
            ── Attached to PID {pid}
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
          <TranscriptItemRow key={item.id} item={item} />
        ))}

        {/* Permission overlay */}
        {pendingRequest && isConnected && (
          <AttachedRequestOverlay
            request={pendingRequest}
            onDecision={handlePermissionDecision}
          />
        )}
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

      {/* Status bar and composer */}
      {isConnected && (
        <Box flexShrink={0} flexDirection="column">
          <AttachedStatusBar meta={view.meta} />
          <Box paddingX={2}>
            <Text color="claude">{isRunning ? '⏳ ' : '❯ '}</Text>
            <Text>{inputText}</Text>
            <Text inverse> </Text>
          </Box>
          {submitError && (
            <Box paddingX={2}>
              <Text color="error">{submitError}</Text>
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
    </Box>
  )
}

// ---------------------------------------------------------------------------
// Transcript item rendering
// ---------------------------------------------------------------------------

const MAX_DISPLAY_LINES = 20

function truncateText(text: string | undefined): string {
  if (!text) return ''
  const lines = text.split('\n')
  if (lines.length <= MAX_DISPLAY_LINES) return text
  return lines.slice(0, MAX_DISPLAY_LINES).join('\n') + '\n… truncated'
}

function formatToolInput(input: unknown): string {
  if (!input) return ''
  try {
    const json = JSON.stringify(input)
    return json.length > 120 ? json.slice(0, 120) + '…' : json
  } catch {
    return ''
  }
}

function TranscriptItemRow({ item }: { item: WireItem }): React.ReactNode {
  switch (item.kind) {
    case 'user': {
      if (item.image) {
        // Bytes stay on the surface; this screen shows metadata only.
        return (
          <Box paddingX={2} paddingTop={1}>
            <Text color="claude" bold>
              ❯{' '}
            </Text>
            <Text dimColor>[image {item.image.mediaType}]</Text>
          </Box>
        )
      }
      return (
        <Box paddingX={2} paddingTop={1}>
          <Text color="claude" bold>
            ❯{' '}
          </Text>
          <Text bold>{truncateText(item.text)}</Text>
        </Box>
      )
    }

    case 'assistant':
      return (
        <Box paddingX={2} paddingTop={1}>
          <Text>{truncateText(item.text)}</Text>
        </Box>
      )

    case 'reasoning':
      if (!item.text) return null
      return (
        <Box paddingX={2}>
          <Text dimColor italic>
            {truncateText(item.text)}
          </Text>
        </Box>
      )

    case 'tool_use':
      return (
        <Box paddingX={4}>
          <Text dimColor>
            ⚡ {item.toolName}
            {item.toolInput ? ` ${formatToolInput(item.toolInput)}` : ''}
          </Text>
        </Box>
      )

    case 'tool_result': {
      const text = truncateText(item.text)
      if (!text) return null
      return (
        <Box paddingX={4}>
          <Text dimColor color={item.isError ? 'error' : undefined}>
            {item.isError ? '✗ ' : ''}
            {text}
          </Text>
        </Box>
      )
    }

    case 'system':
      if (item.isMeta) return null
      return (
        <Box paddingX={2}>
          <Text dimColor>── {item.text} ──</Text>
        </Box>
      )

    case 'attachment':
      return (
        <Box paddingX={4}>
          <Text dimColor>
            {item.attachment?.display ?? item.text ?? 'attachment'}
          </Text>
        </Box>
      )

    default:
      // progress and any kind this screen does not render yet.
      return null
  }
}

// ---------------------------------------------------------------------------
// Status bar
// ---------------------------------------------------------------------------

function AttachedStatusBar({
  meta,
}: {
  meta: WireSessionMeta | null
}): React.ReactNode {
  if (!meta) return null

  const parts: string[] = []
  if (meta.model) parts.push(meta.model)
  parts.push(meta.activity ?? meta.state)
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

// ---------------------------------------------------------------------------
// Request overlay
// ---------------------------------------------------------------------------

function AttachedRequestOverlay({
  request,
  onDecision,
}: {
  request: WireRequest
  onDecision: (requestId: string, behavior: string) => void
}): React.ReactNode {
  if (request.kind !== 'permission') {
    // hook_prompt and elicitation block the session too; this screen has no
    // rich UI for them yet, so it only says one is waiting.
    return (
      <Box paddingX={2} paddingTop={1}>
        <Text dimColor>
          {request.kind === 'hook_prompt'
            ? 'A hook prompt is pending'
            : 'A server elicitation is pending'}{' '}
          — answer it in the host session
        </Text>
      </Box>
    )
  }

  return (
    <PermissionDialog title="Permission Required" color="permission">
      <Box flexDirection="column" gap={1} paddingTop={1}>
        <Text bold>{request.toolName}</Text>
        <Text>{request.description}</Text>
        {request.blockedPath && (
          <Text color="warning">Path: {request.blockedPath}</Text>
        )}
        <Box maxHeight={8} overflow="hidden">
          <Text dimColor>{formatToolInput(request.input)}</Text>
        </Box>
        <Select
          options={[
            { label: 'Allow', value: 'allow' },
            { label: 'Deny', value: 'deny' },
          ]}
          onChange={value => onDecision(request.requestId, value)}
          onCancel={() => onDecision(request.requestId, 'deny')}
        />
      </Box>
    </PermissionDialog>
  )
}
