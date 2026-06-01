/**
 * Anthropic-native adapter.
 *
 * Owns the Anthropic SDK internally. Converts DomainMessageRequest to
 * Anthropic SDK params, creates streams/messages via the SDK, and converts
 * SDK events to DomainStreamEvent.
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
import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from '@anthropic-ai/sdk'
import type {
  BetaMessageStreamParams,
  BetaRawMessageStreamEvent,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type { Stream } from '@anthropic-ai/sdk/streaming.mjs'
import type { DomainMessageRequest } from '../domain-transport.js'
import type { DomainStreamingResponse } from '../domain-transport.js'
import type {
  DomainAssistantContent,
  DomainStreamEvent,
} from '../../../types/domain.js'
import {
  anthropicStreamEventToDomain,
  anthropicMessageToDomain,
} from '../../../types/domainConversion.js'
import {
  DomainTransportError,
  DomainConnectionError,
  DomainConnectionTimeoutError,
  DomainUserAbortError,
} from '../domain-errors.js'

/**
 * Auth args for the Anthropic adapter. The impure shell in client.ts
 * constructs an Anthropic SDK client and passes it here.
 */
export type AnthropicAuthArgs = {
  client: Anthropic
  clientRequestId?: string
}

function domainRequestToAnthropicParams(
  request: DomainMessageRequest,
): BetaMessageStreamParams {
  const params: Record<string, unknown> = {
    model: request.model,
    messages: request.messages,
    max_tokens: request.maxTokens,
  }

  if (request.system) params.system = request.system
  if (request.tools && request.tools.length > 0) params.tools = request.tools
  if (request.toolChoice) params.tool_choice = request.toolChoice
  if (request.thinking) params.thinking = request.thinking
  if (request.temperature !== undefined) params.temperature = request.temperature
  if (request.speed) params.speed = request.speed
  if (request.betas) params.betas = request.betas
  if (request.metadata) params.metadata = request.metadata
  if (request.previousRequestId)
    params.previous_request_id = request.previousRequestId
  if (request.outputConfig) params.output_config = request.outputConfig
  if (request.contextManagement)
    params.context_management = request.contextManagement
  if (request.advisorModel) params.advisor_model = request.advisorModel

  if (request.extraBody) {
    for (const [key, value] of Object.entries(request.extraBody)) {
      if (!(key in params)) {
        params[key] = value
      }
    }
  }

  return params as unknown as BetaMessageStreamParams
}

function wrapSdkError(
  error: unknown,
  providerType: ProviderType,
  normalizeError: (raw: unknown, pt: ProviderType) => NormalizedApiError,
): never {
  if (error instanceof DomainTransportError) throw error
  if (error instanceof DomainUserAbortError) throw error

  if (error instanceof APIUserAbortError) {
    throw new DomainUserAbortError()
  }

  if (error instanceof APIConnectionTimeoutError) {
    const normalized = normalizeError(
      { cause: error, mid_stream: true },
      providerType,
    )
    throw new DomainConnectionTimeoutError({
      normalized: { ...normalized, kind: 'transport' },
      cause: error,
      raw: error,
    })
  }

  if (error instanceof APIConnectionError) {
    const normalized = normalizeError(
      { cause: error, mid_stream: true },
      providerType,
    )
    throw new DomainConnectionError({
      normalized: { ...normalized, kind: 'transport' },
      cause: error,
      raw: error,
    })
  }

  if (error instanceof APIError) {
    const normalized = normalizeError(
      {
        status: error.status,
        body: (error as unknown as { error?: unknown }).error ?? error.message,
        headers: error.headers,
      },
      providerType,
    )
    const headers = error.headers
      ? Object.fromEntries(error.headers.entries())
      : undefined
    throw new DomainTransportError({
      normalized,
      status: error.status,
      requestID: error.requestID ?? undefined,
      headers,
      raw: error,
    })
  }

  // Unknown error — wrap as transport
  const normalized: NormalizedApiError = {
    kind: 'transport',
    message: error instanceof Error ? error.message : String(error),
    providerType,
    raw: error,
  }
  throw new DomainConnectionError({
    normalized,
    cause: error,
    raw: error,
  })
}

function makeStreamingResponse(
  sdkStream: Stream<BetaRawMessageStreamEvent>,
  sdkResponse: Response | undefined,
  requestId: string | null | undefined,
  providerType: ProviderType,
  normalizeError: (raw: unknown, pt: ProviderType) => NormalizedApiError,
): DomainStreamingResponse {
  async function* convertEvents(): AsyncGenerator<DomainStreamEvent> {
    try {
      for await (const event of sdkStream) {
        yield anthropicStreamEventToDomain(event)
      }
    } catch (error) {
      if (error instanceof DomainUserAbortError) throw error
      if (error instanceof DomainTransportError) throw error

      if (error instanceof APIUserAbortError) {
        throw new DomainUserAbortError()
      }

      // Mid-stream SDK errors: convert and re-throw so the main loop's
      // mid-stream retry can catch them as DomainTransportError
      wrapSdkError(error, providerType, normalizeError)
    }
  }

  const responseHeaders = sdkResponse?.headers
    ? Object.fromEntries(sdkResponse.headers.entries())
    : undefined

  return {
    stream: convertEvents(),
    requestId: requestId ?? undefined,
    responseHeaders,
    abort() {
      sdkStream.controller.abort()
    },
    release() {
      try {
        sdkStream.controller.abort()
      } catch {
        // ignore
      }
      if (sdkResponse?.body) {
        sdkResponse.body.cancel().catch(() => {})
      }
    },
  }
}

export const anthropicAdapter: ProviderAdapter = {
  providerType: 'anthropic',
  capabilities: {} as ProviderCapabilities,

  async createStream(
    _config: ProviderConfig,
    authArgs: unknown,
    request: DomainMessageRequest,
    signal: AbortSignal,
  ): Promise<DomainStreamingResponse> {
    const { client, clientRequestId } = authArgs as AnthropicAuthArgs
    const params = domainRequestToAnthropicParams(request)

    try {
      const result = await client.beta.messages
        .create(
          { ...params, stream: true },
          {
            signal,
            ...(clientRequestId && {
              headers: { 'x-client-request-id': clientRequestId },
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
    _config: ProviderConfig,
    authArgs: unknown,
    request: DomainMessageRequest,
    signal: AbortSignal,
  ): Promise<DomainAssistantContent> {
    const { client, clientRequestId } = authArgs as AnthropicAuthArgs
    const params = domainRequestToAnthropicParams(request)

    try {
      const result = await client.beta.messages.create(
        { ...params, stream: false },
        {
          signal,
          ...(clientRequestId && {
            headers: { 'x-client-request-id': clientRequestId },
          }),
        },
      )

      return anthropicMessageToDomain(result)
    } catch (error) {
      wrapSdkError(error, 'anthropic', this.normalizeError)
    }
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
