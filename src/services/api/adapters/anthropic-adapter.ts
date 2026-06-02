/**
 * Anthropic-native adapter.
 *
 * Uses the SDK streaming bridge to convert DomainMessageRequest to Anthropic
 * SDK params, create streams/messages via the SDK, and convert SDK events to
 * DomainStreamEvent.
 *
 * For streaming, uses raw `Stream<BetaRawMessageStreamEvent>` (not
 * `BetaMessageStream`) to avoid O(n²) partial JSON parsing in tool input
 * accumulation.
 */
import type { ProviderAdapter, FetchFn, TokenBreakdown } from '../adapter.js'
import type {
  ProviderCapabilities,
  ProviderConfig,
  ProviderType,
} from '../../../utils/settings/types.js'
import {
  fromHttpStatus,
  type NormalizedApiError,
} from '../../../utils/normalizedError.js'
import { countTokensViaAnthropicEndpoint } from '../../tokenEstimation.js'
import type { Anthropic } from '@anthropic-ai/sdk'
import type { DomainMessageRequest } from '../domain-transport.js'
import type { DomainStreamingResponse } from '../domain-transport.js'
import type { DomainAssistantContent } from '../../../types/domain.js'
import {
  sdkBridgeCreateStream,
  sdkBridgeCreateMessage,
  type SdkBridgeAuthArgs,
} from './sdk-streaming-bridge.js'

export type AnthropicAuthArgs = SdkBridgeAuthArgs

export const anthropicAdapter: ProviderAdapter = {
  providerType: 'anthropic',
  capabilities: {} as ProviderCapabilities,

  async createStream(
    _config: ProviderConfig,
    authArgs: unknown,
    request: DomainMessageRequest,
    signal: AbortSignal,
  ): Promise<DomainStreamingResponse> {
    return sdkBridgeCreateStream(
      authArgs,
      request,
      signal,
      'anthropic',
      this.normalizeError,
    )
  },

  async createMessage(
    _config: ProviderConfig,
    authArgs: unknown,
    request: DomainMessageRequest,
    signal: AbortSignal,
  ): Promise<DomainAssistantContent> {
    return sdkBridgeCreateMessage(
      authArgs,
      request,
      signal,
      'anthropic',
      this.normalizeError,
    )
  },

  createFetch(
    _config: ProviderConfig,
    _authArgs: unknown,
  ): FetchFn | undefined {
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
      system: options?.system,
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
    let innerType: string | undefined
    let innerMessage: string | undefined
    if (r.body) {
      try {
        const parsed =
          typeof r.body === 'string'
            ? (JSON.parse(r.body) as {
                error?: { type?: string; message?: string }
              })
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
        innerMessage ??
          (typeof r.body === 'string' ? r.body : `HTTP ${r.status}`),
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
      r.cause instanceof Error
        ? r.cause.message
        : String(r.cause ?? 'stream error')
    return {
      kind: 'transport',
      message: innerMessage ?? causeMsg,
      providerType,
      raw,
    }
  },
}
