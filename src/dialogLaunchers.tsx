/**
 * Thin launchers for one-off dialog JSX sites in main.tsx.
 * Each launcher renders its component and wires the `done` callback
 * identically to the original inline call site. Zero behavior change.
 *
 * Part of the main.tsx React/JSX extraction effort. See sibling PRs
 * perf/extract-interactive-helpers and perf/launch-repl.
 */
import React from 'react'
import { App } from './components/App.js'
import { InvalidSettingsDialog } from './components/InvalidSettingsDialog.js'
import { SnapshotUpdateDialog } from './components/agents/SnapshotUpdateDialog.js'
import type { StatsStore } from './context/stats.js'
import type { Root } from './ink.js'
import { renderAndRun, showSetupDialog } from './interactiveHelpers.js'
import { KeybindingSetup } from './keybindings/KeybindingProviderSetup.js'
import { ResumeConversation } from './screens/ResumeConversation.js'
import type { AppState } from './state/AppStateStore.js'
import type { AgentMemoryScope } from './tools/AgentTool/agentMemory.js'
import type { FpsMetrics } from './utils/fpsTracker.js'
import type { ValidationError } from './utils/settings/validation.js'

type ResumeConversationProps = React.ComponentProps<typeof ResumeConversation>

/**
 * Site ~3173: SnapshotUpdateDialog (agent memory snapshot update prompt).
 * Original callback wiring: onComplete={done}, onCancel={() => done('keep')}.
 */
export async function launchSnapshotUpdateDialog(
  root: Root,
  props: {
    agentType: string
    scope: AgentMemoryScope
    snapshotTimestamp: string
  },
): Promise<'merge' | 'keep' | 'replace'> {
  return showSetupDialog<'merge' | 'keep' | 'replace'>(root, done => (
    <SnapshotUpdateDialog
      agentType={props.agentType}
      scope={props.scope}
      snapshotTimestamp={props.snapshotTimestamp}
      onComplete={done}
      onCancel={() => done('keep')}
    />
  ))
}

/**
 * Site ~3250: InvalidSettingsDialog (settings validation errors).
 * Original callback wiring: onContinue={done}, onExit passed through from caller.
 */
export async function launchInvalidSettingsDialog(
  root: Root,
  props: {
    settingsErrors: ValidationError[]
    onExit: () => void
  },
): Promise<void> {
  return showSetupDialog(root, done => (
    <InvalidSettingsDialog
      settingsErrors={props.settingsErrors}
      onContinue={done}
      onExit={props.onExit}
    />
  ))
}

/**
 * Site ~4903: ResumeConversation mount (interactive session picker).
 * Uses renderAndRun, NOT showSetupDialog. Wraps in <App><KeybindingSetup>.
 */
export async function launchResumeChooser(
  root: Root,
  appProps: {
    getFpsMetrics: () => FpsMetrics | undefined
    stats: StatsStore
    initialState: AppState
  },
  worktreePathsPromise: Promise<string[]>,
  resumeProps: Omit<ResumeConversationProps, 'worktreePaths'>,
): Promise<void> {
  const worktreePaths = await worktreePathsPromise
  await renderAndRun(
    root,
    <App
      getFpsMetrics={appProps.getFpsMetrics}
      stats={appProps.stats}
      initialState={appProps.initialState}
    >
      <KeybindingSetup>
        <ResumeConversation {...resumeProps} worktreePaths={worktreePaths} />
      </KeybindingSetup>
    </App>,
  )
}
