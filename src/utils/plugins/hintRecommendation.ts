/**
 * Plugin-hint recommendations.
 *
 * Phase C removes Claude Code hint operational state, so hint recommendation
 * behavior is intentionally disabled while preserving public exports.
 */

import type { ClaudeCodeHint } from '../claudeCodeHints.js'

export type PluginHintRecommendation = {
  pluginId: string
  pluginName: string
  marketplaceName: string
  pluginDescription?: string
  sourceCommand: string
}

/**
 * Pre-store gate called by shell tools when a `type="plugin"` hint is detected.
 */
export function maybeRecordPluginHint(_hint: ClaudeCodeHint): void {}

/** Test-only reset. */
export function _resetHintRecommendationForTesting(): void {}

/**
 * Resolve the pending hint to a renderable recommendation.
 */
export async function resolvePluginHint(
  _hint: ClaudeCodeHint,
): Promise<PluginHintRecommendation | null> {
  return null
}

/**
 * Record that a prompt for this plugin was surfaced.
 */
export function markHintPluginShown(_pluginId: string): void {}

/** Called when the user picks "don't show plugin installation hints again". */
export function disableHintRecommendations(): void {}
