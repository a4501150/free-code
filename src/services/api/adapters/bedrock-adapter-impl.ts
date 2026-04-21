/**
 * AWS Bedrock (Converse) adapter.
 *
 * Bedrock does not expose an Anthropic-shape `/count_tokens` endpoint in the
 * SDK; instead we use `CountTokensCommand` directly against a Bedrock
 * runtime client. The wrapper already exists in
 * `src/services/tokenEstimation.ts` (`countTokensViaBedrock`) so this
 * adapter is mostly a pass-through.
 */
import type { ProviderAdapter, FetchFn, TokenBreakdown } from '../adapter.js'
import type { ProviderCapabilities, ProviderConfig, ProviderType } from '../../../utils/settings/types.js'
import {
  fromHttpStatus,
  type NormalizedApiError,
} from '../../../utils/normalizedError.js'
import { createBedrockConverseFetch } from '../bedrock-converse-adapter.js'
import {
  countTokensViaBedrock,
  hasThinkingBlocks,
} from '../../tokenEstimation.js'
import { normalizeModelStringForAPI } from '../../../utils/model/model.js'
import type { Anthropic } from '@anthropic-ai/sdk'

export const bedrockAdapter: ProviderAdapter = {
  providerType: 'bedrock-converse',
  capabilities: {} as ProviderCapabilities,

  createFetch(config: ProviderConfig, authArgs: unknown): FetchFn {
    return createBedrockConverseFetch(
      config,
      authArgs as Parameters<typeof createBedrockConverseFetch>[1],
    )
  },

  async countTokens(
    messages: Anthropic.Beta.Messages.BetaMessageParam[],
    tools: Anthropic.Beta.Messages.BetaToolUnion[],
    model: string,
    options?: { system?: string; betas?: string[] },
  ): Promise<TokenBreakdown | null> {
    const inputTokens = await countTokensViaBedrock({
      model: normalizeModelStringForAPI(model),
      messages,
      tools,
      betas: options?.betas ?? [],
      containsThinking: hasThinkingBlocks(messages),
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
      exceptionType?: string
    }
    // Bedrock EventStream mid-stream errors arrive as `exception` frames
    // whose payload carries `__type: 'com.amazon...#Xxx'`. The caller is
    // expected to have extracted the suffix into `exceptionType`.
    if (r.exceptionType) {
      const kind =
        r.exceptionType === 'ThrottlingException'
          ? 'rate_limit'
          : r.exceptionType === 'ServiceUnavailableException'
            ? 'overloaded'
            : r.exceptionType === 'AccessDeniedException'
              ? 'auth'
              : r.exceptionType === 'ValidationException'
                ? 'invalid_request'
                : r.exceptionType === 'ModelErrorException' ||
                    r.exceptionType === 'ModelStreamErrorException' ||
                    r.exceptionType === 'InternalServerException'
                  ? 'server'
                  : 'unknown'
      const message =
        typeof r.body === 'string'
          ? r.body
          : r.cause instanceof Error
            ? r.cause.message
            : r.exceptionType
      return { kind, message, providerType, raw }
    }

    // Bedrock HTTP error body is Anthropic-shape on Converse-Anthropic but
    // JSON-ish for other model families. Parse best-effort.
    let errMessage: string | undefined
    if (r.body) {
      try {
        const parsed =
          typeof r.body === 'string'
            ? (JSON.parse(r.body) as { message?: string; Message?: string })
            : (r.body as { message?: string; Message?: string })
        errMessage = parsed?.message ?? parsed?.Message
      } catch {
        if (typeof r.body === 'string') errMessage = r.body
      }
    }

    if (typeof r.status === 'number') {
      return fromHttpStatus(
        r.status,
        errMessage ?? `HTTP ${r.status}`,
        providerType,
        r.headers,
        raw,
      )
    }

    const causeMsg =
      r.cause instanceof Error ? r.cause.message : String(r.cause ?? 'stream error')
    return {
      kind: r.mid_stream ? 'unknown' : 'transport',
      message: errMessage ?? causeMsg,
      providerType,
      raw,
    }
  },
}
