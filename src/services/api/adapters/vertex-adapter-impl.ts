/**
 * Vertex-Anthropic adapter.
 *
 * Token counting goes through `/count_tokens` but with filtered betas —
 * Vertex rejects certain Anthropic betas that are accepted by the native
 * endpoint (`VERTEX_COUNT_TOKENS_ALLOWED_BETAS`). Wire format is Anthropic
 * so usage normalization mirrors the native adapter.
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
import type { NormalizedApiError } from '../../../utils/normalizedError.js'
import { anthropicAdapter } from './anthropic-adapter.js'
import { countTokensViaAnthropicEndpoint } from '../../tokenEstimation.js'
import { VERTEX_COUNT_TOKENS_ALLOWED_BETAS } from '../../../constants/betas.js'
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

export const vertexAnthropicAdapter: ProviderAdapter = {
  providerType: 'vertex',
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
        'vertex',
        this.normalizeError,
      )
    } catch (error) {
      wrapSdkError(error, 'vertex', this.normalizeError)
    }
  },

  async createMessage(
    _config: ProviderConfig,
    request: DomainMessageRequest,
    signal: AbortSignal,
  ): Promise<DomainMessageResponse> {
    const client = await getAnthropicClient({
      maxRetries: 0,
      model: request.model,
      source: 'adapter',
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
      wrapSdkError(error, 'vertex', this.normalizeError)
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
      filterBetas: b => VERTEX_COUNT_TOKENS_ALLOWED_BETAS.has(b),
      system: options?.system,
    })
    if (inputTokens == null) return null
    return { inputTokens, outputTokens: 0 }
  },

  normalizeError(raw: unknown, providerType: ProviderType): NormalizedApiError {
    return anthropicAdapter.normalizeError(raw, providerType)
  },
}
