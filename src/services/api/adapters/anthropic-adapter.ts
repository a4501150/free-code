/**
 * Anthropic-native adapter.
 *
 * Delegates token counting to the `/v1/messages/count_tokens` endpoint via
 * the Anthropic SDK client. Native wire format — no message translation.
 */
import type { ProviderAdapter, FetchFn, TokenBreakdown } from '../adapter.js'
import type { ProviderCapabilities, ProviderConfig, ProviderType } from '../../../utils/settings/types.js'
import {
  fromHttpStatus,
  type NormalizedApiError,
} from '../../../utils/normalizedError.js'
import { countTokensViaAnthropicEndpoint } from '../../tokenEstimation.js'
import type { Anthropic } from '@anthropic-ai/sdk'

export const anthropicAdapter: ProviderAdapter = {
  providerType: 'anthropic',
  capabilities: {} as ProviderCapabilities,

  createFetch(_config: ProviderConfig, _authArgs: unknown): FetchFn | undefined {
    // Anthropic uses the SDK's native fetch; no adapter-level override.
    return undefined
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
    })
    if (inputTokens == null) return null
    return { inputTokens, outputTokens: 0 }
  },

  normalizeError(raw: unknown, providerType: ProviderType): NormalizedApiError {
    const r = (raw ?? {}) as {
      status?: number
      body?: unknown
      headers?: Headers | Record<string, string>
      mid_stream?: boolean
      cause?: unknown
    }
    // Parse Anthropic-shape error body. Even on non-529 statuses, an inner
    // `overloaded_error` type forces overloaded kind (observed on streaming
    // 200 → mid-body overload).
    let innerType: string | undefined
    let innerMessage: string | undefined
    if (r.body) {
      try {
        const parsed =
          typeof r.body === 'string'
            ? (JSON.parse(r.body) as { error?: { type?: string; message?: string } })
            : (r.body as { error?: { type?: string; message?: string } })
        innerType = parsed?.error?.type
        innerMessage = parsed?.error?.message
      } catch {
        // body is not JSON; leave undefined.
      }
    }

    if (typeof r.status === 'number') {
      const base = fromHttpStatus(
        r.status,
        innerMessage ?? (typeof r.body === 'string' ? r.body : `HTTP ${r.status}`),
        providerType,
        r.headers,
        raw,
      )
      if (innerType === 'overloaded_error') {
        return { ...base, kind: 'overloaded' }
      }
      if (innerType === 'rate_limit_error') {
        return { ...base, kind: 'rate_limit' }
      }
      return base
    }

    // Mid-stream / transport error. Classify from inner type first, else
    // from the cause.
    if (innerType === 'overloaded_error') {
      return {
        kind: 'overloaded',
        message: innerMessage ?? 'overloaded',
        providerType,
        raw,
      }
    }
    if (innerType === 'rate_limit_error') {
      return {
        kind: 'rate_limit',
        message: innerMessage ?? 'rate limited',
        providerType,
        raw,
      }
    }
    const causeMsg =
      r.cause instanceof Error ? r.cause.message : String(r.cause ?? 'stream error')
    return {
      kind: r.mid_stream ? 'unknown' : 'transport',
      message: innerMessage ?? causeMsg,
      providerType,
      raw,
    }
  },
}
