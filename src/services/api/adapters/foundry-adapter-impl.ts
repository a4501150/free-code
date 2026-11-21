import {
  DefaultAzureCredential as AzureCredential,
  getBearerTokenProvider,
} from '@azure/identity'
import {
  applyAnthropicRequestFeatures,
  describeAnthropicCacheFeatures,
} from './anthropicFeatures.js'
import {
  anthropicMessageToDomain,
  type WireMessage,
} from '../../../types/domainConversion.js'
import { getUserAgent } from '../../../utils/http.js'
import { resolveApiKey, resolveBearerToken } from './authResolution.js'
import { logError } from '../../../utils/log.js'
import { normalizeModelStringForAPI } from '../../../utils/model/modelResolution.js'
import {
  getProviderRegistry,
  type ResolvedProvider,
} from '../../../utils/model/providerRegistry.js'
import type { NormalizedApiError } from '../../../utils/normalizedError.js'
import type {
  ProviderConfig,
  ProviderType,
} from '../../../utils/settings/types.js'
import {
  hasThinkingBlocks,
  TOKEN_COUNT_MAX_TOKENS,
  TOKEN_COUNT_THINKING_BUDGET,
  type ProviderAdapter,
  type ResolvedProviderTarget,
  type TokenBreakdown,
  type TokenCountMessageParam,
  type TokenCountToolParam,
} from '../adapter.js'
import {
  DomainConnectionError,
  DomainTransportError,
  DomainUserAbortError,
} from '../domain-errors.js'
import type {
  DomainMessageRequest,
  DomainMessageResponse,
  DomainStreamingResponse,
} from '../domain-transport.js'
import { anthropicAdapter } from './anthropic-adapter-impl.js'
import { parseAnthropicSSEStream } from './anthropic-sse-parser.js'
import { buildAnthropicWireBody } from './anthropic-wire-body.js'
import {
  assertOkResponse,
  assertResponseBody,
  handleFetchError,
  makeStreamingResponse,
} from './native-fetch-helpers.js'

// ── Auth ─────────────────────────────────────────────────────────────

// One credential instance per process: it caches MSAL tokens internally,
// so constructing per request would re-acquire from Entra every time.
const getAzureFoundryToken = getBearerTokenProvider(
  new AzureCredential(),
  'https://cognitiveservices.azure.com/.default',
)

async function getFoundryAuth(
  config: ProviderConfig,
): Promise<{ headerName: string; headerValue: string }> {
  const auth = config.auth
  switch (auth?.active) {
    case 'bearer': {
      const token = resolveBearerToken(auth)
      if (token) {
        return { headerName: 'Authorization', headerValue: `Bearer ${token}` }
      }
      throw new DomainConnectionError({
        normalized: {
          kind: 'auth',
          message: 'auth.active is "bearer" but no bearer token is configured',
          providerType: 'foundry',
          raw: null,
        },
        cause: new Error('Missing Foundry bearer token'),
      })
    }
    case 'apiKey': {
      const key = resolveApiKey(auth)
      if (key) return { headerName: 'x-api-key', headerValue: key }
      throw new DomainConnectionError({
        normalized: {
          kind: 'auth',
          message: 'auth.active is "apiKey" but no API key is configured',
          providerType: 'foundry',
          raw: null,
        },
        cause: new Error('Missing Foundry API key'),
      })
    }
    case 'azure': {
      const token = await getAzureFoundryToken()
      return { headerName: 'Authorization', headerValue: `Bearer ${token}` }
    }
    default:
      throw new DomainConnectionError({
        normalized: {
          kind: 'auth',
          message:
            'No Foundry credentials resolved (set auth.active to "bearer" for proxy-managed auth, "apiKey", or "azure" for local Entra credentials)',
          providerType: 'foundry',
          raw: null,
        },
        cause: new Error('Failed to resolve Foundry auth'),
      })
  }
}

// ── Adapter ──────────────────────────────────────────────────────────

export const foundryAdapter: ProviderAdapter = {
  providerType: 'foundry',

  applyRequestFeatures(request, model, intent) {
    applyAnthropicRequestFeatures(request, model, intent)
  },

  describeCacheRelevantFeatures(model, intent) {
    return describeAnthropicCacheFeatures(model, intent)
  },

  async createStream(
    provider: ResolvedProviderTarget,
    request: DomainMessageRequest,
    signal: AbortSignal,
    fetchOverride?: typeof globalThis.fetch,
  ): Promise<DomainStreamingResponse> {
    const { config } = provider
    const fetch = fetchOverride ?? globalThis.fetch
    const baseUrl = config.baseUrl || ''
    const { headerName, headerValue } = await getFoundryAuth(config)

    const wireBody = buildAnthropicWireBody(request)
    wireBody.stream = true

    const url = `${baseUrl.replace(/\/$/, '')}/v1/messages`

    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Real Claude Code reaches Foundry through the Anthropic SDK, which
          // sends the claude-cli UA; match it on this raw-fetch path.
          'User-Agent': getUserAgent(),
          'anthropic-version': '2023-06-01',
          [headerName]: headerValue,
          ...(request.clientRequestId && {
            'x-client-request-id': request.clientRequestId,
          }),
        },
        body: JSON.stringify(wireBody),
        signal,
      })
    } catch (error) {
      handleFetchError(error, signal, 'foundry', this.normalizeError)
    }

    await assertOkResponse(response, 'foundry', this.normalizeError)

    const responseBody = assertResponseBody(response, 'foundry')
    const stream = parseAnthropicSSEStream(
      responseBody,
      'foundry',
      this.normalizeError,
    )

    return makeStreamingResponse({
      response,
      stream,
      requestIdHeader: 'request-id',
    })
  },

  async createMessage(
    provider: ResolvedProviderTarget,
    request: DomainMessageRequest,
    signal: AbortSignal,
    fetchOverride?: typeof globalThis.fetch,
  ): Promise<DomainMessageResponse> {
    const { config } = provider
    const fetch = fetchOverride ?? globalThis.fetch
    const baseUrl = config.baseUrl || ''
    const { headerName, headerValue } = await getFoundryAuth(config)

    const wireBody = buildAnthropicWireBody(request)
    wireBody.stream = false

    const url = `${baseUrl.replace(/\/$/, '')}/v1/messages`

    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Real Claude Code reaches Foundry through the Anthropic SDK, which
          // sends the claude-cli UA; match it on this raw-fetch path.
          'User-Agent': getUserAgent(),
          'anthropic-version': '2023-06-01',
          [headerName]: headerValue,
          ...(request.clientRequestId && {
            'x-client-request-id': request.clientRequestId,
          }),
        },
        body: JSON.stringify(wireBody),
        signal,
      })
    } catch (error) {
      if (
        error instanceof Error &&
        (error.name === 'AbortError' || signal.aborted)
      ) {
        throw new DomainUserAbortError()
      }
      const normalized = this.normalizeError(
        { cause: error, mid_stream: false },
        'foundry',
      )
      throw new DomainConnectionError({
        normalized: { ...normalized, kind: 'transport' },
        cause: error,
        raw: error,
      })
    }

    if (!response.ok) {
      const errorText = await response.text()
      const normalized = this.normalizeError(
        { status: response.status, body: errorText, headers: response.headers },
        'foundry',
      )
      throw new DomainTransportError({
        normalized,
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        raw: { status: response.status, body: errorText },
      })
    }

    const json = (await response.json()) as WireMessage
    return {
      message: anthropicMessageToDomain(json),
      requestId: response.headers.get('request-id') ?? undefined,
      responseHeaders: Object.fromEntries(response.headers.entries()),
    }
  },

  async countTokens(
    messages: TokenCountMessageParam[],
    tools: TokenCountToolParam[],
    model: string,
    options?: { system?: string; betas?: string[] },
  ): Promise<TokenBreakdown | null> {
    try {
      const resolved = getProviderRegistry().getProviderForModel(
        model,
      ) as ResolvedProvider | null
      if (!resolved || resolved.config.type !== 'foundry') return null

      const config = resolved.config
      const baseUrl = config.baseUrl || ''
      const { headerName, headerValue } = await getFoundryAuth(config)

      const betas = options?.betas ?? []
      const containsThinking = hasThinkingBlocks(messages)

      const url = `${baseUrl.replace(/\/$/, '')}/v1/messages/count_tokens`
      const body: Record<string, unknown> = {
        model: normalizeModelStringForAPI(model),
        messages:
          messages.length > 0 ? messages : [{ role: 'user', content: 'foo' }],
        tools,
        ...(options?.system && { system: options.system }),
        ...(betas.length > 0 && { betas }),
        ...(containsThinking && {
          thinking: {
            type: 'enabled',
            budget_tokens: TOKEN_COUNT_THINKING_BUDGET,
          },
          max_tokens: TOKEN_COUNT_MAX_TOKENS,
        }),
      }

      const response = await globalThis.fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Real Claude Code reaches Foundry through the Anthropic SDK, which
          // sends the claude-cli UA; match it on this raw-fetch path.
          'User-Agent': getUserAgent(),
          'anthropic-version': '2023-06-01',
          [headerName]: headerValue,
        },
        body: JSON.stringify(body),
      })

      if (!response.ok) return null

      const json = (await response.json()) as Record<string, unknown>
      if (typeof json.input_tokens !== 'number') return null
      return { inputTokens: json.input_tokens, outputTokens: 0 }
    } catch (error) {
      logError(error)
      return null
    }
  },

  normalizeError(raw: unknown, providerType: ProviderType): NormalizedApiError {
    return anthropicAdapter.normalizeError(raw, providerType)
  },
}
