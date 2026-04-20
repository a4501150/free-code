import type { ConnectedMCPServer } from '../../components/mcp/types.js'
import type { LoadedPlugin, PluginError } from '../../types/plugin.js'

/** Display-only UI scope for installed items. Superset of ConfigScope for
 *  plugins (`builtin`, `flagged`, `enterprise`) and of MCP ConfigScope. */
export type UnifiedInstalledItemScope =
  | 'user'
  | 'project'
  | 'local'
  | 'dynamic'
  | 'managed'
  | 'enterprise'
  | 'builtin'
  | 'flagged'
  | 'claudeai'

/**
 * Items rendered by the Manage-Plugins list. See
 * src/commands/plugin/UnifiedInstalledCell.tsx for render logic and
 * src/commands/plugin/ManagePlugins.tsx for all construction sites.
 */
export type UnifiedInstalledItem =
  | {
      type: 'plugin'
      id: string
      name: string
      description?: string
      marketplace: string
      scope: UnifiedInstalledItemScope
      isEnabled: boolean
      errorCount: number
      errors: PluginError[]
      plugin: LoadedPlugin
      pendingEnable?: boolean
      pendingUpdate?: boolean
      pendingToggle?: 'will-enable' | 'will-disable'
    }
  | {
      type: 'flagged-plugin'
      id: string
      name: string
      marketplace: string
      scope: UnifiedInstalledItemScope
      reason: string
      text: string
      flaggedAt?: string
    }
  | {
      type: 'failed-plugin'
      id: string
      name: string
      marketplace: string
      scope: UnifiedInstalledItemScope
      errorCount: number
      errors: PluginError[]
    }
  | {
      type: 'mcp'
      id: string
      name: string
      description?: string
      scope: UnifiedInstalledItemScope
      status:
        | 'connected'
        | 'disabled'
        | 'pending'
        | 'needs-auth'
        | 'failed'
        | string
      client: ConnectedMCPServer
      /** Render the row indented under its parent plugin. */
      indented?: boolean
    }
