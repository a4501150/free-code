/**
 * Provider Registry
 *
 * Single source of truth for all provider/model resolution.
 * Single source of truth for model identity, capabilities, and provider config.
 * with a unified config-driven lookup.
 */

import type {
  ProviderAuthConfig,
  ProviderCacheConfig,
  ProviderCacheType,
  ProviderCapabilities,
  ProviderConfig,
  ProviderModelConfig,
  ProviderType,
} from '../settings/types.js'

// ── Capability defaults by provider type ──────────────────────────────

const ALL_FALSE_CAPABILITIES: Required<ProviderCapabilities> = {
  globalCacheScope: false,
  eagerInputStreaming: false,
  clientRequestId: false,
  betasInBody: false,
  authManagedExternally: false,
  credentialRefresh: 'none',
  firstPartyFeatures: false,
  tokenCountingMethod: 'native',
  opaqueDeploymentIds: false,
  regionPrefixPropagation: false,
  enrichModelIdErrors: false,
}

const PROVIDER_CAPABILITY_DEFAULTS: Record<
  ProviderType,
  Required<ProviderCapabilities>
> = {
  anthropic: {
    globalCacheScope: true,
    eagerInputStreaming: true,
    clientRequestId: true,
    betasInBody: false,
    authManagedExternally: false,
    credentialRefresh: 'none',
    firstPartyFeatures: true,
    tokenCountingMethod: 'native',
    opaqueDeploymentIds: false,
    regionPrefixPropagation: false,
    enrichModelIdErrors: false,
  },
  'bedrock-converse': {
    globalCacheScope: false,
    eagerInputStreaming: false,
    clientRequestId: false,
    betasInBody: true,
    authManagedExternally: true,
    credentialRefresh: 'aws',
    firstPartyFeatures: false,
    tokenCountingMethod: 'bedrock-custom',
    opaqueDeploymentIds: false,
    regionPrefixPropagation: true,
    enrichModelIdErrors: true,
  },
  vertex: {
    globalCacheScope: false,
    eagerInputStreaming: false,
    clientRequestId: false,
    betasInBody: false,
    authManagedExternally: true,
    credentialRefresh: 'gcp',
    firstPartyFeatures: false,
    tokenCountingMethod: 'vertex-filtered',
    opaqueDeploymentIds: false,
    regionPrefixPropagation: false,
    enrichModelIdErrors: false,
  },
  foundry: {
    globalCacheScope: false,
    eagerInputStreaming: false,
    clientRequestId: false,
    betasInBody: false,
    authManagedExternally: true,
    credentialRefresh: 'none',
    firstPartyFeatures: false,
    tokenCountingMethod: 'native',
    opaqueDeploymentIds: true,
    regionPrefixPropagation: false,
    enrichModelIdErrors: false,
  },
  'openai-chat-completions': { ...ALL_FALSE_CAPABILITIES },
  'openai-responses': { ...ALL_FALSE_CAPABILITIES },
  gemini: { ...ALL_FALSE_CAPABILITIES },
}

/**
 * Check if an Anthropic provider config points to the official API URL.
 * Used to distinguish native Anthropic from proxy setups.
 */
function isOfficialAnthropicBaseUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) return true // no baseUrl = official Anthropic API
  try {
    return new URL(baseUrl).host === 'api.anthropic.com'
  } catch {
    return false
  }
}

/**
 * Derive fully-resolved capabilities for a provider config.
 * Starts from type-based defaults, adjusts for Anthropic proxies,
 * then merges any explicit config.capabilities overrides.
 */
function deriveCapabilities(config: ProviderConfig): Required<ProviderCapabilities> {
  const defaults = PROVIDER_CAPABILITY_DEFAULTS[config.type] ?? {
    ...ALL_FALSE_CAPABILITIES,
  }

  // Anthropic proxies (non-official baseUrl) lose first-party-only features
  let base = { ...defaults }
  if (
    config.type === 'anthropic' &&
    !isOfficialAnthropicBaseUrl(config.baseUrl)
  ) {
    base = {
      ...base,
      globalCacheScope: false,
      eagerInputStreaming: false,
      clientRequestId: false,
      firstPartyFeatures: false,
    }
  }

  // Merge explicit overrides from config.capabilities
  if (config.capabilities) {
    for (const [key, value] of Object.entries(config.capabilities)) {
      if (value !== undefined) {
        ;(base as Record<string, unknown>)[key] = value
      }
    }
  }

  return base
}

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
  /** modelKey → [providerName, model config] */
  private readonly modelKeyIndex: Map<
    string,
    { providerName: string; config: ProviderConfig; model: ProviderModelConfig }
  >
  /** provider name → resolved capabilities (cached) */
  private readonly capabilitiesCache: Map<
    string,
    Required<ProviderCapabilities>
  >

  constructor(providers: Record<string, ProviderConfig>) {
    this.providers = new Map(Object.entries(providers))
    this.modelIndex = new Map()
    this.modelKeyIndex = new Map()
    this.capabilitiesCache = new Map()
    this.buildIndex()
  }

  private buildIndex(): void {
    for (const [name, config] of this.providers) {
      for (const model of config.models) {
        const entry = { providerName: name, config, model }
        // Index by model ID (always)
        if (!this.modelIndex.has(model.id)) {
          this.modelIndex.set(model.id, entry)
        }
        // Index by alias (if set and not already taken)
        if (model.alias && !this.modelIndex.has(model.alias)) {
          this.modelIndex.set(model.alias, entry)
        }
        // Index by modelKey (if set and not already taken)
        if (model.modelKey && !this.modelKeyIndex.has(model.modelKey)) {
          this.modelKeyIndex.set(model.modelKey, entry)
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

  /**
   * Look up a model's provider-specific ID by its modelKey (e.g. 'opus46' → 'claude-opus-4-6').
   * Returns undefined if no model with that key is registered.
   */
  getModelIdByKey(key: string): string | undefined {
    return this.modelKeyIndex.get(key)?.model.id
  }

  /**
   * Get all registered modelKey → model ID mappings.
   * Used by modelStrings.ts to build the full ModelStrings record.
   */
  getModelKeyEntries(): Map<string, string> {
    const result = new Map<string, string>()
    for (const [key, entry] of this.modelKeyIndex) {
      result.set(key, entry.model.id)
    }
    return result
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

  // ── Capability queries ──────────────────────────────────────────────

  /**
   * Get the fully-resolved capabilities for a provider, identified by model.
   * When no model is given, returns capabilities for the default provider.
   * Capabilities are auto-derived from provider type and cached.
   */
  getCapabilities(model?: string): Required<ProviderCapabilities> {
    const resolved = model
      ? this.getProviderForModel(model)
      : (() => {
          const def = this.getDefaultProvider()
          return def
            ? { providerName: def.name, config: def.config, model: undefined }
            : null
        })()

    if (!resolved) return { ...ALL_FALSE_CAPABILITIES }

    const cached = this.capabilitiesCache.get(resolved.providerName)
    if (cached) return { ...cached }

    const caps = deriveCapabilities(resolved.config)
    this.capabilitiesCache.set(resolved.providerName, caps)
    return { ...caps }
  }

  /**
   * Get a single capability value for a provider, identified by model.
   */
  getCapability<K extends keyof Required<ProviderCapabilities>>(
    model: string,
    cap: K,
  ): Required<ProviderCapabilities>[K] {
    return this.getCapabilities(model)[cap]
  }

  /**
   * Returns true if the model is served by an Anthropic-type provider
   * (could be official or a proxy). Use this to check if the provider
   * speaks the Anthropic Messages API wire format.
   */
  isAnthropicType(model: string): boolean {
    const provider = this.getProviderForModel(model)
    if (!provider) return false
    return provider.config.type === 'anthropic'
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
