/**
 * Surfaces plugin-install prompts driven by `<claude-code-hint />` tags.
 *
 * Phase C disables Claude Code hint recommendations entirely.
 */

import type { PluginHintRecommendation } from '../utils/plugins/hintRecommendation.js'

type UseClaudeCodeHintRecommendationResult = {
  recommendation: PluginHintRecommendation | null
  handleResponse: (response: 'yes' | 'no' | 'disable') => void
}

export function useClaudeCodeHintRecommendation(): UseClaudeCodeHintRecommendationResult {
  return { recommendation: null, handleResponse: () => {} }
}
