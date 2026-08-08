/**
 * Provider Registry
 *
 * Single source of truth for all provider/model resolution.
 * Single source of truth for model identity, capabilities, and provider config.
 * with a unified config-driven lookup.
 */

import { getInitialSettings } from '../settings/settings.js'
import type {
  ProviderAuthConfig,
  ProviderCacheConfig,
  ProviderCacheType,
  ProviderCapabilities,
  ProviderConfig,
  ProviderModelConfig,
  ProviderType,
} from '../settings/types.js'
import {
  applyBedrockRegionPrefix,
  getBedrockRegionPrefix,
} from './bedrockInferenceProfiles.js'
import { parseModelString, stripContextSuffix } from './parseModelString.js'

// ── Capability defaults by provider type ──────────────────────────────

const ALL_FALSE_CAPABILITIES: Required<ProviderCapabilities> = {
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
  customSyspromptPrefix: true,
  // Granular decomposition defaults (false when firstPartyFeatures is false)
  supportsFastMode: false,
  showModelPricing: false,
  supportsOAuthProfile: false,
  supportsPolicyLimits: false,
  supportsSettingsSync: false,
  supportsTeamMemorySync: false,
  supportsBootstrap: false,
  supportsAfkMode: false,
  preservesReasoningAcrossTurns: false,
}

/**
 * Which caching mechanism each wire format actually supports, used when a
 * provider config does not pin `cache.type` explicitly.
 *
 * Anthropic-wire providers take explicit `cache_control` breakpoints — the
 * prompt-caching docs list the Claude API, AWS, Google Cloud and Microsoft
 * Foundry as supporting them. Bedrock Converse takes the same markers,
 * translated to `cachePoint` entries by its adapter. OpenAI and Gemini cache
 * prefixes server-side with no client markers at all, so emitting breakpoints
 * for them is dead weight.
 */
const DEFAULT_CACHE_TYPE_BY_PROVIDER: Record<ProviderType, ProviderCacheType> =
  {
    anthropic: 'explicit-breakpoint',
    vertex: 'explicit-breakpoint',
    foundry: 'explicit-breakpoint',
    'bedrock-converse': 'explicit-breakpoint',
    'openai-chat-completions': 'automatic-prefix',
    'openai-responses': 'automatic-prefix',
    gemini: 'automatic-prefix',
  }

const PROVIDER_CAPABILITY_DEFAULTS: Record<
  ProviderType,
  Required<ProviderCapabilities>
> = {
  anthropic: {
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
    customSyspromptPrefix: true,
    // All first-party features enabled on native Anthropic.
    supportsFastMode: true,
    showModelPricing: true,
    supportsOAuthProfile: true,
    supportsPolicyLimits: true,
    supportsSettingsSync: true,
    supportsTeamMemorySync: true,
    supportsBootstrap: true,
    supportsAfkMode: true,
    preservesReasoningAcrossTurns: true,
  },
  'bedrock-converse': {
    ...ALL_FALSE_CAPABILITIES,
    authManagedExternally: true,
    credentialRefresh: 'aws',
    tokenCountingMethod: 'bedrock-custom',
    // Converse rejects Anthropic beta HTTP headers; the accepted ones travel
    // in additionalModelRequestFields.anthropic_beta instead.
    betasInBody: true,
    regionPrefixPropagation: true,
    enrichModelIdErrors: true,
    // Converse returns signed `reasoningContent` blocks that must be replayed
    // verbatim and in position once thinking is enabled.
    preservesReasoningAcrossTurns: true,
  },
  vertex: {
    ...ALL_FALSE_CAPABILITIES,
    authManagedExternally: true,
    credentialRefresh: 'gcp',
    tokenCountingMethod: 'vertex-filtered',
    webSearch: true,
    customSyspromptPrefix: false,
    // Vertex-Anthropic preserves signed thinking blocks across turns.
    preservesReasoningAcrossTurns: true,
  },
  foundry: {
    ...ALL_FALSE_CAPABILITIES,
    authManagedExternally: true,
    opaqueDeploymentIds: true,
    webSearch: true,
    // Foundry exposes Anthropic-compatible endpoints and preserves signed
    // thinking blocks across turns.
    preservesReasoningAcrossTurns: true,
  },
  'openai-chat-completions': {
    ...ALL_FALSE_CAPABILITIES,
    // Which field carries reasoning differs per endpoint, so the adapter
    // remembers whichever one the response used and echoes back into that
    // same one. Set this false for an endpoint that rejects unknown
    // assistant-message fields.
    preservesReasoningAcrossTurns: true,
  },
  'openai-responses': {
    ...ALL_FALSE_CAPABILITIES,
    // The Codex adapter round-trips reasoning across turns by echoing
    // opaque `{type:"reasoning", id, encrypted_content, summary}` items in
    // `input[]` on each outbound request. The encrypted_content blob is
    // carried across turns on the reasoning block's `providerState`.
    preservesReasoningAcrossTurns: true,
  },
  gemini: {
    ...ALL_FALSE_CAPABILITIES,
    authManagedExternally: true,
    credentialRefresh: 'gcp' as const,
    // Gemini 3 rejects multi-step function calling when a thought signature
    // is missing, so signatures must be replayed on the parts that carry them.
    preservesReasoningAcrossTurns: true,
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
function deriveCapabilities(
  config: ProviderConfig,
): Required<ProviderCapabilities> {
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
  /** Qualified "providerName:modelId" → entry */
  private readonly qualifiedIndex: Map<
    string,
    { providerName: string; config: ProviderConfig; model: ProviderModelConfig }
  >
  /** canonical model ID → entry (e.g. 'claude-opus-4-6' → provider entry) */
  private readonly canonicalIdIndex: Map<
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

  /** Provider-qualified default model from freecode.json (e.g. "anthropic:claude-opus-4-6") */
  private readonly _defaultModel: string | undefined
  /** Provider-qualified default subagent model from freecode.json */
  private readonly _defaultSubagentModel: string | undefined
  /** Provider-qualified default small/fast model from freecode.json */
  private readonly _defaultSmallFastModel: string | undefined
  /** Provider-qualified available subagent models from freecode.json (max 3) */
  private readonly _availableSubagentModels: string[]
  /** Provider-qualified default balanced model from freecode.json */
  private readonly _defaultBalancedModel: string | undefined
  /** Provider-qualified default most-powerful model from freecode.json */
  private readonly _defaultMostPowerfulModel: string | undefined

  constructor(
    providers: Record<string, ProviderConfig>,
    opts?: {
      defaultModel?: string
      defaultSubagentModel?: string
      defaultSmallFastModel?: string
      availableSubagentModels?: string[]
      defaultBalancedModel?: string
      defaultMostPowerfulModel?: string
    },
  ) {
    this.providers = new Map(Object.entries(providers))
    this.qualifiedIndex = new Map()
    this.canonicalIdIndex = new Map()
    this.capabilitiesCache = new Map()
    this.providerNames = new Set(
      [...this.providers.keys()].map(n => n.toLowerCase()),
    )
    this._defaultModel = opts?.defaultModel
    this._defaultSubagentModel = opts?.defaultSubagentModel
    this._defaultSmallFastModel = opts?.defaultSmallFastModel
    this._availableSubagentModels = opts?.availableSubagentModels ?? []
    this._defaultBalancedModel = opts?.defaultBalancedModel
    this._defaultMostPowerfulModel = opts?.defaultMostPowerfulModel
    this.buildIndex()
  }

  private buildIndex(): void {
    for (const [name, config] of this.providers) {
      const lowerName = name.toLowerCase()
      for (const model of config.models) {
        const entry = { providerName: name, config, model }
        // Index by qualified "providerName:modelId"
        this.qualifiedIndex.set(`${lowerName}:${model.id}`, entry)
        // Index by canonical model ID (the bare model id string)
        const canonicalKey = model.id.toLowerCase()
        if (!this.canonicalIdIndex.has(canonicalKey)) {
          this.canonicalIdIndex.set(canonicalKey, entry)
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
   * Look up a provider entry by canonical model ID (e.g. 'claude-opus-4-6').
   * Returns the provider entry if found, or null if the canonical ID is not registered.
   */
  getModelByCanonicalId(canonicalId: string): ResolvedProvider | null {
    const entry = this.canonicalIdIndex.get(canonicalId.toLowerCase())
    if (!entry) return null
    return {
      providerName: entry.providerName,
      config: entry.config,
      model: entry.model,
    }
  }

  // ── Per-model queries ────────────────────────────────────────────

  getProviderCacheType(model: string): ProviderCacheType {
    const provider = this.getProviderForModel(model)
    if (provider?.config.cache?.type) return provider.config.cache.type
    // Default by wire format. Emitting explicit markers for a provider whose
    // adapter discards them is wasted work, and claiming 'none' for one that
    // caches automatically would misreport its usage.
    return provider?.config.type
      ? DEFAULT_CACHE_TYPE_BY_PROVIDER[provider.config.type]
      : 'explicit-breakpoint'
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

  getModelSelectedEffort(model: string): string | undefined {
    const provider = this.getProviderForModel(model)
    return provider?.model.selectedEffort
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
   * Resolve a boolean first-party capability with firstPartyFeatures as the
   * fallback. Used by call sites that previously read
   * `caps.firstPartyFeatures` directly — they now read the specific flag
   * and fall back to `firstPartyFeatures` for back-compat with existing
   * configs that only set the umbrella flag.
   */
  resolveFirstPartyCapability(
    model: string | undefined,
    cap:
      | 'supportsFastMode'
      | 'showModelPricing'
      | 'supportsOAuthProfile'
      | 'supportsPolicyLimits'
      | 'supportsSettingsSync'
      | 'supportsTeamMemorySync'
      | 'supportsBootstrap'
      | 'supportsAfkMode',
  ): boolean {
    const caps = this.getCapabilities(model)
    const specific = caps[cap]
    if (specific !== undefined && specific !== null) return !!specific
    return !!caps.firstPartyFeatures
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

  /**
   * Get the configured default model from freecode.json.
   * Returns a provider-qualified string (e.g. "anthropic:claude-opus-4-6") or undefined.
   */
  getConfiguredDefaultModel(): string | undefined {
    return this._defaultModel
  }

  /**
   * Get the configured default subagent model from freecode.json.
   * Returns a provider-qualified string or undefined.
   */
  getConfiguredDefaultSubagentModel(): string | undefined {
    return this._defaultSubagentModel
  }

  /**
   * Get the configured default small/fast model from freecode.json.
   * Returns a provider-qualified string or undefined.
   */
  getConfiguredDefaultSmallFastModel(): string | undefined {
    return this._defaultSmallFastModel
  }

  /**
   * Get the configured available subagent models from freecode.json.
   * Returns an array of provider-qualified model IDs (max 3), or empty if not configured.
   */
  getAvailableSubagentModels(): string[] {
    return this._availableSubagentModels
  }

  /**
   * Get the configured default balanced model from freecode.json.
   * Returns a provider-qualified string or undefined.
   */
  getConfiguredDefaultBalancedModel(): string | undefined {
    return this._defaultBalancedModel
  }

  /**
   * Get the configured default most-powerful model from freecode.json.
   * Returns a provider-qualified string or undefined.
   */
  getConfiguredDefaultMostPowerfulModel(): string | undefined {
    return this._defaultMostPowerfulModel
  }

  /**
   * Propagate a parent model's region prefix to a child model.
   * For Bedrock cross-region inference, the parent's region prefix
   * (e.g. "eu.", "us.") is applied to child models that lack one.
   * For all other providers, returns childModel unchanged.
   */
  propagateModelPrefix(parentModel: string, childModel: string): string {
    if (!this.getCapability(parentModel, 'regionPrefixPropagation')) {
      return childModel
    }
    const parentPrefix = getBedrockRegionPrefix(parentModel)
    if (!parentPrefix) return childModel
    // Don't override if child already has a prefix
    if (getBedrockRegionPrefix(childModel)) return childModel
    return applyBedrockRegionPrefix(childModel, parentPrefix)
  }
}

// ── Singleton access ─────────────────────────────────────────────────

/**
 * Get or lazily initialize the provider registry.
 *
 * Resolution order (registry is read-only with respect to disk):
 *   1. If `settings.providers` is present (from `freecode.json`), use it.
 *   2. If no providers are configured, the registry is empty. Users must
 *      configure providers in freecode.json (via migration or manually).
 */
export function getProviderRegistry(): ProviderRegistry {
  if (!_instance) {
    const settings = getInitialSettings()
    const settingsObj = settings as Record<string, unknown>

    const readStr = (key: string): string | undefined =>
      typeof settingsObj[key] === 'string'
        ? stripContextSuffix(settingsObj[key] as string)
        : undefined

    const availableSubagentModels = Array.isArray(
      settingsObj.availableSubagentModels,
    )
      ? (settingsObj.availableSubagentModels as string[])
      : undefined

    _instance = new ProviderRegistry(
      (settings.providers ?? {}) as Record<string, ProviderConfig>,
      {
        defaultModel: readStr('defaultModel'),
        defaultSubagentModel: readStr('defaultSubagentModel'),
        defaultSmallFastModel: readStr('defaultSmallFastModel'),
        availableSubagentModels,
        defaultBalancedModel: readStr('defaultBalancedModel'),
        defaultMostPowerfulModel: readStr('defaultMostPowerfulModel'),
      },
    )
  }
  return _instance
}

export function initProviderRegistry(
  providers: Record<string, ProviderConfig>,
  opts?: {
    defaultModel?: string
    defaultSubagentModel?: string
    defaultSmallFastModel?: string
    availableSubagentModels?: string[]
    defaultBalancedModel?: string
    defaultMostPowerfulModel?: string
  },
): ProviderRegistry {
  _instance = new ProviderRegistry(providers, opts)
  return _instance
}

export function resetProviderRegistry(): void {
  _instance = null
}
