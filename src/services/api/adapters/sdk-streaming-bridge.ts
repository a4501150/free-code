/**
 * SDK streaming bridge.
 *
 * Provides shared helpers for adapters that use the Anthropic SDK internally
 * to create streams/messages, then convert the SDK types to domain types.
 * This is the transitional bridge used by adapters that haven't implemented
 * native HTTP transport yet (bedrock, codex, gemini).
 *
 * Once all adapters have native transport, this module can be deleted.
 */
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
import type { ProviderType } from '../../../utils/settings/types.js'
import type { NormalizedApiError } from '../../../utils/normalizedError.js'
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
 * Auth args shape for adapters that use the SDK bridge.
 * The Anthropic SDK client is pre-configured with the right fetch override
 * for the target provider.
 */
export type SdkBridgeAuthArgs = {
  client: Anthropic
  clientRequestId?: string
}

/**
 * Convert a DomainMessageRequest to Anthropic SDK params.
 */
export function domainRequestToAnthropicParams(
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

/**
 * Create a streaming request through the Anthropic SDK.
 *
 * Used by adapters that haven't implemented native HTTP transport yet.
 * The SDK client must be pre-configured with the correct fetch override
 * for the target provider.
 */
export async function sdkBridgeCreateStream(
  authArgs: unknown,
  request: DomainMessageRequest,
  signal: AbortSignal,
  providerType: ProviderType,
  normalizeError: (raw: unknown, pt: ProviderType) => NormalizedApiError,
): Promise<DomainStreamingResponse> {
  const { client, clientRequestId } = authArgs as SdkBridgeAuthArgs
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
      providerType,
      normalizeError,
    )
  } catch (error) {
    wrapSdkError(error, providerType, normalizeError)
  }
}

/**
 * Create a non-streaming request through the Anthropic SDK.
 */
export async function sdkBridgeCreateMessage(
  authArgs: unknown,
  request: DomainMessageRequest,
  signal: AbortSignal,
  providerType: ProviderType,
  normalizeError: (raw: unknown, pt: ProviderType) => NormalizedApiError,
): Promise<DomainAssistantContent> {
  const { client, clientRequestId } = authArgs as SdkBridgeAuthArgs
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
    wrapSdkError(error, providerType, normalizeError)
  }
}
