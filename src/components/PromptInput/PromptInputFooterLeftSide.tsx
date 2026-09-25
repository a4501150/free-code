// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import { isCoordinatorMode } from '../../coordinator/coordinatorMode.js'
import { Box, Text } from '../../ink.js'
import * as React from 'react'
import figures from 'figures'
import { useMemo } from 'react'
import type { VimMode, PromptInputMode } from '../../types/textInputTypes.js'
import type { ToolPermissionContext } from '../../Tool.js'
import { isVimModeEnabled } from './utils.js'
import { useShortcutDisplay } from '../../keybindings/useShortcutDisplay.js'
import {
  isDefaultMode,
  permissionModeSymbol,
  permissionModeTitle,
  getModeColor,
} from '../../utils/permissions/PermissionMode.js'
import { PAUSE_ICON } from '../../constants/figures.js'
import { BackgroundTaskStatus } from '../tasks/BackgroundTaskStatus.js'
import { isBackgroundTask } from '../../tasks/types.js'
import { isPanelAgentTask } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { getVisibleAgentTasks } from '../CoordinatorAgentStatus.js'
import { count } from '../../utils/array.js'
import { useAppState } from 'src/state/AppState.js'
import HistorySearchInput from './HistorySearchInput.js'
import { usePrStatus } from '../../hooks/usePrStatus.js'
import { KeyboardShortcutHint } from '../design-system/KeyboardShortcutHint.js'
import { Byline } from '../design-system/Byline.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { useTasksV2 } from '../../hooks/useTasksV2.js'
import { formatDuration } from '../../utils/format.js'
import { VoiceWarmupHint } from './VoiceIndicator.js'
import { useVoiceEnabled } from '../../hooks/useVoiceEnabled.js'
import { useVoiceState } from '../../context/voice.js'
import { isXtermJs } from '../../ink/terminal.js'
import { useHasSelection, useSelection } from '../../ink/hooks/use-selection.js'
import { getInitialSettings } from '../../utils/settings/settings.js'
import { getPlatform } from '../../utils/platform.js'
import { PrBadge } from '../PrBadge.js'

type Props = {
  exitMessage: {
    show: boolean
    key?: string
  }
  vimMode: VimMode | undefined
  mode: PromptInputMode
  toolPermissionContext: ToolPermissionContext
  suppressHint: boolean
  isLoading: boolean
  showMemoryTypeSelector?: boolean
  tasksSelected: boolean
  isPasting?: boolean
  isSearching: boolean
  historyQuery: string
  setHistoryQuery: (query: string) => void
  historyFailedMatch: boolean
  onOpenTasksDialog?: (taskId?: string) => void
}

export function PromptInputFooterLeftSide({
  exitMessage,
  vimMode,
  mode,
  toolPermissionContext,
  suppressHint,
  isLoading,
  tasksSelected,
  isPasting,
  isSearching,
  historyQuery,
  setHistoryQuery,
  historyFailedMatch,
  onOpenTasksDialog,
}: Props): React.ReactNode {
  if (exitMessage.show) {
    return (
      <Text dimColor key="exit-message">
        Press {exitMessage.key} again to exit
      </Text>
    )
  }
  if (isPasting) {
    return (
      <Text dimColor key="pasting-message">
        Pasting text…
      </Text>
    )
  }

  const showVim = isVimModeEnabled() && vimMode === 'INSERT' && !isSearching

  return (
    <Box justifyContent="flex-start" gap={1}>
      {isSearching && (
        <HistorySearchInput
          value={historyQuery}
          onChange={setHistoryQuery}
          historyFailedMatch={historyFailedMatch}
        />
      )}
      {showVim ? (
        <Text dimColor key="vim-insert">
          -- INSERT --
        </Text>
      ) : null}
      <ModeIndicator
        mode={mode}
        toolPermissionContext={toolPermissionContext}
        showHint={!suppressHint && !showVim}
        isLoading={isLoading}
        tasksSelected={tasksSelected}
        onOpenTasksDialog={onOpenTasksDialog}
      />
    </Box>
  )
}

type ModeIndicatorProps = {
  mode: PromptInputMode
  toolPermissionContext: ToolPermissionContext
  showHint: boolean
  isLoading: boolean
  tasksSelected: boolean
  onOpenTasksDialog?: (taskId?: string) => void
}

function ModeIndicator({
  mode,
  toolPermissionContext,
  showHint,
  isLoading,
  tasksSelected,
  onOpenTasksDialog,
}: ModeIndicatorProps): React.ReactNode {
  const { columns } = useTerminalSize()
  const modeCycleShortcut = useShortcutDisplay(
    'chat:cycleMode',
    'Chat',
    'shift+tab',
  )
  const tasks = useAppState(s => s.tasks)
  const expandedView = useAppState(s => s.expandedView)
  const prStatus = usePrStatus(isLoading, isPrStatusEnabled())

  const voiceEnabled = useVoiceEnabled()
  const voiceState = useVoiceState(s => s.voiceState)
  const voiceWarmingUp = useVoiceState(s => s.voiceWarmingUp)
  const hasSelection = useHasSelection()
  const selGetState = useSelection().getState
  const isCoordinator = isCoordinatorMode()
  const runningTaskCount = useMemo(
    () =>
      count(
        Object.values(tasks),
        t =>
          isBackgroundTask(t) && !(isCoordinator ? isPanelAgentTask(t) : false),
      ),
    [tasks, isCoordinator],
  )
  const tasksV2 = useTasksV2()
  const hasTaskItems = tasksV2 !== undefined && tasksV2.length > 0
  const escShortcut = useShortcutDisplay(
    'chat:cancel',
    'Chat',
    'esc',
  ).toLowerCase()
  const todosShortcut = useShortcutDisplay(
    'app:toggleTodos',
    'Global',
    'ctrl+t',
  )
  const killAgentsShortcut = useShortcutDisplay(
    'chat:killAgents',
    'Chat',
    'ctrl+x ctrl+k',
  )
  const voiceKeyShortcut = useShortcutDisplay(
    'voice:pushToTalk',
    'Chat',
    'Space',
  )
  const isKillAgentsConfirmShowing = useAppState(
    s => s.notifications.current?.key === 'kill-agents-confirm',
  )

  if (mode === 'bash') {
    return <Text color="bashBorder">! for bash mode</Text>
  }

  const currentMode = toolPermissionContext?.mode
  const hasActiveMode = !isDefaultMode(currentMode)
  const hasBackgroundTasks = runningTaskCount > 0

  // Count primary items (permission mode or coordinator mode, background tasks)
  const primaryItemCount =
    (isCoordinator || hasActiveMode ? 1 : 0) + (hasBackgroundTasks ? 1 : 0)

  // PR indicator is short (~10 chars) — unlike the old diff indicator the
  // >=100 threshold was tuned for. Now that auto mode is effectively the
  // baseline, primaryItemCount is ≥1 for most sessions; keep the threshold
  // low enough to show PR status on standard 80-col terminals.
  const shouldShowPrStatus =
    isPrStatusEnabled() &&
    prStatus.number !== null &&
    prStatus.reviewState !== null &&
    prStatus.url !== null &&
    primaryItemCount < 2 &&
    (primaryItemCount === 0 || columns >= 80)

  // Hide the shift+tab hint when there are 2 primary items
  const shouldShowModeHint = primaryItemCount < 2

  const modePart =
    currentMode && hasActiveMode ? (
      <Text color={getModeColor(currentMode)} key="mode">
        {permissionModeSymbol(currentMode)}{' '}
        {permissionModeTitle(currentMode).toLowerCase()} on
        {shouldShowModeHint && (
          <Text dimColor>
            {' '}
            <KeyboardShortcutHint
              shortcut={modeCycleShortcut}
              action="cycle"
              parens
            />
          </Text>
        )}
      </Text>
    ) : currentMode ? (
      // Manual mode's label lives here rather than in PERMISSION_MODE_CONFIG: the
      // shared symbol/title also feed the permission debug readout (which appends
      // its own " mode"), and it reads wrong with a pause glyph or "Manual mode".
      <Text dimColor key="mode">
        {PAUSE_ICON} manual mode on
      </Text>
    ) : null

  const parts = [
    // BackgroundTaskStatus is NOT in parts — it renders as a Box sibling so
    // its click-target Box isn't nested inside the <Text wrap="truncate">
    // wrapper (reconciler throws on Box-in-Text).
    ...(shouldShowPrStatus
      ? [
          <PrBadge
            key="pr-status"
            number={prStatus.number!}
            url={prStatus.url!}
            reviewState={prStatus.reviewState!}
          />,
        ]
      : []),
  ]

  const hasRunningAgentTasks = Object.values(tasks).some(
    t => t.type === 'local_agent' && t.status === 'running',
  )

  // Get hint parts separately for potential second-line rendering
  const hintParts = showHint
    ? getSpinnerHintParts(
        isLoading,
        escShortcut,
        todosShortcut,
        killAgentsShortcut,
        hasTaskItems,
        expandedView,
        hasRunningAgentTasks,
        isKillAgentsConfirmShowing,
      )
    : []

  if (showHint) {
    parts.push(...hintParts)
  }

  // Add "↓ to manage tasks" hint when panel has visible rows
  const hasCoordinatorTasks = getVisibleAgentTasks(tasks).length > 0

  // Tasks pill renders as a Box sibling (not a parts entry) so its
  // click-target Box isn't nested inside <Text wrap="truncate"> — the
  // reconciler throws on Box-in-Text. Computed here so the empty-checks
  // below still treat "pill present" as non-empty.
  const tasksPart = hasBackgroundTasks ? (
    <BackgroundTaskStatus
      tasksSelected={tasksSelected}
      onOpenDialog={onOpenTasksDialog}
    />
  ) : null

  // Manual mode is the baseline, not a state worth trading the shortcuts hint
  // for, so it renders alongside it. Every other mode still displaces the hint.
  if (
    parts.length === 0 &&
    !tasksPart &&
    (!modePart || !hasActiveMode) &&
    showHint
  ) {
    parts.push(
      <Text dimColor key="shortcuts-hint">
        ? for shortcuts
      </Text>,
    )
  }

  // Only replace the idle voice hint when there's something to say — otherwise
  // fall through instead of showing an empty Byline. "esc to clear" was removed
  // (looked like "esc to interrupt" when idle; esc-clears-selection is standard
  // UX) leaving only ctrl+c (copyOnSelect off) and the xterm.js native-select hint.
  const copyOnSelect = getInitialSettings().copyOnSelect ?? true
  const selectionHintHasContent = hasSelection && (!copyOnSelect || isXtermJs())

  // Warmup hint takes priority — when the user is actively holding
  // the activation key, show feedback regardless of other hints.
  if (voiceEnabled && voiceWarmingUp) {
    parts.push(<VoiceWarmupHint key="voice-warmup" />)
  } else if (selectionHintHasContent) {
    // xterm.js (VS Code/Cursor/Windsurf) force-selection modifier is
    // platform-specific and gated on macOS (SelectionService.shouldForceSelection):
    //   macOS:     altKey && macOptionClickForcesSelection (VS Code default: false)
    //   non-macOS: shiftKey
    // On macOS, if we RECEIVED an alt+click (lastPressHadAlt), the VS Code
    // setting is off — xterm.js would have consumed the event otherwise.
    // Tell the user the exact setting to flip instead of repeating the
    // option+click hint they just tried.
    // Non-reactive getState() read is safe: lastPressHadAlt is immutable
    // while hasSelection is true (set pre-drag, cleared with selection).
    const isMac = getPlatform() === 'macos'
    const altClickFailed = isMac && (selGetState()?.lastPressHadAlt ?? false)
    parts.push(
      <Text dimColor key="selection-copy">
        <Byline>
          {!copyOnSelect && (
            <KeyboardShortcutHint shortcut="ctrl+c" action="copy" />
          )}
          {isXtermJs() &&
            (altClickFailed ? (
              <Text>set macOptionClickForcesSelection in VS Code settings</Text>
            ) : (
              <KeyboardShortcutHint
                shortcut={isMac ? 'option+click' : 'shift+click'}
                action="native select"
              />
            ))}
        </Byline>
      </Text>,
    )
  } else if (
    parts.length > 0 &&
    showHint &&
    voiceEnabled &&
    voiceState === 'idle' &&
    hintParts.length === 0
  ) {
    parts.push(
      <Text dimColor key="voice-hint">
        hold {voiceKeyShortcut} to speak
      </Text>,
    )
  }

  if ((tasksPart || hasCoordinatorTasks) && showHint) {
    parts.push(
      <Text dimColor key="manage-tasks">
        {tasksSelected ? (
          <KeyboardShortcutHint shortcut="Enter" action="view tasks" />
        ) : (
          <KeyboardShortcutHint shortcut="↓" action="manage" />
        )}
      </Text>,
    )
  }

  // The bottom section is flexShrink:0 — every row here is a row stolen from
  // the ScrollBox. This component must have a STABLE height so the footer never
  // grows/shrinks and shifts scroll content.
  // Returning null when parts is empty (e.g. StatusLine on → suppressHint
  // → showHint=false → no "? for shortcuts") would let a later-added
  // part (e.g. the selection copy/native-select hints) grow the column
  // from 0→1 row. Always render 1 row; a space reserves it in Yoga without
  // painting anything visible.
  if (parts.length === 0 && !tasksPart && !modePart) {
    return <Text> </Text>
  }

  // flexShrink=0 keeps mode + pill at natural width; the remaining parts
  // truncate at the tail as one string inside the Text wrapper.
  return (
    <Box height={1} overflow="hidden">
      {modePart && (
        <Box flexShrink={0}>
          {modePart}
          {(tasksPart || parts.length > 0) && <Text dimColor> · </Text>}
        </Box>
      )}
      {tasksPart && (
        <Box flexShrink={0}>
          {tasksPart}
          {parts.length > 0 && <Text dimColor> · </Text>}
        </Box>
      )}
      {parts.length > 0 && (
        <Text wrap="truncate">
          <Byline>{parts}</Byline>
        </Text>
      )}
    </Box>
  )
}

function getSpinnerHintParts(
  isLoading: boolean,
  escShortcut: string,
  todosShortcut: string,
  killAgentsShortcut: string,
  hasTaskItems: boolean,
  expandedView: 'none' | 'tasks',
  hasRunningAgentTasks: boolean,
  isKillAgentsConfirmShowing: boolean,
): React.ReactElement[] {
  const toggleAction = expandedView === 'tasks' ? 'hide tasks' : 'show tasks'

  return [
    ...(isLoading
      ? [
          <Text dimColor key="esc">
            <KeyboardShortcutHint shortcut={escShortcut} action="interrupt" />
          </Text>,
        ]
      : []),
    ...(!isLoading && hasRunningAgentTasks && !isKillAgentsConfirmShowing
      ? [
          <Text dimColor key="kill-agents">
            <KeyboardShortcutHint
              shortcut={killAgentsShortcut}
              action="stop agents"
            />
          </Text>,
        ]
      : []),
    ...(hasTaskItems
      ? [
          <Text dimColor key="toggle-tasks">
            <KeyboardShortcutHint
              shortcut={todosShortcut}
              action={toggleAction}
            />
          </Text>,
        ]
      : []),
  ]
}

function isPrStatusEnabled(): boolean {
  return getInitialSettings().prStatusFooterEnabled ?? true
}
