import React from 'react'

import { useExitOnCtrlCDWithKeybindings } from '../hooks/useExitOnCtrlCDWithKeybindings.js'
import { Box, Text } from '../ink.js'
import { useKeybinding } from '../keybindings/useKeybinding.js'
import type { ConcurrentSessionEntry } from '../utils/concurrentSessions.js'
import { Select } from './CustomSelect/index.js'
import { PermissionDialog } from './permissions/PermissionDialog.js'

export type ResumeSessionConflictChoice = 'fork' | 'cancel' | 'takeover'

type Props = {
  sessionId: string
  holders: readonly ConcurrentSessionEntry[]
  onChoice: (choice: ResumeSessionConflictChoice) => void
}

// Locale-independent so the same string appears in tests and in the terminal.
function formatStartedAt(startedAt: number): string {
  const d = new Date(startedAt)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`
}

export function ResumeSessionConflictDialog({
  sessionId,
  holders,
  onChoice,
}: Props): React.ReactNode {
  // Default onExit is useApp().exit() → Ink.unmount(), which tears the tree
  // down without ever calling onChoice. At startup the caller is awaiting a
  // Promise that only onChoice resolves, so the default would hang forever.
  // Cancel is the right reading of Ctrl-C here, and every caller already
  // knows how to handle it.
  const exitState = useExitOnCtrlCDWithKeybindings(() => onChoice('cancel'))

  useKeybinding('confirm:no', () => onChoice('cancel'), {
    context: 'Confirmation',
  })

  return (
    <PermissionDialog
      color="warning"
      titleColor="warning"
      title="Session already open elsewhere"
    >
      <Box flexDirection="column" gap={1} paddingTop={1}>
        <Text bold>{sessionId}</Text>

        <Box flexDirection="column">
          {holders.map(holder => (
            <Text key={holder.pid}>
              PID {holder.pid} · {holder.cwd}
              {holder.name ? ` · ${holder.name}` : ''} · started{' '}
              {formatStartedAt(holder.startedAt)}
            </Text>
          ))}
        </Box>

        <Text>
          Resuming it here would append to the same transcript and share the
          same task list.
        </Text>

        <Select
          options={[
            { label: 'Fork into a new session', value: 'fork' },
            { label: 'Cancel and exit', value: 'cancel' },
            {
              label: 'Resume anyway (both windows share the transcript)',
              value: 'takeover',
            },
          ]}
          onChange={value => onChoice(value as ResumeSessionConflictChoice)}
          onCancel={() => onChoice('cancel')}
        />

        <Text dimColor>
          {exitState.pending ? (
            <>Press {exitState.keyName} again to exit</>
          ) : (
            <>Enter to confirm · Esc to cancel</>
          )}
        </Text>
      </Box>
    </PermissionDialog>
  )
}
