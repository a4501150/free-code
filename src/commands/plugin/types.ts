/**
 * Shared types for the /plugin slash command flow. `ViewState` is a
 * discriminated union enumerating every screen the plugin menu can
 * display; variants / optional fields are derived from every
 * `setViewState(…)` call and `viewState.type === …` check in
 * src/commands/plugin/*.
 */

export type ViewState =
  | { type: 'menu' }
  | {
      type: 'discover-plugins'
      targetPlugin?: string
    }
  | {
      type: 'manage-plugins'
      targetPlugin?: string
      targetMarketplace?: string
      action?: 'enable' | 'disable' | 'uninstall'
    }
  | {
      type: 'manage-marketplaces'
      targetMarketplace?: string
      action?: 'remove' | 'update'
    }
  | {
      type: 'add-marketplace'
      initialValue?: string
    }
  | {
      type: 'browse-marketplace'
      targetMarketplace: string
      targetPlugin?: string
    }
  | { type: 'marketplace-menu' }
  | { type: 'marketplace-list' }
  | { type: 'help' }
  | { type: 'validate'; path: string }

/**
 * Props for the top-level `<PluginSettings>` component.
 */
export type PluginSettingsProps = {
  onComplete: (result?: string) => void
  args: string[]
}
