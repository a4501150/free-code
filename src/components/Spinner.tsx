// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import { Box, Text } from '../ink.js'
import * as React from 'react'
import { useEffect, useMemo, useState } from 'react'
import { stringWidth } from '../ink/stringWidth.js'
import { getGraphemeSegmenter } from '../utils/intl.js'

/** Interval for the shimmer animation tick (ms). */
const SHIMMER_INTERVAL_MS = 150

/** Compute the glimmer index for a reverse-sweep shimmer animation. */
function computeGlimmerIndex(tick: number, messageWidth: number): number {
  const cycleLength = messageWidth + 20
  return messageWidth + 10 - (tick % cycleLength)
}

/**
 * Split text into three segments by visual column position for shimmer rendering.
 */
function computeShimmerSegments(
  text: string,
  glimmerIndex: number,
): { before: string; shimmer: string; after: string } {
  const messageWidth = stringWidth(text)
  const shimmerStart = glimmerIndex - 1
  const shimmerEnd = glimmerIndex + 1

  if (shimmerStart >= messageWidth || shimmerEnd < 0) {
    return { before: text, shimmer: '', after: '' }
  }

  const clampedStart = Math.max(0, shimmerStart)
  let colPos = 0
  let before = ''
  let shimmer = ''
  let after = ''
  for (const { segment } of getGraphemeSegmenter().segment(text)) {
    const segWidth = stringWidth(segment)
    if (colPos + segWidth <= clampedStart) {
      before += segment
    } else if (colPos > shimmerEnd) {
      after += segment
    } else {
      shimmer += segment
    }
    colPos += segWidth
  }

  return { before, shimmer, after }
}
import { getAssistantActive, getUserMsgOptIn } from '../bootstrap/state.js'
import { count } from '../utils/array.js'
import sample from 'lodash-es/sample.js'
import { formatDuration, formatSecondsShort } from '../utils/format.js'
import type { Theme } from 'src/utils/theme.js'
import { activityManager } from '../utils/activityManager.js'
import { getSpinnerVerbs } from '../constants/spinnerVerbs.js'
import { MessageResponse } from './MessageResponse.js'
import { TaskPanelRows } from './TaskLivePanel.js'
import { useSubagentTasksV2, useTasksV2 } from '../hooks/useTasksV2.js'
import type { Task } from '../utils/tasks.js'
import { useAppState } from '../state/AppState.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { getDefaultCharacters, type SpinnerMode } from './Spinner/index.js'
import { SpinnerAnimationRow } from './Spinner/SpinnerAnimationRow.js'
import { useSettings } from '../hooks/useSettings.js'
import { isLocalAgentTask } from '../tasks/LocalAgentTask/LocalAgentTask.js'
import { isBackgroundTask } from '../tasks/types.js'
import { getEffortSuffix } from '../utils/effort.js'
import { getMainLoopModel } from '../utils/model/model.js'
import type { StreamingThinking } from '../utils/messages.js'
import { TEARDROP_ASTERISK } from '../constants/figures.js'

import { useAnimationFrame } from '../ink.js'
import { ProgressBar } from './design-system/ProgressBar.js'
import { compactProgressPercent } from './Spinner/compactProgress.js'
export type { SpinnerMode } from './Spinner/index.js'

const DEFAULT_CHARACTERS = getDefaultCharacters()

const SPINNER_FRAMES = [
  ...DEFAULT_CHARACTERS,
  ...[...DEFAULT_CHARACTERS].reverse(),
]

type Props = {
  mode: SpinnerMode
  loadingStartTimeRef: React.RefObject<number>
  totalPausedMsRef: React.RefObject<number>
  pauseStartTimeRef: React.RefObject<number | null>
  spinnerTip?: string
  responseLengthRef: React.RefObject<number>
  overrideColor?: keyof Theme | null
  overrideShimmerColor?: keyof Theme | null
  overrideMessage?: string | null
  spinnerSuffix?: string | null
  verbose: boolean
  hasActiveTools?: boolean
  /** When the LEADER's compaction is in flight, the ms timestamp it began.
   * Drives the progress bar. The REPL nulls this (and the compaction color/
   * message overrides) while an agent transcript view is up — a compacting
   * agent paints only its own view, from its task's `compacting` field. */
  compactingStartTime?: number | null
  /** Leader's live thinking state. The byline shows thinking status from this
   * same source that drives the transcript overlay and the stamped message
   * duration — one measurement (recorded at reasoning content_block_stop),
   * one formatter, no private timers. Viewing a local agent swaps in that
   * agent's own streamingThinking instead. */
  streamingThinking?: StreamingThinking | null
}

// Thin wrapper: branches on isBriefOnly so the two variants have independent
// hook call chains. Without this split, toggling /brief mid-render would
// violate Rules of Hooks (the inner variant calls ~10 more hooks).
export function SpinnerWithVerb(props: Props): React.ReactNode {
  const isBriefOnly = useAppState(s => s.isBriefOnly)
  // REPL overrides isBriefOnly→false when viewing an agent transcript. That
  // prop isn't threaded here, so replicate the gate from the store — the
  // agent view needs the real spinner (which shows the agent's status).
  const viewingAgentTaskId = useAppState(s => s.viewingAgentTaskId)

  // Runtime gate mirrors isBriefEnabled() but inlined — importing from
  // BriefTool.ts would leak tool-name strings into external builds. Single
  // spinner instance → hooks stay unconditional (two subs, negligible).
  if (
    (getAssistantActive() || getUserMsgOptIn()) &&
    isBriefOnly &&
    !viewingAgentTaskId
  ) {
    return (
      <BriefSpinner
        mode={props.mode}
        overrideMessage={props.overrideMessage}
        compactingStartTime={props.compactingStartTime}
      />
    )
  }

  return <SpinnerWithVerbInner {...props} />
}

function SpinnerWithVerbInner({
  mode,
  loadingStartTimeRef,
  totalPausedMsRef,
  pauseStartTimeRef,
  spinnerTip,
  responseLengthRef,
  overrideColor,
  overrideShimmerColor,
  overrideMessage,
  spinnerSuffix,
  verbose,
  hasActiveTools = false,
  compactingStartTime = null,
  streamingThinking = null,
}: Props): React.ReactNode {
  const settings = useSettings()
  const reducedMotion = settings.prefersReducedMotion ?? false

  // NOTE: useAnimationFrame(50) lives in SpinnerAnimationRow, not here.
  // This component only re-renders when props or app state change —
  // it is no longer on the 50ms clock. All `time`-derived values
  // (frame, glimmer, stalled intensity, token counter, thinking shimmer,
  // elapsed-time timer) are computed inside the child.

  const tasks = useAppState(s => s.tasks)
  const viewingAgentTaskId = useAppState(s => s.viewingAgentTaskId)
  const expandedView = useAppState(s => s.expandedView)
  const showExpandedTodos = expandedView === 'tasks'
  // Get viewed local agent (coordinator panel subagent).
  const viewedLocalAgent = viewingAgentTaskId
    ? (() => {
        const t = tasks[viewingAgentTaskId]
        return isLocalAgentTask(t) ? t : undefined
      })()
    : undefined
  const { columns } = useTerminalSize()
  const mainTasksV2 = useTasksV2()
  const subagentTasksV2 = useSubagentTasksV2(viewingAgentTaskId)
  // Viewing a local agent shows that agent's own list — a viewing context
  // must never borrow the main session's list (the main session's todos would
  // render as the agent's). Concurrent agents legitimately share
  // the leader's list, so the fallback stays for non-local-agent views.
  const tasksV2 = viewedLocalAgent
    ? subagentTasksV2
    : (subagentTasksV2 ?? mainTasksV2)

  // Compaction UI is per-VIEW: inside an agent's transcript view every effect
  // (progress bar, blue hook color, panel stand-down) comes from that agent's
  // own task state. The REPL nulls the leader's compaction props while any
  // agent view is up, so the compactingStartTime prop only ever describes a
  // compaction the main view should show.
  const viewedCompacting = viewedLocalAgent?.compacting
  const viewCompactionStart = viewedLocalAgent
    ? (viewedCompacting?.startedAt ?? null)
    : compactingStartTime

  // The live task-list panel is hosted by this component (every variant) and
  // renders FLUSH below the spinner row: the spinner's own marginTop=1 is the
  // block's single blank separator against the messages in every state, so
  // the panel appearing or vanishing is a pure bottom-edge append/truncate —
  // the top edge never moves and the log-update shift fast path scrolls
  // (tests/e2e/thinking-swap-repaint.test.ts guards this). A compacting agent
  // on screen stands the panel down; the store collapses expandedView itself
  // once the all-completed window ends.
  const panel =
    showExpandedTodos &&
    viewCompactionStart == null &&
    tasksV2 &&
    tasksV2.length > 0 ? (
      <TaskPanelRows tasks={tasksV2} />
    ) : null

  // Thinking status for the byline: 'thinking' | number (duration in ms) | null.
  // Derived from the same StreamingThinking state that drives the transcript
  // overlay and the stamped message duration — no private clock or timers.
  // durationMs wins over isStreaming: it is recorded at reasoning
  // content_block_stop, so the byline can show the true duration while the
  // overlay still waits for the finalized message (keeps their swap batched).
  // Viewing a subagent swaps in that agent's own state (the leader's describes
  // the leader, not the agent on screen).
  const thinkingSource: StreamingThinking | null | undefined = viewedLocalAgent
    ? viewedLocalAgent.streamingThinking
    : streamingThinking
  const thinkingStatus: 'thinking' | number | null = !thinkingSource
    ? null
    : typeof thinkingSource.durationMs === 'number'
      ? thinkingSource.durationMs
      : thinkingSource.isStreaming
        ? 'thinking'
        : null

  // Find the current in-progress task and next pending task
  const currentTodo = tasksV2?.find(
    task => task.status !== 'pending' && task.status !== 'completed',
  )
  const nextTask = findNextPendingTask(tasksV2)

  // Use useState with initializer to pick a random verb once on mount.
  // The REPL unmounts the subtree only at turn boundaries (grace-windowed),
  // so mount == turn here: the verb rotates per turn but never mid-turn.
  const [randomVerb] = useState(() => sample(getSpinnerVerbs()) ?? 'Working')

  // The main session's own verb
  const leaderVerb =
    overrideMessage ??
    currentTodo?.activeForm ??
    currentTodo?.subject ??
    randomVerb

  // A viewed subagent shows its own label (panel precedence: summary >
  // description), not the main session's todo verb.
  const effectiveVerb =
    viewedLocalAgent?.compacting?.label ??
    (viewedLocalAgent
      ? viewedLocalAgent.progress?.summary ||
        viewedLocalAgent.description ||
        leaderVerb
      : leaderVerb)
  const message = effectiveVerb + '…'

  // Track CLI activity when spinner is active
  useEffect(() => {
    const operationId = 'spinner-' + mode
    activityManager.startCLIActivity(operationId)
    return () => {
      activityManager.endCLIActivity(operationId)
    }
  }, [mode])

  const effortSuffix = getEffortSuffix(
    viewedLocalAgent?.model ?? getMainLoopModel(),
  )

  // Stale read of the refs below — we're off the 50ms clock
  // so this only updates when props/app state change, which is sufficient for
  // coarse thresholds.
  const elapsedSnapshot =
    pauseStartTimeRef.current !== null
      ? pauseStartTimeRef.current -
        loadingStartTimeRef.current -
        totalPausedMsRef.current
      : Date.now() - loadingStartTimeRef.current - totalPausedMsRef.current

  const defaultColor: keyof Theme = 'claude'
  const defaultShimmerColor = 'claudeShimmer'
  // Blue hook-phase color: the leader's arrives as the REPL's blue override
  // (main view only — nulled in agent views); a viewed agent's derives from
  // its own task state, mirroring that color pair.
  const hooksActive = viewedLocalAgent
    ? !!viewedCompacting?.hooksActive
    : overrideColor === 'claudeBlue_FOR_SYSTEM_SPINNER'
  const messageColor: keyof Theme = hooksActive
    ? 'claudeBlue_FOR_SYSTEM_SPINNER'
    : (overrideColor ?? defaultColor)
  const shimmerColor: keyof Theme = hooksActive
    ? 'claudeBlueShimmer_FOR_SYSTEM_SPINNER'
    : (overrideShimmerColor ?? defaultShimmerColor)

  // When viewing a completed/failed local agent, show static status
  if (viewedLocalAgent && viewedLocalAgent.status !== 'running') {
    const elapsed = formatDuration(
      (viewedLocalAgent.endTime ?? Date.now()) -
        viewedLocalAgent.startTime -
        (viewedLocalAgent.totalPausedMs ?? 0),
    )
    return (
      <Box flexDirection="column" width="100%" alignItems="flex-start">
        <Box flexDirection="row" flexWrap="wrap" marginTop={1} width="100%">
          <Text dimColor>
            {TEARDROP_ASTERISK} Worked for {elapsed}
          </Text>
        </Box>
        {panel}
      </Box>
    )
  }

  // Time-based tip overrides: coarse thresholds so a stale ref read (we're
  // off the 50ms clock) is fine. Other triggers (mode change, setMessages)
  // cause re-renders that refresh this in practice.
  const tipsEnabled = settings.spinnerTipsEnabled !== false
  const showClearTip = tipsEnabled && elapsedSnapshot > 1_800_000

  const effectiveTip =
    showClearTip && !nextTask
      ? 'Use /clear to start fresh when switching topics and free up context'
      : spinnerTip

  return (
    <Box flexDirection="column" width="100%" alignItems="flex-start">
      <Box flexDirection="column" width="100%" alignItems="flex-start">
        <SpinnerAnimationRow
          mode={mode}
          reducedMotion={reducedMotion}
          hasActiveTools={hasActiveTools}
          responseLengthRef={responseLengthRef}
          message={message}
          messageColor={messageColor}
          shimmerColor={shimmerColor}
          overrideColor={overrideColor}
          loadingStartTimeRef={loadingStartTimeRef}
          totalPausedMsRef={totalPausedMsRef}
          pauseStartTimeRef={pauseStartTimeRef}
          spinnerSuffix={spinnerSuffix}
          verbose={verbose}
          columns={columns}
          thinkingStatus={thinkingStatus}
          effortSuffix={effortSuffix}
          viewedLocalAgent={viewedLocalAgent}
        />
        {viewCompactionStart != null ? (
          <Box width="100%" flexDirection="column">
            <CompactProgressBar
              startTime={viewCompactionStart}
              columns={columns}
            />
          </Box>
        ) : !showExpandedTodos && (nextTask || effectiveTip) ? (
          // The expanded task list renders as `panel` below instead of this
          // summary line; when the panel is gone (collapsed view, store hide
          // after all-complete) the store also collapses expandedView, so
          // suppressing on showExpandedTodos alone is enough.
          // IMPORTANT: we need this width="100%" to avoid a bug in our vendored
          // renderer (src/ink incremental diffing) where the tip gets duplicated
          // over and over while the spinner is running if the terminal is very
          // small. Root cause (investigated, not fixed): in log-update.ts the
          // growth path renders rows above prev.screen.height via
          // renderFrameSlice and lets the terminal scroll naturally, assuming
          // new rows only appear at the tail. When a sibling above re-wraps in
          // a narrow terminal, the tip shifts down and each growth frame paints
          // another copy before the erase pass clears the old one; width=100%
          // makes the tip box pin to the full row so the diff overwrites the
          // stale copy in place. Fixing it properly needs the erased region to
          // cover re-wrapped rows mid-frame — needs a small-terminal tmux repro.
          <Box width="100%" flexDirection="column">
            {(nextTask || effectiveTip) && (
              <MessageResponse>
                <Text dimColor>
                  {nextTask
                    ? `Next: ${nextTask.subject}`
                    : `Tip: ${effectiveTip}`}
                </Text>
              </MessageResponse>
            )}
          </Box>
        ) : null}
        {panel}
      </Box>
    </Box>
  )
}

// Official layout: bar indented 2, 6 cells held back for the " NN%" suffix,
// never wider than 40. Below 8 usable cells it reads as noise, so drop it.
const COMPACT_BAR_MAX_WIDTH = 40
const COMPACT_BAR_MIN_WIDTH = 8
const COMPACT_BAR_INDENT = 2
const COMPACT_BAR_SUFFIX_WIDTH = 6

function CompactProgressBar({
  startTime,
  columns,
}: {
  startTime: number
  columns: number
}): React.ReactNode {
  // Ticker only. The percentage comes from Date.now(), not from this hook's
  // time, which is a shared ClockContext value rather than wall clock.
  useAnimationFrame(250)

  const percent = compactProgressPercent(Date.now() - startTime)
  const width = Math.min(
    COMPACT_BAR_MAX_WIDTH,
    columns - COMPACT_BAR_INDENT - COMPACT_BAR_SUFFIX_WIDTH,
  )
  if (width < COMPACT_BAR_MIN_WIDTH) {
    return null
  }

  return (
    <Box paddingLeft={COMPACT_BAR_INDENT}>
      <ProgressBar ratio={percent / 100} width={width} variant="pill" />
      <Text dimColor> {percent}%</Text>
    </Box>
  )
}

// Brief/assistant mode spinner: single status line. PromptInput drops its
// own marginTop when isBriefOnly is active, so this component owns the
// 2-row footprint between messages and input. Footprint is [blank, content]
// — one blank row above (breathing room under the messages list), spinner
// flush against the input bar. PromptInput's absolute-positioned
// Notifications overlay compensates with marginTop=-2 in brief mode
// (PromptInput.tsx:~2928) so it floats into the blank row above the
// spinner, not over the spinner content. Paired with BriefIdleStatus which
// keeps the same footprint when idle.
type BriefSpinnerProps = {
  mode: SpinnerMode
  overrideMessage?: string | null
  compactingStartTime?: number | null
}

function BriefSpinner({
  mode,
  overrideMessage,
  compactingStartTime = null,
}: BriefSpinnerProps): React.ReactNode {
  const settings = useSettings()
  const reducedMotion = settings.prefersReducedMotion ?? false
  // Brief mode has no viewing context (the wrapper only routes here when no
  // agent view is up), so the panel is the main list, flush under the status
  // line like in the full spinner.
  const expandedView = useAppState(s => s.expandedView)
  const mainTasksV2 = useTasksV2()
  const panel =
    expandedView === 'tasks' &&
    compactingStartTime == null &&
    mainTasksV2 &&
    mainTasksV2.length > 0 ? (
      <TaskPanelRows tasks={mainTasksV2} />
    ) : null
  const [randomVerb] = useState(() => sample(getSpinnerVerbs()) ?? 'Working')
  const verb = overrideMessage ?? randomVerb

  // Track CLI activity so OS/IDE "busy" indicators fire in brief mode too
  useEffect(() => {
    const operationId = 'spinner-' + mode
    activityManager.startCLIActivity(operationId)
    return () => {
      activityManager.endCLIActivity(operationId)
    }
  }, [mode])

  // Drive both dot cycle and shimmer from the shared clock. The viewport
  // ref is unused — the spinner unmounts on turn end so viewport-based
  // pausing isn't needed.
  const [, time] = useAnimationFrame(reducedMotion ? null : 120)

  const runningCount = useAppState(s =>
    count(Object.values(s.tasks), isBackgroundTask),
  )

  const showConnWarning = false
  const connText = ''

  // Dots padded to a fixed 3 columns so the right-aligned count doesn't
  // jitter as the cycle advances.
  const dotFrame = Math.floor(time / 300) % 3
  const dots = reducedMotion ? '…  ' : '.'.repeat(dotFrame + 1).padEnd(3)

  // Shimmer: reverse-sweep highlight across the verb. Skip for connection
  // warnings (shimmer reads as "working"; Reconnecting/Disconnected is not).
  const verbWidth = useMemo(() => stringWidth(verb), [verb])
  const glimmerIndex =
    reducedMotion || showConnWarning
      ? -100
      : computeGlimmerIndex(Math.floor(time / SHIMMER_INTERVAL_MS), verbWidth)
  const { before, shimmer, after } = computeShimmerSegments(verb, glimmerIndex)

  const { columns } = useTerminalSize()
  const rightText = runningCount > 0 ? `${runningCount} in background` : ''
  // Manual right-align via space padding — flexGrow spacers inside
  // FullscreenLayout's `main` slot don't resolve a width and caused the
  // diff engine to miss dot-frame updates.
  const leftWidth = (showConnWarning ? stringWidth(connText) : verbWidth) + 3
  const pad = Math.max(1, columns - 2 - leftWidth - stringWidth(rightText))

  return (
    <Box flexDirection="column" width="100%" alignItems="flex-start">
      <Box flexDirection="row" width="100%" marginTop={1} paddingLeft={2}>
        {showConnWarning ? (
          <Text color="error">{connText + dots}</Text>
        ) : (
          <>
            {before ? <Text dimColor>{before}</Text> : null}
            {shimmer ? <Text>{shimmer}</Text> : null}
            {after ? <Text dimColor>{after}</Text> : null}
            <Text dimColor>{dots}</Text>
          </>
        )}
        {rightText ? (
          <>
            <Text>{' '.repeat(pad)}</Text>
            <Text color="subtle">{rightText}</Text>
          </>
        ) : null}
      </Box>
      {panel}
    </Box>
  )
}

// Idle placeholder for brief mode. Same 2-row [blank, content] footprint
// as BriefSpinner so the input bar never jumps when toggling between
// working/idle/disconnected. See BriefSpinner's comment for the
// Notifications overlay coupling.
export function BriefIdleStatus(): React.ReactNode {
  const runningCount = useAppState(s =>
    count(Object.values(s.tasks), isBackgroundTask),
  )
  const { columns } = useTerminalSize()

  const showConnWarning = false
  const connText = ''
  const leftText = showConnWarning ? connText : ''
  const rightText = runningCount > 0 ? `${runningCount} in background` : ''

  if (!leftText && !rightText) return <Box height={2} />

  const pad = Math.max(
    1,
    columns - 2 - stringWidth(leftText) - stringWidth(rightText),
  )
  return (
    <Box marginTop={1} paddingLeft={2}>
      <Text>
        {leftText ? <Text color="error">{leftText}</Text> : null}
        {rightText ? (
          <>
            <Text>{' '.repeat(pad)}</Text>
            <Text color="subtle">{rightText}</Text>
          </>
        ) : null}
      </Text>
    </Box>
  )
}

export function Spinner(): React.ReactNode {
  const settings = useSettings()
  const reducedMotion = settings.prefersReducedMotion ?? false
  const [ref, time] = useAnimationFrame(reducedMotion ? null : 120)

  // Reduced motion: static dot instead of animated spinner
  if (reducedMotion) {
    return (
      <Box ref={ref} flexWrap="wrap" height={1} width={2}>
        <Text color="text">●</Text>
      </Box>
    )
  }

  // Derive frame from synced time - all spinners animate together
  const frame = Math.floor(time / 120) % SPINNER_FRAMES.length

  return (
    <Box ref={ref} flexWrap="wrap" height={1} width={2}>
      <Text color="text">{SPINNER_FRAMES[frame]}</Text>
    </Box>
  )
}

function findNextPendingTask(tasks: Task[] | undefined): Task | undefined {
  if (!tasks) {
    return undefined
  }
  const pendingTasks = tasks.filter(t => t.status === 'pending')
  if (pendingTasks.length === 0) {
    return undefined
  }
  const unresolvedIds = new Set(
    tasks.filter(t => t.status !== 'completed').map(t => t.id),
  )
  return (
    pendingTasks.find(t => !t.blockedBy.some(id => unresolvedIds.has(id))) ??
    pendingTasks[0]
  )
}
