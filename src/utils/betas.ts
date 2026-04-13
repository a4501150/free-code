import { feature } from 'bun:bundle'
import memoize from 'lodash-es/memoize.js'
import { getIsNonInteractiveSession, getSdkBetas } from '../bootstrap/state.js'
import {
  BEDROCK_EXTRA_PARAMS_HEADERS,
  CLAUDE_CODE_20250219_BETA_HEADER,
  CONTEXT_1M_BETA_HEADER,
  CONTEXT_MANAGEMENT_BETA_HEADER,
  INTERLEAVED_THINKING_BETA_HEADER,
  PROMPT_CACHING_SCOPE_BETA_HEADER,
  REDACT_THINKING_BETA_HEADER,
  STRUCTURED_OUTPUTS_BETA_HEADER,
  TOOL_SEARCH_BETA_HEADER_1P,
  TOOL_SEARCH_BETA_HEADER_3P,
  WEB_SEARCH_BETA_HEADER,
} from '../constants/betas.js'
import { OAUTH_BETA_HEADER } from '../constants/oauth.js'
import { isClaudeAISubscriber } from './auth.js'
import { has1mContext } from './context.js'
import { isEnvTruthy } from './envUtils.js'
import { getCanonicalName } from './model/model.js'

import { getProviderRegistry } from './model/providerRegistry.js'
import { getInitialSettings } from './settings/settings.js'

/**
 * SDK-provided betas that are allowed for API key users.
 * Only betas in this list can be passed via SDK options.
 */
const ALLOWED_SDK_BETAS = [CONTEXT_1M_BETA_HEADER]

/**
 * Filter betas to only include those in the allowlist.
 * Returns allowed and disallowed betas separately.
 */
function partitionBetasByAllowlist(betas: string[]): {
  allowed: string[]
  disallowed: string[]
} {
  const allowed: string[] = []
  const disallowed: string[] = []
  for (const beta of betas) {
    if (ALLOWED_SDK_BETAS.includes(beta)) {
      allowed.push(beta)
    } else {
      disallowed.push(beta)
    }
  }
  return { allowed, disallowed }
}

/**
 * Filter SDK betas to only include allowed ones.
 * Warns about disallowed betas and subscriber restrictions.
 * Returns undefined if no valid betas remain or if user is a subscriber.
 */
export function filterAllowedSdkBetas(
  sdkBetas: string[] | undefined,
): string[] | undefined {
  if (!sdkBetas || sdkBetas.length === 0) {
    return undefined
  }

  if (isClaudeAISubscriber()) {
    // biome-ignore lint/suspicious/noConsole: intentional warning
    console.warn(
      'Warning: Custom betas are only available for API key users. Ignoring provided betas.',
    )
    return undefined
  }

  const { allowed, disallowed } = partitionBetasByAllowlist(sdkBetas)
  for (const beta of disallowed) {
    // biome-ignore lint/suspicious/noConsole: intentional warning
    console.warn(
      `Warning: Beta header '${beta}' is not allowed. Only the following betas are supported: ${ALLOWED_SDK_BETAS.join(', ')}`,
    )
  }
  return allowed.length > 0 ? allowed : undefined
}

// Generally, foundry supports all 1P features;
// however out of an abundance of caution, we do not enable any which are behind an experiment

export function modelSupportsISP(model: string): boolean {
  // Config-driven: check per-model flag from provider registry first
  const configured = getProviderRegistry().getModelFlag(
    model,
    'interleavedThinking',
  )
  if (configured !== undefined) return configured

  // Fallback: hardcoded logic for models without explicit config
  const canonical = getCanonicalName(model)
  const providerType = getProviderRegistry().getProviderType(model)
  if (providerType === 'foundry') {
    return true
  }
  if (providerType === 'anthropic') {
    return !canonical.includes('claude-3-')
  }
  return (
    canonical.includes('claude-opus-4') || canonical.includes('claude-sonnet-4')
  )
}

function providerSupportsWebSearch(model: string): boolean {
  return getProviderRegistry().getCapability(model, 'webSearch')
}

// Context management is supported on Claude 4+ models
export function modelSupportsContextManagement(model: string): boolean {
  // Config-driven: check per-model flag from provider registry first
  const configured = getProviderRegistry().getModelFlag(
    model,
    'serverContextManagement',
  )
  if (configured !== undefined) return configured

  // Fallback: hardcoded logic for models without explicit config
  const canonical = getCanonicalName(model)
  const providerType = getProviderRegistry().getProviderType(model)
  if (providerType === 'foundry') {
    return true
  }
  if (providerType === 'anthropic') {
    return !canonical.includes('claude-3-')
  }
  return (
    canonical.includes('claude-opus-4') ||
    canonical.includes('claude-sonnet-4') ||
    canonical.includes('claude-haiku-4')
  )
}

export function modelSupportsStructuredOutputs(model: string): boolean {
  // Config-driven: check per-model flag from provider registry first
  const configured = getProviderRegistry().getModelFlag(
    model,
    'structuredOutputs',
  )
  if (configured !== undefined) return configured

  // Fallback: hardcoded logic for models without explicit config
  const canonical = getCanonicalName(model)
  const providerType = getProviderRegistry().getProviderType(model)
  if (providerType !== 'anthropic' && providerType !== 'foundry') {
    return false
  }
  return (
    canonical.includes('claude-sonnet-4-6') ||
    canonical.includes('claude-sonnet-4-5') ||
    canonical.includes('claude-opus-4-1') ||
    canonical.includes('claude-opus-4-5') ||
    canonical.includes('claude-opus-4-6') ||
    canonical.includes('claude-haiku-4-5')
  )
}

// Auto mode: the safety classifier runs as a separate model call, so any main
// model can participate. The classifier model is configurable via settings.
export function modelSupportsAutoMode(_model: string): boolean {
  if (feature('TRANSCRIPT_CLASSIFIER')) {
    return true
  }
  return false
}

/**
 * Get the correct tool search beta header for the current API provider.
 * - Claude API / Foundry: advanced-tool-use-2025-11-20
 * - Vertex AI / Bedrock: tool-search-tool-2025-10-19
 */
export function getToolSearchBetaHeader(model?: string): string {
  const registry = getProviderRegistry()
  const providerType = model
    ? registry.getProviderType(model)
    : registry.getDefaultProvider()?.config.type ?? null
  if (providerType === 'vertex' || providerType === 'bedrock-converse') {
    return TOOL_SEARCH_BETA_HEADER_3P
  }
  return TOOL_SEARCH_BETA_HEADER_1P
}

/**
 * Check if experimental betas should be included.
 * These are betas that are only available on firstParty provider
 * and may not be supported by proxies or other providers.
 */
export function shouldIncludeFirstPartyOnlyBetas(model?: string): boolean {
  const registry = getProviderRegistry()
  const providerType = model
    ? registry.getProviderType(model)
    : registry.getDefaultProvider()?.config.type ?? null
  return (
    (providerType === 'anthropic' || providerType === 'foundry') &&
    !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS)
  )
}

/**
 * Global-scope prompt caching is firstParty only. Foundry is excluded because
 * Foundry users were never bucketed into the rollout experiment — the
 * treatment data is firstParty-only.
 */
export function shouldUseGlobalCacheScope(model?: string): boolean {
  const caps = model
    ? getProviderRegistry().getCapabilities(model)
    : getProviderRegistry().getCapabilities()
  return (
    caps.globalCacheScope &&
    !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS)
  )
}

export const getAllModelBetas = memoize((model: string): string[] => {
  const betaHeaders = []
  const isHaiku = getCanonicalName(model).includes('haiku')
  const providerType = getProviderRegistry().getProviderType(model)
  const includeFirstPartyOnlyBetas = shouldIncludeFirstPartyOnlyBetas(model)

  if (!isHaiku) {
    betaHeaders.push(CLAUDE_CODE_20250219_BETA_HEADER)
  }
  if (isClaudeAISubscriber()) {
    betaHeaders.push(OAUTH_BETA_HEADER)
  }
  if (has1mContext(model)) {
    betaHeaders.push(CONTEXT_1M_BETA_HEADER)
  }
  if (
    !isEnvTruthy(process.env.DISABLE_INTERLEAVED_THINKING) &&
    modelSupportsISP(model)
  ) {
    betaHeaders.push(INTERLEAVED_THINKING_BETA_HEADER)
  }

  // Skip the API-side Haiku thinking summarizer — the summary is only used
  // for ctrl+o display, which interactive users rarely open. The API returns
  // redacted_thinking blocks instead; AssistantRedactedThinkingMessage already
  // renders those as a stub. SDK / print-mode keep summaries because callers
  // may iterate over thinking content. Users can opt back in via settings.json
  // showThinkingSummaries.
  if (
    includeFirstPartyOnlyBetas &&
    modelSupportsISP(model) &&
    !getIsNonInteractiveSession() &&
    getInitialSettings().showThinkingSummaries !== true
  ) {
    betaHeaders.push(REDACT_THINKING_BETA_HEADER)
  }

  // POC: server-side connector-text summarization (anti-distillation). The
  // API buffers assistant text between tool calls, summarizes it, and returns
  // the summary with a signature so the original can be restored on subsequent
  // turns — same mechanism as thinking blocks. Ant-only while we measure
  // TTFT/TTLT/capacity; betas already flow to tengu_api_success for splitting.
  // Backend independently requires Capability.ANTHROPIC_INTERNAL_RESEARCH.
  //
  // USE_CONNECTOR_TEXT_SUMMARIZATION is tri-state: =1 forces on (opt-in even
  // if GB is off), =0 forces off (opt-out of a GB rollout you were bucketed
  // into), unset defers to GB.

  // Add context management beta for thinking preservation
  const thinkingPreservationEnabled = modelSupportsContextManagement(model)

  if (shouldIncludeFirstPartyOnlyBetas(model) && thinkingPreservationEnabled) {
    betaHeaders.push(CONTEXT_MANAGEMENT_BETA_HEADER)
  }
  // Add strict tool use beta if experiment is enabled.
  // Gate on includeFirstPartyOnlyBetas: CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS
  // already strips schema.strict from tool bodies at api.ts's choke point, but
  // this header was escaping that kill switch. Proxy gateways that look like
  // firstParty but forward to Vertex reject this header with 400.
  // github.com/deshaw/anthropic-issues/issues/5
  const strictToolsEnabled =
    (getInitialSettings()?.strictToolSchemas ?? false)
  if (
    includeFirstPartyOnlyBetas &&
    modelSupportsStructuredOutputs(model) &&
    strictToolsEnabled
  ) {
    betaHeaders.push(STRUCTURED_OUTPUTS_BETA_HEADER)
  }

  // Add web search beta for providers that support it (provider-level capability)
  if (
    providerSupportsWebSearch(model) &&
    providerType !== 'anthropic' // 1P handles web search server-side without beta header
  ) {
    betaHeaders.push(WEB_SEARCH_BETA_HEADER)
  }

  // Always send the beta header for 1P. The header is a no-op without a scope field.
  if (includeFirstPartyOnlyBetas) {
    betaHeaders.push(PROMPT_CACHING_SCOPE_BETA_HEADER)
  }

  // If ANTHROPIC_BETAS is set, split it by commas and add to betaHeaders.
  // This is an explicit user opt-in, so honor it regardless of model.
  if (process.env.ANTHROPIC_BETAS) {
    betaHeaders.push(
      ...process.env.ANTHROPIC_BETAS.split(',')
        .map(_ => _.trim())
        .filter(Boolean),
    )
  }
  return betaHeaders
})

export const getModelBetas = memoize((model: string): string[] => {
  const modelBetas = getAllModelBetas(model)
  if (getProviderRegistry().getCapability(model, 'betasInBody')) {
    return modelBetas.filter(b => !BEDROCK_EXTRA_PARAMS_HEADERS.has(b))
  }
  return modelBetas
})

export const getBedrockExtraBodyParamsBetas = memoize(
  (model: string): string[] => {
    const modelBetas = getAllModelBetas(model)
    return modelBetas.filter(b => BEDROCK_EXTRA_PARAMS_HEADERS.has(b))
  },
)

/**
 * Merge SDK-provided betas with auto-detected model betas.
 * SDK betas are read from global state (set via setSdkBetas in main.tsx).
 * The betas are pre-filtered by filterAllowedSdkBetas which handles
 * subscriber checks and allowlist validation with warnings.
 *
 * @param options.isAgenticQuery - When true, ensures the beta headers needed
 *   for agentic queries are present. For non-Haiku models these are already
 *   included by getAllModelBetas(); for Haiku they're excluded since
 *   non-agentic calls (compaction, classifiers, token estimation) don't need them.
 */
export function getMergedBetas(
  model: string,
  options?: { isAgenticQuery?: boolean },
): string[] {
  const baseBetas = [...getModelBetas(model)]

  // Agentic queries always need claude-code and cli-internal beta headers.
  // For non-Haiku models these are already in baseBetas; for Haiku they're
  // excluded by getAllModelBetas() since non-agentic Haiku calls don't need them.
  if (options?.isAgenticQuery) {
    if (!baseBetas.includes(CLAUDE_CODE_20250219_BETA_HEADER)) {
      baseBetas.push(CLAUDE_CODE_20250219_BETA_HEADER)
    }
  }

  const sdkBetas = getSdkBetas()

  if (!sdkBetas || sdkBetas.length === 0) {
    return baseBetas
  }

  // Merge SDK betas without duplicates (already filtered by filterAllowedSdkBetas)
  return [...baseBetas, ...sdkBetas.filter(b => !baseBetas.includes(b))]
}

export function clearBetasCaches(): void {
  getAllModelBetas.cache?.clear?.()
  getModelBetas.cache?.clear?.()
  getBedrockExtraBodyParamsBetas.cache?.clear?.()
}
