import { getProviderRegistry } from '../../utils/model/providerRegistry.js'

export type CachedMCConfig = {
  enabled: boolean
  triggerThreshold: number
  keepRecent: number
  supportedModels: string[]
  systemPromptSuggestSummaries: boolean
}

function getSupportedModels(): string[] {
  try {
    return getProviderRegistry()
      .getAllModels()
      .filter(m => m.model.serverContextManagement)
      .map(m => m.model.id)
  } catch {
    // Registry not available yet — use hardcoded fallback
    return ['claude-opus-4-6', 'claude-sonnet-4-6']
  }
}

export function getCachedMCConfig(): CachedMCConfig {
  return {
    enabled: false,
    triggerThreshold: 12,
    keepRecent: 3,
    supportedModels: getSupportedModels(),
    systemPromptSuggestSummaries: false,
  }
}
