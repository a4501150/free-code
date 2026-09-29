/**
 * The hosted launcher — the default interactive startup's replacement for
 * the in-process REPL.
 *
 * The terminal becomes a wire client of its own trunk: an in-process
 * sessiond serve (ephemeral loopback port, own attach descriptor — so the
 * process skips `startProcessAttachHost` and `claude attach` from another
 * terminal finds it like any sessiond), one hosted session adopted from
 * what the CLI already assembled (id, transcript, defaults), and the
 * AttachedSession viewer rendering the wire. Prompts, cancellations and
 * permission decisions ride the same commands the browser and `attach`
 * send; the session's core, broker and transcript are the single source of
 * truth, not this terminal's React state.
 *
 * Exiting the viewer ends the process and with it the hosted session —
 * same lifetime contract as the REPL it replaces. A session meant to
 * outlive the terminal is hosted by the long-lived `web` service instead.
 */
import React from 'react'
import { App } from '../components/App.js'
import { AlternateScreen } from '../ink/components/AlternateScreen.js'
import { isMouseTrackingEnabled } from '../utils/fullscreen.js'
import type { StatsStore } from '../context/stats.js'
import type { Root } from '../ink.js'
import { AttachedSession } from '../screens/AttachedSession.js'
import type { AppState } from '../state/AppStateStore.js'
import type { Message } from '../types/message.js'
import { gracefulShutdownSync } from '../utils/gracefulShutdown.js'
import type { FpsMetrics } from '../utils/fpsTracker.js'
import { startSessiondServe } from './serve.js'
import type { SessionDefaults } from './registry.js'

export type HostedLaunch = {
  /** The directory the session runs in (the CLI's original cwd). */
  cwd: string
  /**
   * The id this process already owns — the fresh startup id, or the one
   * resume adoption switched to. Hosting under it keeps the PID
   * registration, the transcript path and the wire id in agreement.
   */
  sessionId: string
  /** Conversation the CLI already loaded or assembled (resume transcript, hook messages). */
  initialTranscript?: Message[]
  /** Positional CLI prompt: submitted once the viewer's stream is up. */
  initialPrompt?: string
  /**
   * Partial defaults from the CLI flags; assembleSessionDefaults fills the
   * tool pool, the command registry and the permission context from cwd.
   */
  defaults?: SessionDefaults
}

export async function launchHosted(
  root: Root,
  appProps: {
    getFpsMetrics: () => FpsMetrics | undefined
    stats?: StatsStore
    initialState: AppState
  },
  launch: HostedLaunch,
  renderAndRun: (root: Root, element: React.ReactNode) => Promise<void>,
): Promise<void> {
  const serve = await startSessiondServe({ port: 0 })
  try {
    const entry = await serve.registry.adopt({
      sessionId: launch.sessionId,
      cwd: launch.cwd,
      initialTranscript: launch.initialTranscript,
      defaults: launch.defaults,
    })
    // The CLI resolved the view flags (the --verbose switch, the verbose
    // setting) before hosting; the viewer reads them from the session's
    // store, so carry them over. Everything else in the store stays the
    // session's — its permission context and rules are seeded by adoption.
    entry.hosted.store.setState(prev => ({
      ...prev,
      verbose: appProps.initialState.verbose,
    }))
    await renderAndRun(
      root,
      // The viewer must live in the alternate screen like the REPL it
      // replaces: Ink's click dispatch is gated on alt-screen being active
      // (fixed viewport, 1:1 cell mapping), so without this wrapper the
      // transcript's click-to-expand disclosures silently go nowhere.
      // The hosted session's own AppState store backs the viewer's context:
      // the classic dialogs this viewer mirrors (task dialogs, plan approval)
      // read the session's live state, not a UI-local copy.
      <App {...appProps} store={entry.hosted.store}>
        <AlternateScreen mouseTracking={isMouseTrackingEnabled()}>
          <AttachedSession
            pid={process.pid}
            sessionId={entry.hosted.channel.sessionId}
            initialPrompt={launch.initialPrompt}
            // The session's local-jsx dialogs (/help, /model) hand off
            // their JSX here — this process is the session's.
            localDialogs={entry.hosted.dialogs}
            // The pane this process shows at boot replaces the REPL's:
            // the classic banner, not the remote attach's one-liner.
            showWelcomeBanner
          />
        </AlternateScreen>
      </App>,
    )
  } catch (error) {
    await serve.stop().catch(() => {})
    throw error
  }
  // The viewer is gone: the hosted session goes with it, the descriptor
  // goes off disk, and the process finishes the standard shutdown (cleanup
  // handlers, exit bookkeeping) the REPL's exit path would have run.
  await serve.stop().catch(() => {})
  gracefulShutdownSync(0)
}
