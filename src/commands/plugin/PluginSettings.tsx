/**
 * REPL host adapter for the /plugin menu: reads MCP clients, MCP tools,
 * plugin errors and the background marketplace install status from AppState,
 * wires the two store write-backs (needsRefresh marking, marketplace error
 * resolution) with the byte-identical updaters, and delegates rendering to
 * the host-agnostic panels/PluginDialog/PluginSettings component.
 */

import * as React from 'react'
import { useCallback } from 'react'
import { PluginSettings as PluginSettingsPanel } from '../../components/panels/PluginDialog/PluginSettings.js'
import { useAppState, useSetAppState } from '../../state/AppState.js'
import type { PluginSettingsProps } from './types.js'

export function PluginSettings({
  onComplete,
  args,
}: PluginSettingsProps): React.ReactNode {
  const setAppState = useSetAppState()
  const mcpClients = useAppState(s => s.mcp.clients)
  const mcpTools = useAppState(s => s.mcp.tools)
  const pluginErrors = useAppState(s => s.plugins.errors)
  const installationStatus = useAppState(s => s.plugins.installationStatus)

  /**
   * Signal that plugin state has changed on disk (Layer 2) and active
   * components (Layer 3) are stale. User runs /reload-plugins to apply.
   * Previously this was updatePluginState() which did a partial refresh
   * (commands only — agents/hooks/MCP were silently skipped). Now all
   * Layer-3 refresh flows through the unified refreshActivePlugins()
   * primitive via /reload-plugins, giving one consistent mental model:
   * plugin changes require /reload-plugins.
   */
  const markPluginsChanged = useCallback(() => {
    setAppState(prev =>
      prev.plugins.needsRefresh
        ? prev
        : { ...prev, plugins: { ...prev.plugins, needsRefresh: true } },
    )
  }, [setAppState])

  /**
   * Synchronously clear all stale state for a removed extraKnownMarketplace
   * so the Errors tab updates glitch-free — the authoritative cleanup until
   * the user runs /reload-plugins.
   */
  const resolveMarketplaceError = useCallback(
    (marketplaceName: string) => {
      setAppState(prev => ({
        ...prev,
        plugins: {
          ...prev.plugins,
          errors: prev.plugins.errors.filter(
            e => !('marketplace' in e && e.marketplace === marketplaceName),
          ),
          installationStatus: {
            ...prev.plugins.installationStatus,
            marketplaces: prev.plugins.installationStatus.marketplaces.filter(
              m => m.name !== marketplaceName,
            ),
          },
        },
      }))
    },
    [setAppState],
  )

  return (
    <PluginSettingsPanel
      onComplete={onComplete}
      args={args}
      mcpClients={mcpClients}
      mcpTools={mcpTools}
      pluginErrors={pluginErrors}
      installationStatus={installationStatus}
      onMarkPluginsChanged={markPluginsChanged}
      onMarketplaceErrorResolved={resolveMarketplaceError}
    />
  )
}
