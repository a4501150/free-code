import React, {
  Suspense,
  use,
  useDeferredValue,
  useEffect,
  useRef,
  useState,
} from 'react'
import type { DeepImmutable } from 'src/types/utils.js'
import type { CommandResultDisplay } from '../../commands.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import type { KeyboardEvent } from '../../ink/events/keyboard-event.js'
import ScrollBox, {
  type ScrollBoxHandle,
} from '../../ink/components/ScrollBox.js'
import { Box, Text, useInput } from '../../ink.js'
import { useKeybindings } from '../../keybindings/useKeybinding.js'
import type { LocalShellTaskState } from '../../tasks/LocalShellTask/guards.js'
import {
  formatDuration,
  formatFileSize,
  truncateToWidth,
} from '../../utils/format.js'
import { tailFile } from '../../utils/fsOperations.js'
import { getTaskOutputPath } from '../../utils/task/diskOutput.js'
import { Byline } from '../design-system/Byline.js'
import { Dialog } from '../design-system/Dialog.js'
import { KeyboardShortcutHint } from '../design-system/KeyboardShortcutHint.js'
import {
  applyModalPagerAction,
  modalPagerAction,
} from '../ScrollKeybindingHandler.js'

type Props = {
  shell: DeepImmutable<LocalShellTaskState>
  onDone: (
    result?: string,
    options?: { display?: CommandResultDisplay },
  ) => void
  onKillShell?: () => void
  onBack?: () => void
}

// Cap how much of the output file we pull into memory for the dialog. 1MB
// covers virtually every interactive shell log; truly huge logs still get
// truncated by tailFile/getTaskOutput with a "[NKB of earlier output
// omitted]" prefix. Users wanting the full log can Read the output file
// directly (path is documented in the BackgroundTaskOutput tool description).
const SHELL_DETAIL_TAIL_BYTES = 1_048_576

const OUTPUT_VIEWPORT_HEIGHT = 20

type TaskOutputResult = {
  content: string
  bytesTotal: number
}

/**
 * Read the tail of the task output file. Only reads the last few KB,
 * not the entire file.
 */
async function getTaskOutput(
  shell: DeepImmutable<LocalShellTaskState>,
): Promise<TaskOutputResult> {
  const path = getTaskOutputPath(shell.id)
  try {
    const result = await tailFile(path, SHELL_DETAIL_TAIL_BYTES)
    return { content: result.content, bytesTotal: result.bytesTotal }
  } catch {
    return { content: '', bytesTotal: 0 }
  }
}

export function ShellDetailDialog({
  shell,
  onDone,
  onKillShell,
  onBack,
}: Props): React.ReactNode {
  const { columns } = useTerminalSize()

  // Promise created in initializer (not during render). For running shells,
  // the effect timer replaces it periodically to pick up new output.
  // useDeferredValue keeps showing the previous output while the new promise
  // resolves, preventing the Suspense fallback from flickering.
  const [outputPromise, setOutputPromise] = useState<Promise<TaskOutputResult>>(
    () => getTaskOutput(shell),
  )
  const deferredOutputPromise = useDeferredValue(outputPromise)

  useEffect(() => {
    if (shell.status !== 'running') {
      return
    }
    const timer = setInterval(
      (setOutputPromise, shell) => setOutputPromise(getTaskOutput(shell)),
      1000,
      setOutputPromise,
      shell,
    )
    return () => clearInterval(timer)
  }, [shell.id, shell.status])

  // Imperative scroll handle for keyboard navigation in the output ScrollBox.
  const scrollRef = useRef<ScrollBoxHandle | null>(null)

  // Drive the bare j/k/g/G/etc. pager bindings against the ScrollBox.
  // useInput is naturally scoped to the lifetime of this mounted dialog, so
  // it only fires while the detail view is visible.
  useInput((input, key, event) => {
    const s = scrollRef.current
    if (!s) return
    const sticky = applyModalPagerAction(
      s,
      modalPagerAction(input, key),
      () => {},
    )
    if (sticky === null) return
    event.stopImmediatePropagation()
  })

  // Handle standard close action
  const handleClose = () =>
    onDone('Shell details dismissed', { display: 'system' })

  // Handle additional close actions beyond Dialog's built-in Esc handler
  useKeybindings(
    {
      'confirm:yes': handleClose,
    },
    { context: 'Confirmation' },
  )

  // Handle dialog-specific keys
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === ' ') {
      e.preventDefault()
      onDone('Shell details dismissed', { display: 'system' })
    } else if (e.key === 'left' && onBack) {
      e.preventDefault()
      onBack()
    } else if (e.key === 'x' && shell.status === 'running' && onKillShell) {
      e.preventDefault()
      onKillShell()
    }
  }

  // Truncate command if too long (for display purposes)
  const isMonitor = shell.kind === 'monitor'
  const displayCommand = truncateToWidth(shell.command, 280)

  return (
    <Box
      flexDirection="column"
      tabIndex={0}
      autoFocus
      onKeyDown={handleKeyDown}
    >
      <Dialog
        title={isMonitor ? 'Monitor details' : 'Shell details'}
        onCancel={handleClose}
        color="background"
        inputGuide={exitState =>
          exitState.pending ? (
            <Text>Press {exitState.keyName} again to exit</Text>
          ) : (
            <Byline>
              {onBack && <KeyboardShortcutHint shortcut="←" action="go back" />}
              <KeyboardShortcutHint shortcut="Esc/Enter/Space" action="close" />
              <KeyboardShortcutHint shortcut="↑↓/PgUp/PgDn" action="scroll" />
              {shell.status === 'running' && onKillShell && (
                <KeyboardShortcutHint shortcut="x" action="stop" />
              )}
            </Byline>
          )
        }
      >
        <Box flexDirection="column">
          <Text>
            <Text bold>Status:</Text>{' '}
            {shell.status === 'running' ? (
              <Text color="background">
                {shell.status}
                {shell.result?.code !== undefined &&
                  ` (exit code: ${shell.result.code})`}
              </Text>
            ) : shell.status === 'completed' ? (
              <Text color="success">
                {shell.status}
                {shell.result?.code !== undefined &&
                  ` (exit code: ${shell.result.code})`}
              </Text>
            ) : (
              <Text color="error">
                {shell.status}
                {shell.result?.code !== undefined &&
                  ` (exit code: ${shell.result.code})`}
              </Text>
            )}
          </Text>
          <Text>
            <Text bold>Runtime:</Text>{' '}
            {formatDuration((shell.endTime ?? Date.now()) - shell.startTime)}
          </Text>
          <Text wrap="wrap">
            <Text bold>{isMonitor ? 'Script:' : 'Command:'}</Text>{' '}
            {displayCommand}
          </Text>
        </Box>

        <Box flexDirection="column">
          <Text bold>Output:</Text>
          <Suspense fallback={<Text dimColor>Loading output…</Text>}>
            <ShellOutputContent
              outputPromise={deferredOutputPromise}
              columns={columns}
              scrollRef={scrollRef}
            />
          </Suspense>
        </Box>
      </Dialog>
    </Box>
  )
}

type ShellOutputContentProps = {
  outputPromise: Promise<TaskOutputResult>
  columns: number
  scrollRef: React.MutableRefObject<ScrollBoxHandle | null>
}

function ShellOutputContent({
  outputPromise,
  columns,
  scrollRef,
}: ShellOutputContentProps): React.ReactNode {
  const { content, bytesTotal } = use(outputPromise)

  // Trim trailing newline so the last visible line isn't a blank row.
  const trimmedContent = content.replace(/\n+$/, '')
  const lines = trimmedContent ? trimmedContent.split('\n') : []
  const isIncomplete = bytesTotal > content.length

  // Position info derived from the imperative ScrollBox handle. We refresh
  // it on subscribe + a low-frequency timer so the "lines X-Y of Z" footer
  // updates as the user scrolls or as new output comes in via stickyScroll.
  const [position, setPosition] = useState<{
    top: number
    height: number
    total: number
  }>({ top: 0, height: OUTPUT_VIEWPORT_HEIGHT, total: lines.length })

  useEffect(() => {
    const refresh = () => {
      const s = scrollRef.current
      if (!s) return
      setPosition({
        top: s.getScrollTop(),
        height: s.getViewportHeight() || OUTPUT_VIEWPORT_HEIGHT,
        total: lines.length,
      })
    }
    refresh()
    const unsubscribe = scrollRef.current?.subscribe(refresh)
    // Cover the stickyScroll case where the renderer pins to bottom without
    // calling subscribe listeners.
    const timer = setInterval(refresh, 500)
    return () => {
      unsubscribe?.()
      clearInterval(timer)
    }
  }, [lines.length, scrollRef])

  if (!content) {
    return <Text dimColor>No output available</Text>
  }

  const visibleStart = Math.max(1, position.top + 1)
  const visibleEnd = Math.min(position.total, position.top + position.height)
  const positionLabel =
    position.total === 0
      ? 'no output'
      : `lines ${visibleStart}-${visibleEnd} of ${position.total}`

  return (
    <>
      <ScrollBox
        ref={scrollRef}
        stickyScroll
        flexDirection="column"
        flexShrink={0}
        borderStyle="round"
        paddingX={1}
        height={OUTPUT_VIEWPORT_HEIGHT}
        maxWidth={columns - 6}
      >
        {lines.map((line, i) => (
          <Text key={i} wrap="truncate-end">
            {line || ' '}
          </Text>
        ))}
      </ScrollBox>
      <Text dimColor italic>
        {positionLabel}
        {isIncomplete ? ` (${formatFileSize(bytesTotal)} on disk)` : ''}
      </Text>
    </>
  )
}
