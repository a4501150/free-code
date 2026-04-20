import React from 'react'
import { App } from './components/App.js'
import type { StatsStore } from './context/stats.js'
import type { Root } from './ink.js'
import { REPL, type Props as REPLProps } from './screens/REPL.js'
import type { AppState } from './state/AppStateStore.js'
import type { FpsMetrics } from './utils/fpsTracker.js'

type AppWrapperProps = {
  getFpsMetrics: () => FpsMetrics | undefined
  stats?: StatsStore
  initialState: AppState
}

export async function launchRepl(
  root: Root,
  appProps: AppWrapperProps,
  replProps: REPLProps,
  renderAndRun: (root: Root, element: React.ReactNode) => Promise<void>,
): Promise<void> {
  await renderAndRun(
    root,
    <App {...appProps}>
      <REPL {...replProps} />
    </App>,
  )
}
