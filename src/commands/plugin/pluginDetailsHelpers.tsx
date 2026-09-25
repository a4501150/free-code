/**
 * Shared helper functions and types for plugin details views
 *
 * Used by both DiscoverPlugins and BrowseMarketplace components.
 */

import * as React from 'react'
import { readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { ConfigurableShortcutHint } from '../../components/ConfigurableShortcutHint.js'
import { Byline } from '../../components/design-system/Byline.js'
import { Box, Text } from '../../ink.js'
import { pathExists } from '../../utils/file.js'
import { loadKnownMarketplacesConfigSafe } from '../../utils/plugins/marketplaceManager.js'
import type { PluginMarketplaceEntry } from '../../utils/plugins/schemas.js'

/**
 * Represents a plugin available for installation from a marketplace
 */
export type InstallablePlugin = {
  entry: PluginMarketplaceEntry
  marketplaceName: string
  pluginId: string
  isInstalled: boolean
}

/**
 * Menu option for plugin details view
 */
export type PluginDetailsMenuOption = {
  label: string
  action: string
}

/**
 * Extract GitHub repo info from a plugin's source
 */
export function extractGitHubRepo(plugin: InstallablePlugin): string | null {
  const isGitHub =
    plugin.entry.source &&
    typeof plugin.entry.source === 'object' &&
    'source' in plugin.entry.source &&
    plugin.entry.source.source === 'github'

  if (
    isGitHub &&
    typeof plugin.entry.source === 'object' &&
    'repo' in plugin.entry.source
  ) {
    return plugin.entry.source.repo
  }

  return null
}

/**
 * Build menu options for plugin details view with scoped installation options
 */
export function buildPluginDetailsMenuOptions(
  hasHomepage: string | undefined,
  githubRepo: string | null,
): PluginDetailsMenuOption[] {
  const options: PluginDetailsMenuOption[] = [
    { label: 'Install for you (user scope)', action: 'install-user' },
    {
      label: 'Install for all collaborators on this repository (project scope)',
      action: 'install-project',
    },
    {
      label: 'Install for you, in this repo only (local scope)',
      action: 'install-local',
    },
  ]
  if (hasHomepage) {
    options.push({ label: 'Open homepage', action: 'homepage' })
  }
  if (githubRepo) {
    options.push({ label: 'View on GitHub', action: 'github' })
  }
  options.push({ label: 'Back to plugin list', action: 'back' })
  return options
}

/**
 * Key hint component for plugin selection screens
 */
export function PluginSelectionKeyHint({
  hasSelection,
}: {
  hasSelection: boolean
}): React.ReactNode {
  return (
    <Box marginTop={1}>
      <Text dimColor italic>
        <Byline>
          {hasSelection && (
            <ConfigurableShortcutHint
              action="plugin:install"
              context="Plugin"
              description="install"
              bold
            />
          )}
          <ConfigurableShortcutHint
            action="plugin:toggle"
            context="Plugin"
            description="toggle"
          />
          <ConfigurableShortcutHint
            action="select:accept"
            context="Select"
            description="details"
          />
          <ConfigurableShortcutHint
            action="confirm:no"
            context="Confirmation"
            description="back"
          />
        </Byline>
      </Text>
    </Box>
  )
}

/**
 * Component summary for plugins with a local ('./') marketplace source:
 * scans the plugin directory on disk (commands/, agents/, skills/, hooks/,
 * .mcp.json) instead of showing the "discovered at installation" placeholder.
 * Remote sources can't be summarized without downloading them.
 */
export function LocalPluginComponents({
  plugin,
}: {
  plugin: InstallablePlugin
}): React.ReactNode {
  const source = plugin.entry.source
  const isLocalPath = typeof source === 'string' && source.startsWith('./')
  const [summary, setSummary] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!isLocalPath || typeof source !== 'string') {
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const config = await loadKnownMarketplacesConfigSafe()
        const installLocation = config[plugin.marketplaceName]?.installLocation
        if (!installLocation) {
          return
        }
        const dir = resolve(installLocation, source)
        const countIn = async (sub: string, ext: string) => {
          try {
            const entries = await readdir(dir + '/' + sub, {
              recursive: true,
            })
            return entries.filter(e => e.endsWith(ext)).length
          } catch {
            return 0
          }
        }
        const [commands, agents, skills] = await Promise.all([
          countIn('commands', '.md'),
          countIn('agents', '.md'),
          countIn('skills', '.md'),
        ])
        const [hasHooks, hasMcpConfig] = await Promise.all([
          pathExists(join(dir, 'hooks', 'hooks.json')),
          pathExists(join(dir, '.mcp.json')),
        ])
        const parts: string[] = []
        if (commands > 0) parts.push(`${commands} command(s)`)
        if (agents > 0) parts.push(`${agents} agent(s)`)
        if (skills > 0) parts.push(`${skills} skill(s)`)
        if (hasHooks) parts.push('hooks')
        if (hasMcpConfig) parts.push('MCP config')
        if (!cancelled) {
          setSummary(
            parts.length > 0
              ? `Components: ${parts.join(', ')} (from local directory)`
              : 'No components found in local directory',
          )
        }
      } catch {
        // Scan failure keeps the installation-time placeholder.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [plugin.marketplaceName, source, isLocalPath])

  if (!isLocalPath) {
    return null
  }
  return (
    <Text dimColor>
      · {summary ?? 'Components will be discovered at installation'}
    </Text>
  )
}
