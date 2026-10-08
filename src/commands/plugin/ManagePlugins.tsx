/**
 * REPL host adapter for the /plugin Installed tab: reads MCP clients, MCP
 * tools and plugin errors from AppState and delegates rendering to the
 * host-agnostic panels/PluginDialog/ManagePlugins component.
 */

import * as React from 'react'
import { ManagePlugins as ManagePluginsPanel } from '../../components/panels/PluginDialog/ManagePlugins.js'
import { useAppState } from '../../state/AppState.js'
import type { ViewState as ParentViewState } from './types.js'

type Props = {
  setViewState: (state: ParentViewState) => void
  setResult: (result: string | null) => void
  onManageComplete?: () => void | Promise<void>
  onSearchModeChange?: (isActive: boolean) => void
  targetPlugin?: string
  targetMarketplace?: string
  action?: 'enable' | 'disable' | 'uninstall'
}

export function ManagePlugins({
  setViewState,
  setResult,
  onManageComplete,
  onSearchModeChange,
  targetPlugin,
  targetMarketplace,
  action,
}: Props): React.ReactNode {
  const mcpClients = useAppState(s => s.mcp.clients)
  const mcpTools = useAppState(s => s.mcp.tools)
  const pluginErrors = useAppState(s => s.plugins.errors)
  return (
    <ManagePluginsPanel
      setViewState={setViewState}
      setResult={setResult}
      onManageComplete={onManageComplete}
      onSearchModeChange={onSearchModeChange}
      targetPlugin={targetPlugin}
      targetMarketplace={targetMarketplace}
      action={action}
      mcpClients={mcpClients}
      mcpTools={mcpTools}
      pluginErrors={pluginErrors}
    />
  )
}
