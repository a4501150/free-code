/**
 * Provider Registry
 *
 * Single source of truth for all provider/model resolution.
 * Replaces the scattered getAPIProvider() / ALL_MODEL_CONFIGS / modelStrings pattern
 * with a unified config-driven lookup.
 */

import type {
  ProviderAuthConfig,
  ProviderCacheConfig,
  ProviderCacheType,
  ProviderConfig,
  ProviderModelConfig,
  ProviderType,
} from '../settings/types.js'
import type { APIProvider } from './providers.js'

// ── Types ────────────────────────────────────────────────────────────

export interface ResolvedProvider {
  providerName: string
  config: ProviderConfig
  model: ProviderModelConfig
}

export interface ConfiguredModel {
  providerName: string
  config: ProviderConfig
  model: ProviderModelConfig
}

// ── Registry ─────────────────────────────────────────────────────────

let _instance: ProviderRegistry | null = null

export class ProviderRegistry {
  private readonly providers: Map<string, ProviderConfig>
  /** model ID or alias → [providerName, model config] */
  private readonly modelIndex: Map<
    string,
    { providerName: string; config: ProviderConfig; model: ProviderModelConfig }
  >

  constructor(providers: Record<string, ProviderConfig>) {
    this.providers = new Map(Object.entries(providers))
    this.modelIndex = new Map()
    this.buildIndex()
  }

  private buildIndex(): void {
    for (const [name, config] of this.providers) {
      for (const model of config.models) {
        // Index by model ID (always)
        if (!this.modelIndex.has(model.id)) {
          this.modelIndex.set(model.id, {
            providerName: name,
            config,
            model,
          })
        }
        // Index by alias (if set and not already taken)
        if (model.alias && !this.modelIndex.has(model.alias)) {
          this.modelIndex.set(model.alias, {
            providerName: name,
            config,
            model,
          })
        }
      }
    }
  }

  // ── Core lookups ─────────────────────────────────────────────────

  getProviderForModel(modelIdOrAlias: string): ResolvedProvider | null {
    // Strip [1m]/[2m] context suffix for lookup
    const normalized = modelIdOrAlias.replace(/\[\d+m\]$/, '')
    const entry = this.modelIndex.get(normalized)
    if (!entry) return null
    return {
      providerName: entry.providerName,
      config: entry.config,
      model: entry.model,
    }
  }

  getProvider(name: string): ProviderConfig | undefined {
    return this.providers.get(name)
  }

  getAllProviders(): Map<string, ProviderConfig> {
    return new Map(this.providers)
  }

  getAllModels(): ConfiguredModel[] {
    const result: ConfiguredModel[] = []
    for (const [name, config] of this.providers) {
      for (const model of config.models) {
        result.push({ providerName: name, config, model })
      }
    }
    return result
  }

  hasProviders(): boolean {
    return this.providers.size > 0
  }

  // ── Per-model queries ────────────────────────────────────────────

  getProviderCacheType(model: string): ProviderCacheType {
    const provider = this.getProviderForModel(model)
    return provider?.config.cache?.type ?? 'explicit-breakpoint'
  }

  getProviderType(model: string): ProviderType | null {
    const provider = this.getProviderForModel(model)
    return provider?.config.type ?? null
  }

  getProviderAuth(model: string): ProviderAuthConfig | undefined {
    const provider = this.getProviderForModel(model)
    return provider?.config.auth
  }

  /**
   * Returns true if the model is served by an Anthropic-native provider
   * (type: "anthropic") with the official Anthropic API URL.
   * Replaces `getAPIProvider() === 'firstParty' && isFirstPartyAnthropicBaseUrl()`.
   */
  isAnthropicNative(model: string): boolean {
    const provider = this.getProviderForModel(model)
    if (!provider) return false
    if (provider.config.type !== 'anthropic') return false
    const baseUrl = provider.config.baseUrl
    if (!baseUrl) return true // no baseUrl = official Anthropic API
    try {
      const host = new URL(baseUrl).host
      return host === 'api.anthropic.com'
    } catch {
      return false
    }
  }

  /**
   * Returns true if the model is served by an Anthropic-type provider
   * (could be official or a proxy).
   * Replaces `getAPIProvider() === 'firstParty'`.
   */
  isAnthropicType(model: string): boolean {
    const provider = this.getProviderForModel(model)
    if (!provider) return false
    return provider.config.type === 'anthropic'
  }

  /**
   * Returns true if the model is served by an official Anthropic URL
   * (either no baseUrl or api.anthropic.com).
   * Replaces `isFirstPartyAnthropicBaseUrl()`.
   */
  isOfficialAnthropicUrl(model: string): boolean {
    return this.isAnthropicNative(model)
  }

  /**
   * Returns a legacy APIProvider string for backward compatibility.
   * Used during the migration period so existing code that switches
   * on provider type continues to work.
   */
  getLegacyAPIProvider(model?: string): APIProvider {
    if (!model) {
      // No model specified — infer from the first provider
      const first = this.providers.entries().next()
      if (!first.done) {
        return this.providerTypeToLegacy(first.value[1].type)
      }
      return 'firstParty'
    }
    const provider = this.getProviderForModel(model)
    if (!provider) return 'firstParty'
    return this.providerTypeToLegacy(provider.config.type)
  }

  private providerTypeToLegacy(type: ProviderType): APIProvider {
    switch (type) {
      case 'anthropic':
        return 'firstParty'
      case 'bedrock-converse':
        return 'bedrock'
      case 'vertex':
        return 'vertex'
      case 'foundry':
        return 'foundry'
      case 'openai-responses':
      case 'openai-chat-completions':
        return 'openai'
      case 'gemini':
        return 'openai' // closest legacy equivalent
      default:
        return 'firstParty'
    }
  }

  // ── Convenience provider-type checks ──────────────────────────────
  // All accept an optional model string. When omitted, check the default
  // provider — correct for single-provider setups and backward compat.

  private resolveProviderType(model?: string): ProviderType | null {
    if (model) return this.getProviderType(model)
    return this.getDefaultProvider()?.config.type ?? null
  }

  /**
   * Returns true if the provider is a third-party cloud provider
   * (Bedrock, Vertex, or Foundry). Replaces `isUsing3PServices()`.
   */
  isThirdPartyCloudProvider(model?: string): boolean {
    const type = this.resolveProviderType(model)
    return (
      type === 'bedrock-converse' || type === 'vertex' || type === 'foundry'
    )
  }

  isBedrockProvider(model?: string): boolean {
    return this.resolveProviderType(model) === 'bedrock-converse'
  }

  isVertexProvider(model?: string): boolean {
    return this.resolveProviderType(model) === 'vertex'
  }

  isFoundryProvider(model?: string): boolean {
    return this.resolveProviderType(model) === 'foundry'
  }

  /**
   * Get the first provider's name and config.
   * Useful for code that just needs "the default provider".
   */
  getDefaultProvider(): { name: string; config: ProviderConfig } | null {
    const first = this.providers.entries().next()
    if (first.done) return null
    return { name: first.value[0], config: first.value[1] }
  }
}

// ── Singleton access ─────────────────────────────────────────────────

/**
 * Get or lazily initialize the provider registry.
 *
 * On first call, reads `providers` from settings.json. If absent,
 * falls back to auto-migration from legacy environment variables.
 */
export function getProviderRegistry(): ProviderRegistry {
  if (!_instance) {
    // Lazy init: import settings + migration at call time to avoid circular deps
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getInitialSettings } = require('../settings/settings.js') as {
      getInitialSettings: () => Record<string, unknown>
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { migrateFromLegacyEnvVars } = require('./legacyProviderMigration.js') as {
      migrateFromLegacyEnvVars: (opts?: {
        oauthTokens?: { accessToken: string } | null
      }) => Record<string, ProviderConfig>
    }

    const settings = getInitialSettings()

    if (settings.providers) {
      _instance = new ProviderRegistry(
        settings.providers as Record<string, ProviderConfig>,
      )
    } else {
      // Detect OAuth tokens for legacy migration.
      // Use lazy require to avoid circular dep (auth.ts → providers.ts → registry).
      let oauthTokens: { accessToken: string } | null = null
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { getClaudeAIOAuthTokens } = require('../auth.js') as {
          getClaudeAIOAuthTokens: () => { accessToken: string } | null
        }
        oauthTokens = getClaudeAIOAuthTokens()
      } catch {
        // Auth not available yet — proceed without OAuth detection
      }

      _instance = new ProviderRegistry(
        migrateFromLegacyEnvVars({ oauthTokens }),
      )
    }
  }
  return _instance
}

export function initProviderRegistry(
  providers: Record<string, ProviderConfig>,
): ProviderRegistry {
  _instance = new ProviderRegistry(providers)
  return _instance
}

export function resetProviderRegistry(): void {
  _instance = null
}
