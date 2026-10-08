/**
 * REPL host adapter for the settings dialog's Status tab: reads the model and
 * MCP slices from AppState and delegates rendering to the host-agnostic
 * panels/SettingsDialog/Status component. Keeps the original exports so the
 * /config, /cost, /stats, /status and /usage mounts keep working unchanged.
 */

import * as React from 'react'
import type { LocalJSXCommandContext } from '../../commands.js'
import { useAppState } from '../../state/AppState.js'
import type { Diagnostic } from '../../utils/status.js'
import {
  Status as StatusPanel,
  buildDiagnostics,
} from '../panels/SettingsDialog/Status.js'

export { buildDiagnostics }

type Props = {
  context: LocalJSXCommandContext
  diagnosticsPromise: Promise<Diagnostic[]>
}

export function Status({
  context,
  diagnosticsPromise,
}: Props): React.ReactNode {
  const mainLoopModel = useAppState(s => s.mainLoopModel)
  const mcp = useAppState(s => s.mcp)

  return (
    <StatusPanel
      context={context}
      diagnosticsPromise={diagnosticsPromise}
      mainLoopModel={mainLoopModel}
      mcpClients={mcp.clients}
    />
  )
}
