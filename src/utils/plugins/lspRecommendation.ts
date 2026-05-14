/**
 * LSP Plugin Recommendation Utility
 *
 * Phase C removes LSP recommendation operational state, so recommendation
 * behavior is intentionally disabled while preserving public exports.
 */

/**
 * LSP plugin recommendation returned to the caller
 */
export type LspPluginRecommendation = {
  pluginId: string // "plugin-name@marketplace-name"
  pluginName: string // Human-readable plugin name
  marketplaceName: string // Marketplace name
  description?: string // Plugin description
  isOfficial: boolean // From official marketplace?
  extensions: string[] // File extensions this plugin supports
  command: string // LSP server command (e.g., "typescript-language-server")
}

/**
 * Find matching LSP plugins for a file path.
 */
export async function getMatchingLspPlugins(
  _filePath: string,
): Promise<LspPluginRecommendation[]> {
  return []
}

/**
 * Add a plugin to the "never suggest" list.
 */
export function addToNeverSuggest(_pluginId: string): void {}

/**
 * Increment the ignored recommendation count.
 */
export function incrementIgnoredCount(): void {}

/**
 * Check if LSP recommendations are disabled.
 */
export function isLspRecommendationsDisabled(): boolean {
  return false
}

/**
 * Reset the ignored count.
 */
export function resetIgnoredCount(): void {}
