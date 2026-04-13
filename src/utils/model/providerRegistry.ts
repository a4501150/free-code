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
import { parseModelString } from './parseModelString.js'

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
  webSearch: false,
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
    webSearch: true,
  },
  'bedrock-converse': {
    globalCacheScope: false,
    eagerInputStreaming: false,
    clientRequestId: false,
    betasInBody: false,
    authManagedExternally: true,
    credentialRefresh: 'aws',
    firstPartyFeatures: false,
    tokenCountingMethod: 'bedrock-custom',
    opaqueDeploymentIds: false,
    regionPrefixPropagation: true,
    enrichModelIdErrors: true,
    webSearch: false,
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
    webSearch: true,
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
    webSearch: true,
  },
  'openai-chat-completions': { ...ALL_FALSE_CAPABILITIES },
  'openai-responses': { ...ALL_FALSE_CAPABILITIES },
  gemini: {
    ...ALL_FALSE_CAPABILITIES,
    authManagedExternally: true,
    credentialRefresh: 'gcp' as const,
  },
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
  /** Qualified "providerName:modelId" or "providerName:alias" → entry */
  private readonly qualifiedIndex: Map<
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
  /** Set of all provider names (lowercased) for the parser */
  private readonly providerNames: Set<string>

  constructor(providers: Record<string, ProviderConfig>) {
    this.providers = new Map(Object.entries(providers))
    this.qualifiedIndex = new Map()
    this.modelKeyIndex = new Map()
    this.capabilitiesCache = new Map()
    this.providerNames = new Set(
      [...this.providers.keys()].map((n) => n.toLowerCase()),
    )
    this.buildIndex()
  }

  private buildIndex(): void {
    for (const [name, config] of this.providers) {
      const lowerName = name.toLowerCase()
      for (const model of config.models) {
        const entry = { providerName: name, config, model }
        // Index by qualified "providerName:modelId"
        this.qualifiedIndex.set(`${lowerName}:${model.id}`, entry)
        // Index by qualified alias "providerName:alias"
        if (model.alias) {
          this.qualifiedIndex.set(`${lowerName}:${model.alias}`, entry)
        }
        // Index by modelKey (if set and not already taken)
        if (model.modelKey && !this.modelKeyIndex.has(model.modelKey)) {
          this.modelKeyIndex.set(model.modelKey, entry)
        }
      }
    }
  }

  // ── Core lookups ─────────────────────────────────────────────────

  /**
   * Get the set of registered provider names (lowercased).
   * Used by parseModelString() to identify provider prefixes.
   */
  getProviderNames(): Set<string> {
    return this.providerNames
  }

  /**
   * Get the name of the default (first) provider.
   */
  getDefaultProviderName(): string | null {
    const first = this.providers.keys().next()
    if (first.done) return null
    return first.value
  }

  getProviderForModel(qualifiedModel: string): ResolvedProvider | null {
    const parsed = parseModelString(
      qualifiedModel,
      this.providerNames,
      this.getDefaultProviderName() ?? '',
    )
    const key = `${parsed.provider.toLowerCase()}:${parsed.modelId}`
    const entry = this.qualifiedIndex.get(key)
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

  // ── Per-model config queries ──────────────────────────────────────

  getModelEffortLevels(model: string): string[] | undefined {
    const provider = this.getProviderForModel(model)
    return provider?.model.effortLevels
  }

  getModelDefaultEffort(model: string): string | undefined {
    const provider = this.getProviderForModel(model)
    return provider?.model.defaultEffort
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
   * Get a per-model capability flag from the provider config.
   * Returns the boolean value if the flag exists on the model config,
   * or undefined if not set (caller should fall back to hardcoded logic).
   */
  getModelFlag(
    model: string,
    flag: keyof ProviderModelConfig,
  ): boolean | undefined {
    const resolved = this.getProviderForModel(model)
    if (!resolved) return undefined
    const value = resolved.model[flag]
    return typeof value === 'boolean' ? value : undefined
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
 * Resolution order:
 * 1. settings.json `providers` field (explicit user config, highest priority)
 * 2. ~/.claude/providers.json (persisted migration / login result)
 * 3. Legacy env var migration → persist to providers.json for next run
 */
export function getProviderRegistry(): ProviderRegistry {
  if (!_instance) {
    // Lazy init: import at call time to avoid circular deps
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
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readProvidersFile, writeProvidersFile } = require('./providersFile.js') as {
      readProvidersFile: () => Record<string, ProviderConfig> | null
      writeProvidersFile: (providers: Record<string, ProviderConfig>) => void
    }

    const settings = getInitialSettings()

    if (settings.providers) {
      // Explicit config in settings.json — highest priority
      _instance = new ProviderRegistry(
        settings.providers as Record<string, ProviderConfig>,
      )
    } else {
      // Read from providers.json (single source of truth)
      const persisted = readProvidersFile()

      if (persisted && Object.keys(persisted).length > 0) {
        _instance = new ProviderRegistry(persisted)
      } else {
        // First run or empty file — migrate from env vars and persist
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

        const migrated = migrateFromLegacyEnvVars({ oauthTokens })
        _instance = new ProviderRegistry(migrated)

        // Persist so next run skips migration
        writeProvidersFile(migrated)
      }
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
