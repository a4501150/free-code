import React, {
  Suspense,
  use,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { DeepImmutable } from 'src/types/utils.js'
import type { CommandResultDisplay } from '../../commands.js'
import { useModalOrTerminalSize } from '../../context/modalContext.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import type { KeyboardEvent } from '../../ink/events/keyboard-event.js'
import ScrollBox, {
  type ScrollBoxHandle,
} from '../../ink/components/ScrollBox.js'
import type { Color } from '../../ink/styles.js'
import { wrapAnsi } from '../../ink/wrapAnsi.js'
import { Box, Text, useInput } from '../../ink.js'
import { useKeybindings } from '../../keybindings/useKeybinding.js'
import type { LocalShellTaskState } from '../../tasks/LocalShellTask/guards.js'
import { formatDuration, formatFileSize } from '../../utils/format.js'
import { tailFile } from '../../utils/fsOperations.js'
import { getTaskOutputPath } from '../../utils/task/diskOutput.js'
import { getTheme } from '../../utils/theme.js'
import { Byline } from '../design-system/Byline.js'
import { Dialog } from '../design-system/Dialog.js'
import { KeyboardShortcutHint } from '../design-system/KeyboardShortcutHint.js'
import { useTheme } from '../design-system/ThemeProvider.js'
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

// Hard caps for the two scroll viewports. Actual heights are computed
// per-render against the terminal height so the dialog fits without
// overflowing into the messages area above; see `commandHeight`/`outputHeight`.
const OUTPUT_VIEWPORT_HEIGHT_MAX = 20
// Floor so the box stays usable even on very short terminals.
const OUTPUT_VIEWPORT_HEIGHT_MIN = 5
const COMMAND_VIEWPORT_HEIGHT_MAX = 8
const COMMAND_VIEWPORT_HEIGHT_MIN = 1
// Vertical chrome the dialog draws around the two ScrollBoxes (Pane
// divider/pad, title, status/runtime, section labels, inter-section gaps,
// both ScrollBox borders, both position labels, input guide). Subtracted
// from `rows` so the messages area above retains some breathing room.
const VIEWPORT_CHROME_ROWS = 22
// Columns the command ScrollBox spends on its own border and padding, on
// top of the dialog's own inset. The command is pre-wrapped to what's left
// so the rendered line count matches the position label and the scroll
// arithmetic; wrapping inside the Text would make both guesses.
const COMMAND_WRAP_INSET = 12

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
  // useModalOrTerminalSize gives us the modal's restricted rows when the
  // dialog is rendered in FullscreenLayout's modal slot, and the full
  // terminal size otherwise. Without this, `rows - chrome` would compute
  // against the full terminal height even though the modal slot only
  // has `terminalRows - MODAL_TRANSCRIPT_PEEK - 1` available, and the
  // ScrollBox would overflow modal's overflow=hidden.
  const terminalSize = useTerminalSize()
  const { columns, rows } = useModalOrTerminalSize(terminalSize)
  // Pre-wrap rather than letting Text wrap: the ScrollBox scrolls in
  // rendered rows, so the position label and the height budget both need
  // the post-wrap line count. hard/trim match Ink's own `wrap` behavior.
  const commandLines = useMemo(
    () =>
      wrapAnsi(shell.command, Math.max(10, columns - COMMAND_WRAP_INSET), {
        trim: false,
        hard: true,
      }).split('\n'),
    [shell.command, columns],
  )

  // Output keeps first claim on the budget: it's the panel that grows, and
  // the command panel is scrollable when it doesn't get all the rows it wants.
  const viewportBudget = rows - VIEWPORT_CHROME_ROWS
  const commandHeight = Math.max(
    COMMAND_VIEWPORT_HEIGHT_MIN,
    Math.min(
      commandLines.length,
      COMMAND_VIEWPORT_HEIGHT_MAX,
      viewportBudget - OUTPUT_VIEWPORT_HEIGHT_MIN,
    ),
  )
  const outputHeight = Math.max(
    OUTPUT_VIEWPORT_HEIGHT_MIN,
    Math.min(OUTPUT_VIEWPORT_HEIGHT_MAX, viewportBudget - commandHeight),
  )
  const commandScrollable = commandLines.length > commandHeight

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

  // Imperative scroll handles for keyboard navigation in the two panels.
  const scrollRef = useRef<ScrollBoxHandle | null>(null)
  const commandScrollRef = useRef<ScrollBoxHandle | null>(null)

  // Which panel the pager keys drive. Tracked in state rather than via a
  // second `tabIndex` so the dialog keeps one focusable root — an inner
  // focusable would hijack Tab traversal and expose the reconciler's
  // focus-restoration stack when the panels re-render. Collapses to
  // 'output' whenever the command fits, so there's nothing to switch to.
  const [focusedPanel, setFocusedPanel] = useState<'command' | 'output'>(
    'output',
  )
  const activePanel = commandScrollable ? focusedPanel : 'output'

  // Drive the bare j/k/g/G/etc. pager bindings against the focused panel.
  // useInput is naturally scoped to the lifetime of this mounted dialog, so
  // it only fires while the detail view is visible.
  useInput((input, key, event) => {
    const s =
      activePanel === 'command' ? commandScrollRef.current : scrollRef.current
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
      // Returning false leaves the event unconsumed when there's only one
      // scrollable panel, so Tab keeps whatever meaning it has elsewhere.
      'confirm:nextField': () => {
        if (!commandScrollable) return false
        setFocusedPanel(p => (p === 'command' ? 'output' : 'command'))
      },
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

  const isMonitor = shell.kind === 'monitor'

  // ScrollBox is the raw ink component, so theme keys have to be resolved
  // here rather than passed through like they would be to a themed Box.
  const [themeName] = useTheme()
  const theme = getTheme(themeName)
  const panelBorderColor = (panel: 'command' | 'output'): Color | undefined =>
    commandScrollable
      ? ((activePanel === panel ? theme.suggestion : theme.subtle) as Color)
      : undefined

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
              {commandScrollable && (
                <KeyboardShortcutHint shortcut="Tab" action="switch panel" />
              )}
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
        </Box>

        <Box flexDirection="column" onClick={() => setFocusedPanel('command')}>
          <Text bold>{isMonitor ? 'Script:' : 'Command:'}</Text>
          <ScrollBox
            ref={commandScrollRef}
            flexDirection="column"
            borderStyle="round"
            borderColor={panelBorderColor('command')}
            paddingX={1}
            height={commandHeight}
            maxWidth={Math.max(20, columns - 8)}
          >
            {commandLines.map((line, i) => (
              <Text key={i} wrap="truncate-end">
                {line || ' '}
              </Text>
            ))}
          </ScrollBox>
          {commandScrollable && (
            <ScrollPositionLabel
              scrollRef={commandScrollRef}
              fallbackHeight={commandHeight}
              total={commandLines.length}
            />
          )}
        </Box>

        <Box flexDirection="column" onClick={() => setFocusedPanel('output')}>
          <Text bold>Output:</Text>
          <Suspense fallback={<Text dimColor>Loading output…</Text>}>
            <ShellOutputContent
              outputPromise={deferredOutputPromise}
              columns={columns}
              outputHeight={outputHeight}
              scrollRef={scrollRef}
              borderColor={panelBorderColor('output')}
            />
          </Suspense>
        </Box>
      </Dialog>
    </Box>
  )
}

type ScrollPositionLabelProps = {
  scrollRef: React.MutableRefObject<ScrollBoxHandle | null>
  fallbackHeight: number
  total: number
  suffix?: string
}

/**
 * "lines X-Y of Z" footer for a ScrollBox, read from the imperative handle.
 * Refreshed on subscribe plus a low-frequency timer, which covers the
 * stickyScroll case where the renderer pins to bottom without calling
 * subscribe listeners.
 */
function ScrollPositionLabel({
  scrollRef,
  fallbackHeight,
  total,
  suffix = '',
}: ScrollPositionLabelProps): React.ReactNode {
  const [position, setPosition] = useState<{ top: number; height: number }>({
    top: 0,
    height: fallbackHeight,
  })

  useEffect(() => {
    const refresh = () => {
      const s = scrollRef.current
      if (!s) return
      const top = s.getScrollTop()
      const height = s.getViewportHeight() || fallbackHeight
      // Bail on an unchanged read so the idle timer doesn't re-render the
      // whole dialog twice a second for each of the two panels.
      setPosition(prev =>
        prev.top === top && prev.height === height ? prev : { top, height },
      )
    }
    refresh()
    const unsubscribe = scrollRef.current?.subscribe(refresh)
    const timer = setInterval(refresh, 500)
    return () => {
      unsubscribe?.()
      clearInterval(timer)
    }
  }, [fallbackHeight, scrollRef, total])

  const visibleStart = Math.max(1, position.top + 1)
  const visibleEnd = Math.min(total, position.top + position.height)

  return (
    <Text dimColor italic>
      {total === 0
        ? 'no output'
        : `lines ${visibleStart}-${visibleEnd} of ${total}`}
      {suffix}
    </Text>
  )
}

type ShellOutputContentProps = {
  outputPromise: Promise<TaskOutputResult>
  columns: number
  outputHeight: number
  scrollRef: React.MutableRefObject<ScrollBoxHandle | null>
  borderColor: Color | undefined
}

function ShellOutputContent({
  outputPromise,
  columns,
  outputHeight,
  scrollRef,
  borderColor,
}: ShellOutputContentProps): React.ReactNode {
  const { content, bytesTotal } = use(outputPromise)

  // Trim trailing newline so the last visible line isn't a blank row.
  const trimmedContent = content.replace(/\n+$/, '')
  const lines = trimmedContent ? trimmedContent.split('\n') : []
  const isIncomplete = bytesTotal > content.length

  if (!content) {
    return <Text dimColor>No output available</Text>
  }

  return (
    <>
      <ScrollBox
        ref={scrollRef}
        stickyScroll
        flexDirection="column"
        borderStyle="round"
        borderColor={borderColor}
        paddingX={1}
        height={outputHeight}
        maxWidth={Math.max(20, columns - 8)}
      >
        {lines.map((line, i) => (
          <Text key={i} wrap="truncate-end">
            {line || ' '}
          </Text>
        ))}
      </ScrollBox>
      <ScrollPositionLabel
        scrollRef={scrollRef}
        fallbackHeight={outputHeight}
        total={lines.length}
        suffix={
          isIncomplete ? ` (${formatFileSize(bytesTotal)} on disk)` : undefined
        }
      />
    </>
  )
}
