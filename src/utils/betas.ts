import { feature } from 'bun:bundle'
import memoize from 'lodash-es/memoize.js'
import { getIsNonInteractiveSession, getSdkBetas } from '../bootstrap/state.js'
import {
  BODY_ONLY_BETAS,
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
import { modelSupports1M } from './context.js'
import { isEnvTruthy } from './envUtils.js'

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

export function modelSupportsISP(model: string): boolean {
  const configured = getProviderRegistry().getModelFlag(
    model,
    'interleavedThinking',
  )
  return configured ?? false
}

function providerSupportsWebSearch(model: string): boolean {
  return getProviderRegistry().getCapability(model, 'webSearch')
}

export function modelSupportsContextManagement(model: string): boolean {
  const configured = getProviderRegistry().getModelFlag(
    model,
    'serverContextManagement',
  )
  return configured ?? false
}

export function modelSupportsStructuredOutputs(model: string): boolean {
  const configured = getProviderRegistry().getModelFlag(
    model,
    'structuredOutputs',
  )
  return configured ?? false
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
 * Providers using Anthropic wire format (anthropic, foundry, proxies) use the 1P header.
 * Cloud providers with custom APIs (Bedrock Converse, Vertex) use the 3P header.
 */
export function getToolSearchBetaHeader(model?: string): string {
  const registry = getProviderRegistry()
  const caps = model
    ? registry.getCapabilities(model)
    : registry.getCapabilities()
  // 3P providers have non-native token counting methods (bedrock-custom, vertex-filtered)
  if (caps.tokenCountingMethod !== 'native') {
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
  const providerType = getProviderRegistry().getProviderType(model)
  const includeFirstPartyOnlyBetas = shouldIncludeFirstPartyOnlyBetas(model)

  // Gate CC beta header on interleavedThinking support
  if (modelSupportsISP(model)) {
    betaHeaders.push(CLAUDE_CODE_20250219_BETA_HEADER)
  }
  if (isClaudeAISubscriber()) {
    betaHeaders.push(OAUTH_BETA_HEADER)
  }
  if (modelSupports1M(model)) {
    betaHeaders.push(CONTEXT_1M_BETA_HEADER)
  }
  if (
    !isEnvTruthy(process.env.DISABLE_INTERLEAVED_THINKING) &&
    modelSupportsISP(model)
  ) {
    betaHeaders.push(INTERLEAVED_THINKING_BETA_HEADER)
  }

  // Skip the API-side thinking summarizer — the summary is only used
  // for ctrl+o display, which interactive users rarely open. The API returns
  // redacted_thinking blocks instead; AssistantRedactedThinkingMessage already
  // renders those as a stub. SDK / print-mode keep summaries because callers
  // may iterate over thinking content. Users can opt back in via freecode.json
  // showThinkingSummaries.
  if (
    includeFirstPartyOnlyBetas &&
    modelSupportsISP(model) &&
    !getIsNonInteractiveSession() &&
    getInitialSettings().showThinkingSummaries !== true
  ) {
    betaHeaders.push(REDACT_THINKING_BETA_HEADER)
  }

  // Add context management beta for thinking preservation
  const thinkingPreservationEnabled = modelSupportsContextManagement(model)

  if (shouldIncludeFirstPartyOnlyBetas(model) && thinkingPreservationEnabled) {
    betaHeaders.push(CONTEXT_MANAGEMENT_BETA_HEADER)
  }
  // Add strict tool use beta if experiment is enabled.
  // Default is now true (kill switch in freecode.json: strictToolSchemas=false).
  // For Anthropic-type providers, this broadens the strict beta to ALL tools
  // (previously gated additionally on per-tool strict:true) when the model
  // declares structuredOutputs. Per the design notes, this is intentional:
  // toolToAPISchema now applies makeJsonSchemaStrict to every eligible tool.
  const strictToolsEnabled =
    (getInitialSettings()?.strictToolSchemas ?? true)
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
    return modelBetas.filter(b => !BODY_ONLY_BETAS.has(b))
  }
  return modelBetas
})

export const getBodyBetas = memoize(
  (model: string): string[] => {
    const modelBetas = getAllModelBetas(model)
    return modelBetas.filter(b => BODY_ONLY_BETAS.has(b))
  },
)

/** @deprecated Use getBodyBetas instead */
export const getBedrockExtraBodyParamsBetas = getBodyBetas

/**
 * Merge SDK-provided betas with auto-detected model betas.
 * SDK betas are read from global state (set via setSdkBetas in main.tsx).
 * The betas are pre-filtered by filterAllowedSdkBetas which handles
 * subscriber checks and allowlist validation with warnings.
 *
 * @param options.isAgenticQuery - When true, ensures the beta headers needed
 *   for agentic queries are present.
 */
export function getMergedBetas(
  model: string,
  options?: { isAgenticQuery?: boolean },
): string[] {
  const baseBetas = [...getModelBetas(model)]

  // Agentic queries always need claude-code and cli-internal beta headers.
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
