/**
 * Anthropic wire-format helpers.
 *
 * Private support module for adapters that speak the Anthropic wire format
 * (Anthropic native, Vertex, Foundry). Converts domain types to/from
 * Anthropic SDK types and wraps SDK errors into domain errors.
 *
 * Not imported by business logic — SDK types are confined to this file
 * and the adapters that use it.
 */
import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from '@anthropic-ai/sdk'
import type {
  BetaMessageParam,
  BetaMessageStreamParams,
  BetaRawMessageStreamEvent,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type { Stream } from '@anthropic-ai/sdk/streaming.mjs'
import type { ProviderType } from '../../../utils/settings/types.js'
import type { NormalizedApiError } from '../../../utils/normalizedError.js'
import type {
  DomainMessageParam,
  DomainMessageRequest,
  DomainStreamingResponse,
} from '../domain-transport.js'
import type { DomainStreamEvent } from '../../../types/domain.js'
import {
  anthropicStreamEventToDomain,
  domainBlockToAnthropic,
  domainUserBlockToAnthropic,
} from '../../../types/domainConversion.js'
import {
  DomainTransportError,
  DomainConnectionError,
  DomainConnectionTimeoutError,
  DomainUserAbortError,
} from '../domain-errors.js'

function domainMessageToAnthropicParam(
  message: DomainMessageParam,
): BetaMessageParam {
  if (message.role === 'user') {
    return {
      role: 'user',
      content: message.content.map(domainUserBlockToAnthropic),
    } as unknown as BetaMessageParam
  }

  return {
    role: 'assistant',
    content: message.content.flatMap(block => {
      const converted = domainBlockToAnthropic(block)
      if (!converted) return []
      const cacheControl = (block as unknown as { cache_control?: unknown })
        .cache_control
      return [
        {
          ...converted,
          ...(cacheControl !== undefined && { cache_control: cacheControl }),
        },
      ]
    }),
  } as unknown as BetaMessageParam
}

/**
 * Convert a DomainMessageRequest to Anthropic SDK params.
 */
export function domainRequestToAnthropicParams(
  request: DomainMessageRequest,
): BetaMessageStreamParams {
  const params: Record<string, unknown> = {
    model: request.model,
    messages: request.messages.map(domainMessageToAnthropicParam),
    max_tokens: request.maxTokens,
  }

  if (request.system) params.system = request.system
  if (request.tools && request.tools.length > 0) params.tools = request.tools
  if (request.toolChoice) params.tool_choice = request.toolChoice
  if (request.thinking) {
    params.thinking =
      request.thinking.type === 'enabled'
        ? {
            type: 'enabled',
            budget_tokens: request.thinking.budgetTokens,
          }
        : request.thinking
  }
  if (request.temperature !== undefined)
    params.temperature = request.temperature
  if (request.speed) params.speed = request.speed
  if (request.betas) params.betas = request.betas
  if (request.metadata) params.metadata = request.metadata
  if (request.outputConfig) params.output_config = request.outputConfig
  if (request.contextManagement)
    params.context_management = request.contextManagement
  if (request.advisorModel) params.advisor_model = request.advisorModel
  if (request.stopSequences) params.stop_sequences = request.stopSequences

  if (request.extraBody) {
    for (const [key, value] of Object.entries(request.extraBody)) {
      if (!(key in params)) {
        params[key] = value
      }
    }
  }

  return params as unknown as BetaMessageStreamParams
}

/**
 * Wrap an Anthropic SDK error into a DomainTransportError.
 */
export function wrapSdkError(
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

/**
 * Wrap an SDK Stream into a DomainStreamingResponse.
 */
export function makeStreamingResponse(
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
