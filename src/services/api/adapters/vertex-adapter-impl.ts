/**
 * Vertex-Anthropic adapter.
 *
 * Token counting goes through `/count_tokens` but with filtered betas —
 * Vertex rejects certain Anthropic betas that are accepted by the native
 * endpoint (`VERTEX_COUNT_TOKENS_ALLOWED_BETAS`). Wire format is Anthropic
 * so usage normalization mirrors the native adapter.
 */
import type { ProviderAdapter, FetchFn, TokenBreakdown } from '../adapter.js'
import type { ProviderCapabilities, ProviderConfig, ProviderType } from '../../../utils/settings/types.js'
import {
  fromHttpStatus,
  type NormalizedApiError,
} from '../../../utils/normalizedError.js'
import { createVertexFetch } from '../vertex-adapter.js'
import { anthropicAdapter } from './anthropic-adapter.js'
import { countTokensViaAnthropicEndpoint } from '../../tokenEstimation.js'
import { VERTEX_COUNT_TOKENS_ALLOWED_BETAS } from '../../../constants/betas.js'
import type { Anthropic } from '@anthropic-ai/sdk'

export const vertexAnthropicAdapter: ProviderAdapter = {
  providerType: 'vertex',
  capabilities: {} as ProviderCapabilities,

  createFetch(config: ProviderConfig, authArgs: unknown): FetchFn {
    return createVertexFetch(
      config,
      authArgs as Parameters<typeof createVertexFetch>[1],
    )
  },

  async countTokens(
    messages: Anthropic.Beta.Messages.BetaMessageParam[],
    tools: Anthropic.Beta.Messages.BetaToolUnion[],
    model: string,
    options?: { system?: string; betas?: string[] },
  ): Promise<TokenBreakdown | null> {
    const inputTokens = await countTokensViaAnthropicEndpoint({
      messages,
      tools,
      model,
      betas: options?.betas ?? [],
      filterBetas: (b) => VERTEX_COUNT_TOKENS_ALLOWED_BETAS.has(b),
    })
    if (inputTokens == null) return null
    return { inputTokens, outputTokens: 0 }
  },

  normalizeError(raw: unknown, providerType: ProviderType): NormalizedApiError {
    // Vertex-Anthropic returns Anthropic-shape error bodies; delegate to the
    // Anthropic adapter's classifier and override providerType.
    const base = anthropicAdapter.normalizeError(raw, providerType)
    const r = (raw ?? {}) as { status?: number; headers?: Headers | Record<string, string> }
    // Fallback: if the body wasn't parseable, Anthropic adapter already
    // handled status. No-op here.
    if (typeof r.status === 'number' && base.kind === 'unknown') {
      return fromHttpStatus(r.status, base.message, providerType, r.headers, raw)
    }
    return base
  },
}
