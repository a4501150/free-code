import React, {
  useState,
  useEffect,
  useRef,
  useMemo,
  useCallback,
} from 'react'
import { randomUUID } from 'crypto'
import { Box, Text, useInput, useApp } from '../ink.js'
import ScrollBox, {
  type ScrollBoxHandle,
} from '../ink/components/ScrollBox.js'
import { ScrollKeybindingHandler } from '../components/ScrollKeybindingHandler.js'
import { useExitOnCtrlCDWithKeybindings } from '../hooks/useExitOnCtrlCDWithKeybindings.js'
import {
  connectAttachClient,
  type AttachClient,
} from '../webui/gateway/attachClient.js'
import { createViewStore, useViewStore } from '../webui/client/store.js'
import type {
  WebPermissionRequest,
  WebSessionMeta,
} from '../webui/protocol/attachSchemas.js'
import type { WebTranscriptItem } from '../webui/protocol/transcriptWire.js'
import { PermissionDialog } from '../components/permissions/PermissionDialog.js'
import { Select } from '../components/CustomSelect/index.js'

type ConnectionState =
  | { status: 'connecting' }
  | { status: 'connected'; client: AttachClient }
  | { status: 'disconnected'; reason: string }
  | { status: 'error'; message: string }

export type AttachedSessionProps = {
  pid: number
  onExit?: () => void
}

export function AttachedSession({
  pid,
  onExit,
}: AttachedSessionProps): React.ReactNode {
  const store = useMemo(() => createViewStore(), [])
  const view = useViewStore(store)
  const [connection, setConnection] = useState<ConnectionState>({
    status: 'connecting',
  })
  const clientRef = useRef<AttachClient | null>(null)
  const scrollRef = useRef<ScrollBoxHandle>(null)
  const [inputText, setInputText] = useState('')
  const [submitError, setSubmitError] = useState<string | null>(null)
  const { exit } = useApp()

  const doExit = useCallback(() => {
    clientRef.current?.close()
    if (onExit) onExit()
    else exit()
  }, [onExit, exit])

  const exitState = useExitOnCtrlCDWithKeybindings(doExit, () => {
    if (view.meta?.state === 'running' && clientRef.current) {
      void clientRef.current.request({ kind: 'interrupt' })
      return true
    }
    return false
  })

  useEffect(() => {
    let cancelled = false
    let client: AttachClient | null = null

    async function connect(): Promise<void> {
      try {
        client = await connectAttachClient(pid, {
          onEvent(seq, event) {
            store.apply(seq, event)
            if (event.kind === 'resync_required') {
              void client?.request({ kind: 'subscribe' })
            }
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
        await client.request({ kind: 'subscribe' })
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

      const response = await client.request({
        kind: 'submit',
        content: text,
        delivery: 'next',
        commandId: randomUUID(),
        sessionEpoch: view.meta.sessionEpoch,
      })
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

      void client.request({
        kind: 'permission_decision',
        requestId,
        decision:
          behavior === 'allow'
            ? { behavior: 'allow' as const }
            : { behavior: 'deny' as const },
      })
    },
    [],
  )

  const items = useMemo(
    () =>
      view.order
        .map(id => view.items.get(id))
        .filter((item): item is WebTranscriptItem => Boolean(item)),
    [view.items, view.order],
  )

  const isRunning = view.meta?.state === 'running'
  const isConnected = connection.status === 'connected'
  const pendingPermission = view.permissions[0] ?? null
  const composerActive = isConnected && !pendingPermission

  useInput(
    (input, key) => {
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
          void clientRef.current?.request({ kind: 'interrupt' })
        }
        return
      }

      if (key.ctrl || key.meta) return
      if (
        key.upArrow ||
        key.downArrow ||
        key.leftArrow ||
        key.rightArrow
      )
        return
      if (key.pageUp || key.pageDown) return
      if (key.tab) return

      if (input) setInputText(prev => prev + input)
    },
  )

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
            <Text color="error">
              Connection failed: {connection.message}
            </Text>
          </Box>
        )}

        {/* Transcript items */}
        {items.map(item => (
          <TranscriptItemRow key={item.id} item={item} />
        ))}

        {/* Permission overlay */}
        {pendingPermission && isConnected && (
          <AttachedPermissionOverlay
            permission={pendingPermission}
            onDecision={handlePermissionDecision}
          />
        )}
      </ScrollBox>

      <ScrollKeybindingHandler scrollRef={scrollRef} isActive />

      {/* Disconnected banner */}
      {connection.status === 'disconnected' && (
        <Box
          flexShrink={0}
          flexDirection="column"
          paddingX={2}
          paddingY={1}
        >
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
              {exitState.pending ? (
                `Press ${exitState.keyName} again to exit`
              ) : isRunning ? (
                'Esc to interrupt · Enter to queue'
              ) : (
                'Enter to send'
              )}
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

function TranscriptItemRow({
  item,
}: {
  item: WebTranscriptItem
}): React.ReactNode {
  switch (item.kind) {
    case 'user': {
      if (item.image) {
        return (
          <Box paddingX={2} paddingTop={1}>
            <Text color="claude" bold>
              ❯{' '}
            </Text>
            <Text dimColor>
              [image {item.image.mediaType}]
            </Text>
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
          <Text dimColor>{item.text ?? 'attachment'}</Text>
        </Box>
      )
  }
}

// ---------------------------------------------------------------------------
// Status bar
// ---------------------------------------------------------------------------

function AttachedStatusBar({
  meta,
}: {
  meta: WebSessionMeta | null
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
// Permission overlay
// ---------------------------------------------------------------------------

function AttachedPermissionOverlay({
  permission,
  onDecision,
}: {
  permission: WebPermissionRequest
  onDecision: (requestId: string, behavior: string) => void
}): React.ReactNode {
  return (
    <PermissionDialog title="Permission Required" color="permission">
      <Box flexDirection="column" gap={1} paddingTop={1}>
        <Text bold>{permission.toolName}</Text>
        <Text>{permission.description}</Text>
        {permission.blockedPath && (
          <Text color="warning">Path: {permission.blockedPath}</Text>
        )}
        <Box maxHeight={8} overflow="hidden">
          <Text dimColor>
            {formatToolInput(permission.input)}
          </Text>
        </Box>
        <Select
          options={[
            { label: 'Allow', value: 'allow' },
            { label: 'Deny', value: 'deny' },
          ]}
          onChange={value =>
            onDecision(permission.requestId, value)
          }
          onCancel={() =>
            onDecision(permission.requestId, 'deny')
          }
        />
      </Box>
    </PermissionDialog>
  )
}
