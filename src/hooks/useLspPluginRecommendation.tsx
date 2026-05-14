/**
 * Hook for LSP plugin recommendations.
 *
 * Phase C disables LSP plugin recommendations entirely.
 */

export type LspRecommendationState = {
  pluginId: string
  pluginName: string
  pluginDescription?: string
  fileExtension: string
  shownAt: number // Timestamp for timeout detection
} | null

type UseLspPluginRecommendationResult = {
  recommendation: LspRecommendationState
  handleResponse: (response: 'yes' | 'no' | 'never' | 'disable') => void
}

export function useLspPluginRecommendation(): UseLspPluginRecommendationResult {
  return { recommendation: null, handleResponse: () => {} }
}
