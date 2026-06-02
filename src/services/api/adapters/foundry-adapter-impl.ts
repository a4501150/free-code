/**
 * Azure Foundry adapter.
 *
 * Foundry exposes Anthropic-compatible endpoints, so token counting uses
 * the same `/count_tokens` path as the native Anthropic adapter. The
 * difference with the native adapter is only at request-issue time (auth
 * via Azure tokens) — not relevant to the token-counting code path.
 */
import type {
  ProviderAdapter,
  FetchFn,
  TokenBreakdown,
  TokenCountMessageParam,
  TokenCountToolParam,
} from '../adapter.js'
import type {
  ProviderCapabilities,
  ProviderConfig,
  ProviderType,
} from '../../../utils/settings/types.js'
import type { NormalizedApiError } from '../../../utils/normalizedError.js'
import { createFoundryFetch } from '../foundry-adapter.js'
import { anthropicAdapter } from './anthropic-adapter.js'
import { countTokensViaAnthropicEndpoint } from '../../tokenEstimation.js'
import type { DomainMessageRequest } from '../domain-transport.js'
import type { DomainStreamingResponse } from '../domain-transport.js'
import type { DomainAssistantContent } from '../../../types/domain.js'

export const foundryAdapter: ProviderAdapter = {
  providerType: 'foundry',
  capabilities: {} as ProviderCapabilities,

  async createStream(
    config: ProviderConfig,
    authArgs: unknown,
    request: DomainMessageRequest,
    signal: AbortSignal,
  ): Promise<DomainStreamingResponse> {
    return anthropicAdapter.createStream(config, authArgs, request, signal)
  },

  async createMessage(
    config: ProviderConfig,
    authArgs: unknown,
    request: DomainMessageRequest,
    signal: AbortSignal,
  ): Promise<DomainAssistantContent> {
    return anthropicAdapter.createMessage(config, authArgs, request, signal)
  },

  createFetch(config: ProviderConfig, authArgs: unknown): FetchFn {
    return createFoundryFetch(
      config,
      authArgs as Parameters<typeof createFoundryFetch>[1],
    )
  },

  async countTokens(
    messages: TokenCountMessageParam[],
    tools: TokenCountToolParam[],
    model: string,
    options?: { system?: string; betas?: string[] },
  ): Promise<TokenBreakdown | null> {
    const inputTokens = await countTokensViaAnthropicEndpoint({
      messages,
      tools,
      model,
      betas: options?.betas ?? [],
      system: options?.system,
    })
    if (inputTokens == null) return null
    return { inputTokens, outputTokens: 0 }
  },

  normalizeError(raw: unknown, providerType: ProviderType): NormalizedApiError {
    // Foundry proxies Anthropic-shape errors; reuse the Anthropic classifier.
    return anthropicAdapter.normalizeError(raw, providerType)
  },
}
