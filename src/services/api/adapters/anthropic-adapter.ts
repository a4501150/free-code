/**
 * Anthropic-native adapter.
 *
 * Creates its Anthropic SDK client internally and uses shared bridge helpers
 * to convert requests, streams, errors, and messages to domain types.
 *
 * For streaming, uses raw `Stream<BetaRawMessageStreamEvent>` (not
 * `BetaMessageStream`) to avoid O(n²) partial JSON parsing in tool input
 * accumulation.
 */
import type {
  ProviderAdapter,
  TokenBreakdown,
  TokenCountMessageParam,
  TokenCountToolParam,
} from '../adapter.js'
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
import { anthropicMessageToDomain } from '../../../types/domainConversion.js'
import { getAnthropicClient } from '../client.js'
import type {
  DomainMessageRequest,
  DomainMessageResponse,
  DomainStreamingResponse,
} from '../domain-transport.js'
import {
  domainRequestToAnthropicParams,
  makeStreamingResponse,
  wrapSdkError,
} from './anthropic-wire-helpers.js'

export const anthropicAdapter: ProviderAdapter = {
  providerType: 'anthropic',
  capabilities: {} as ProviderCapabilities,

  async createStream(
    _config: ProviderConfig,
    request: DomainMessageRequest,
    signal: AbortSignal,
  ): Promise<DomainStreamingResponse> {
    const client = await getAnthropicClient({
      maxRetries: 0,
      model: request.model,
      source: 'adapter',
    })
    const params = domainRequestToAnthropicParams(request)

    try {
      const result = await client.beta.messages
        .create(
          { ...params, stream: true },
          {
            signal,
            ...(request.clientRequestId && {
              headers: { 'x-client-request-id': request.clientRequestId },
            }),
          },
        )
        .withResponse()
      return makeStreamingResponse(
        result.data,
        result.response,
        result.request_id,
        'anthropic',
        this.normalizeError,
      )
    } catch (error) {
      wrapSdkError(error, 'anthropic', this.normalizeError)
    }
  },

  async createMessage(
    config: ProviderConfig,
    request: DomainMessageRequest,
    signal: AbortSignal,
  ): Promise<DomainMessageResponse> {
    const configApiKey = config.auth?.apiKey?.key
    const client = await getAnthropicClient({
      maxRetries: 0,
      model: request.model,
      source: 'adapter',
      ...(configApiKey && { apiKey: configApiKey }),
    })
    const params = domainRequestToAnthropicParams(request)

    try {
      const result = await client.beta.messages
        .create(
          { ...params, stream: false },
          {
            signal,
            ...(request.clientRequestId && {
              headers: { 'x-client-request-id': request.clientRequestId },
            }),
          },
        )
        .withResponse()
      return {
        message: anthropicMessageToDomain(result.data),
        requestId: result.request_id ?? undefined,
        responseHeaders: Object.fromEntries(result.response.headers.entries()),
      }
    } catch (error) {
      wrapSdkError(error, 'anthropic', this.normalizeError)
    }
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
