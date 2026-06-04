/**
 * Anthropic-native adapter.
 *
 * The only adapter that uses `@anthropic-ai/sdk`. All SDK-specific
 * helpers (error wrapping, stream conversion) are private to this file.
 *
 * For streaming, uses raw `Stream<BetaRawMessageStreamEvent>` (not
 * `BetaMessageStream`) to avoid O(n²) partial JSON parsing in tool input
 * accumulation.
 */
import Anthropic, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
  type ClientOptions,
} from '@anthropic-ai/sdk'
import type {
  BetaMessageStreamParams,
  BetaRawMessageStreamEvent,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type { Stream } from '@anthropic-ai/sdk/streaming.mjs'
import { randomUUID } from 'crypto'
import {
  getIsNonInteractiveSession,
  getSessionId,
} from '../../../bootstrap/state.js'
import { CLIENT_REQUEST_ID_HEADER } from '../../../constants/api.js'
import type { DomainStreamEvent } from '../../../types/domain.js'
import {
  anthropicMessageToDomain,
  createAnthropicStreamEventConverter,
  type WireStreamEvent,
} from '../../../types/domainConversion.js'
import {
  checkAndRefreshOAuthTokenIfNeeded,
  getAnthropicApiKey,
  getApiKeyFromApiKeyHelper,
} from '../../../utils/auth.js'
import {
  computeCch,
  hasCchPlaceholder,
  replaceCchPlaceholder,
} from '../../../utils/cch.js'
import { isDebugToStdErr, logForDebugging } from '../../../utils/debug.js'
import { isEnvTruthy } from '../../../utils/envUtils.js'
import { getUserAgent } from '../../../utils/http.js'
import {
  getProviderRegistry,
  type ResolvedProvider,
} from '../../../utils/model/providerRegistry.js'
import { normalizeModelStringForAPI } from '../../../utils/model/modelResolution.js'
import {
  fromHttpStatus,
  type NormalizedApiError,
} from '../../../utils/normalizedError.js'
import { getProxyFetchOptions } from '../../../utils/proxy.js'
import type {
  ProviderConfig,
  ProviderType,
} from '../../../utils/settings/types.js'
import {
  hasThinkingBlocks,
  TOKEN_COUNT_THINKING_BUDGET,
  type ProviderAdapter,
  type TokenBreakdown,
  type TokenCountMessageParam,
  type TokenCountToolParam,
} from '../adapter.js'
import {
  DomainConnectionError,
  DomainConnectionTimeoutError,
  DomainTransportError,
  DomainUserAbortError,
} from '../domain-errors.js'
import type {
  DomainMessageRequest,
  DomainMessageResponse,
  DomainStreamingResponse,
} from '../domain-transport.js'
import { buildAnthropicWireBody } from './anthropic-wire-body.js'

// ── Anthropic SDK client factory (private to this adapter) ──────────

function createStderrLogger(): ClientOptions['logger'] {
  return {
    error: (msg, ...args) =>
      // biome-ignore lint/suspicious/noConsole:: intentional console output -- SDK logger must use console
      console.error('[Anthropic SDK ERROR]', msg, ...args),
    // biome-ignore lint/suspicious/noConsole:: intentional console output -- SDK logger must use console
    warn: (msg, ...args) => console.error('[Anthropic SDK WARN]', msg, ...args),
    // biome-ignore lint/suspicious/noConsole:: intentional console output -- SDK logger must use console
    info: (msg, ...args) => console.error('[Anthropic SDK INFO]', msg, ...args),
    debug: (msg, ...args) =>
      // biome-ignore lint/suspicious/noConsole:: intentional console output -- SDK logger must use console
      console.error('[Anthropic SDK DEBUG]', msg, ...args),
  }
}

function getCustomHeaders(): Record<string, string> {
  const customHeaders: Record<string, string> = {}
  const customHeadersEnv = process.env.ANTHROPIC_CUSTOM_HEADERS

  if (!customHeadersEnv) return customHeaders

  const headerStrings = customHeadersEnv.split(/\n|\r\n/)

  for (const headerString of headerStrings) {
    if (!headerString.trim()) continue

    const colonIdx = headerString.indexOf(':')
    if (colonIdx === -1) continue
    const name = headerString.slice(0, colonIdx).trim()
    const value = headerString.slice(colonIdx + 1).trim()
    if (name) {
      customHeaders[name] = value
    }
  }

  return customHeaders
}

async function configureApiKeyHeaders(
  headers: Record<string, string>,
  isNonInteractiveSession: boolean,
): Promise<void> {
  const token =
    process.env.ANTHROPIC_AUTH_TOKEN ||
    (await getApiKeyFromApiKeyHelper(isNonInteractiveSession))
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }
}

function resolveAuthHeaders(
  provider: ResolvedProvider,
): Record<string, string> {
  const auth = provider.config.auth
  if (!auth) return {}

  switch (auth.active) {
    case 'apiKey': {
      const key =
        auth.apiKey?.key ||
        (auth.apiKey?.keyEnv ? process.env[auth.apiKey.keyEnv] : undefined)
      if (!key) return {}
      if (provider.config.type === 'anthropic') {
        return { 'x-api-key': key }
      }
      return { Authorization: `Bearer ${key}` }
    }
    case 'bearer': {
      const token =
        auth.bearer?.token ||
        (auth.bearer?.tokenEnv ? process.env[auth.bearer.tokenEnv] : undefined)
      if (!token) return {}
      return { Authorization: `Bearer ${token}` }
    }
    case 'oauth': {
      const token = auth.oauth?.accessToken
      if (!token) return {}
      return { Authorization: `Bearer ${token}` }
    }
    default:
      return {}
  }
}

function buildFetch(
  fetchOverride: ClientOptions['fetch'],
  source: string | undefined,
  model?: string,
): ClientOptions['fetch'] {
  // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
  const inner = fetchOverride ?? globalThis.fetch
  const injectClientRequestId = model
    ? getProviderRegistry().getCapability(model, 'clientRequestId')
    : getProviderRegistry().getCapabilities().clientRequestId
  return async (input, init) => {
    // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
    const headers = new Headers(init?.headers)
    if (injectClientRequestId && !headers.has(CLIENT_REQUEST_ID_HEADER)) {
      headers.set(CLIENT_REQUEST_ID_HEADER, randomUUID())
    }

    let body = init?.body
    try {
      // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
      const url = input instanceof Request ? input.url : String(input)
      const id = headers.get(CLIENT_REQUEST_ID_HEADER)
      logForDebugging(
        `[API REQUEST] ${new URL(url).pathname}${id ? ` ${CLIENT_REQUEST_ID_HEADER}=${id}` : ''} source=${source ?? 'unknown'}`,
      )

      if (
        url.includes('/v1/messages') &&
        headers.has('anthropic-version') &&
        typeof body === 'string' &&
        hasCchPlaceholder(body)
      ) {
        const cch = await computeCch(body)
        body = replaceCchPlaceholder(body, cch)
        logForDebugging(`[CCH] signed request cch=${cch}`)
      }
    } catch {
      // never let logging crash the fetch
    }
    return inner(input, { ...init, headers, body })
  }
}

function resolveDefaultProvider(
  registry: ReturnType<typeof getProviderRegistry>,
): ResolvedProvider | null {
  const defaultProvider = registry.getDefaultProvider()
  if (!defaultProvider) return null
  const firstModel = defaultProvider.config.models[0]
  if (!firstModel) return null
  return registry.getProviderForModel(firstModel.id)
}

async function createClientForProvider(
  provider: ResolvedProvider,
  baseArgs: Record<string, unknown>,
  opts: { apiKey?: string } = {},
): Promise<Anthropic | null> {
  const { config } = provider

  if (config.type !== 'anthropic') {
    return null
  }

  const clientConfig: ConstructorParameters<typeof Anthropic>[0] = {
    ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
    ...baseArgs,
    ...(isDebugToStdErr() && { logger: createStderrLogger() }),
  }

  const authActive = config.auth?.active
  if (authActive === 'oauth') {
    const token = config.auth?.oauth?.accessToken
    clientConfig.apiKey = null
    clientConfig.authToken = token || undefined
  } else if (authActive === 'bearer') {
    const headers = resolveAuthHeaders(provider)
    clientConfig.apiKey = 'bearer-placeholder'
    clientConfig.defaultHeaders = {
      ...(clientConfig.defaultHeaders as Record<string, string>),
      ...headers,
    }
  } else {
    // apiKey auth (default)
    const authHeaders = resolveAuthHeaders(provider)
    const resolvedKey =
      authHeaders['x-api-key'] || opts.apiKey || getAnthropicApiKey()
    clientConfig.apiKey = resolvedKey || ''
  }

  return new Anthropic(clientConfig)
}

async function getAnthropicClient({
  apiKey,
  maxRetries,
  model,
  fetchOverride,
  source,
}: {
  apiKey?: string
  maxRetries: number
  model?: string
  fetchOverride?: ClientOptions['fetch']
  source?: string
}): Promise<Anthropic> {
  const earlyRegistry = getProviderRegistry()
  const resolvedProviderType =
    (model ? earlyRegistry.getProviderForModel(model)?.config.type : null) ??
    earlyRegistry.getDefaultProvider()?.config.type
  const isAnthropicProvider = resolvedProviderType === 'anthropic'

  const containerId = process.env.CLAUDE_CODE_CONTAINER_ID
  const clientApp = process.env.CLAUDE_AGENT_SDK_CLIENT_APP
  const customHeaders = getCustomHeaders()
  const defaultHeaders: { [key: string]: string } = {
    'User-Agent': getUserAgent(),
    ...customHeaders,
    ...(isAnthropicProvider && {
      'x-app': 'cli',
      'X-Claude-Code-Session-Id': getSessionId(),
      ...(containerId ? { 'x-claude-remote-container-id': containerId } : {}),
      ...(clientApp ? { 'x-client-app': clientApp } : {}),
    }),
  }

  logForDebugging(
    `[API:request] Creating client, ANTHROPIC_CUSTOM_HEADERS present: ${!!process.env.ANTHROPIC_CUSTOM_HEADERS}, has Authorization header: ${!!customHeaders['Authorization']}`,
  )

  const additionalProtectionEnabled = isEnvTruthy(
    process.env.CLAUDE_CODE_ADDITIONAL_PROTECTION,
  )
  if (additionalProtectionEnabled && isAnthropicProvider) {
    defaultHeaders['x-anthropic-additional-protection'] = 'true'
  }

  logForDebugging('[API:auth] OAuth token check starting')
  await checkAndRefreshOAuthTokenIfNeeded()
  logForDebugging('[API:auth] OAuth token check complete')

  const defaultAuthActive =
    getProviderRegistry().getDefaultProvider()?.config.auth?.active
  if (defaultAuthActive !== 'oauth') {
    await configureApiKeyHeaders(defaultHeaders, getIsNonInteractiveSession())
  }

  const resolvedFetch = buildFetch(fetchOverride, source, model)

  const ARGS = {
    defaultHeaders,
    maxRetries,
    timeout: parseInt(process.env.API_TIMEOUT_MS || String(600 * 1000), 10),
    dangerouslyAllowBrowser: true,
    fetchOptions: getProxyFetchOptions({
      forAnthropicAPI: true,
    }) as ClientOptions['fetchOptions'],
    ...(resolvedFetch && {
      fetch: resolvedFetch,
    }),
  }

  const registry = earlyRegistry

  const resolved = model ? registry.getProviderForModel(model) : null

  if (resolved) {
    const client = await createClientForProvider(resolved, ARGS, { apiKey })
    if (client) return client
  }

  const defaultResolved = resolveDefaultProvider(registry)
  if (defaultResolved) {
    const client = await createClientForProvider(defaultResolved, ARGS, {
      apiKey,
    })
    if (client) return client
  }

  throw new Error(
    'No Anthropic provider configured. Non-Anthropic models should be routed through their native adapters. ' +
      'Set providers in freecode.json or configure ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL environment variables.',
  )
}

// ── SDK-specific helpers (private to this adapter) ───────────────────

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
    const convertStreamEvent = createAnthropicStreamEventConverter()
    try {
      for await (const event of sdkStream) {
        const domainEvent = convertStreamEvent(
          event as unknown as WireStreamEvent,
        )
        if (domainEvent) yield domainEvent
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

// ── Token counting via Anthropic endpoint ───────────────────────────

async function countTokensViaAnthropicEndpoint({
  messages,
  tools,
  model,
  betas,
  system,
}: {
  messages: TokenCountMessageParam[]
  tools: TokenCountToolParam[]
  model: string
  betas: string[]
  system?: string
}): Promise<number | null> {
  const containsThinking = hasThinkingBlocks(messages)
  const anthropic = await getAnthropicClient({
    maxRetries: 1,
    model,
    source: 'count_tokens',
  })
  const response = await anthropic.beta.messages.countTokens({
    model: normalizeModelStringForAPI(model),
    messages:
      messages.length > 0 ? messages : [{ role: 'user', content: 'foo' }],
    tools,
    ...(system && { system }),
    ...(betas.length > 0 && { betas }),
    ...(containsThinking && {
      thinking: {
        type: 'enabled',
        budget_tokens: TOKEN_COUNT_THINKING_BUDGET,
      },
    }),
  } as unknown as Parameters<typeof anthropic.beta.messages.countTokens>[0])
  if (typeof response.input_tokens !== 'number') {
    return null
  }
  return response.input_tokens
}

// ── Adapter ──────────────────────────────────────────────────────────

export const anthropicAdapter: ProviderAdapter = {
  providerType: 'anthropic',

  async createStream(
    _config: ProviderConfig,
    request: DomainMessageRequest,
    signal: AbortSignal,
    fetchOverride?: typeof globalThis.fetch,
  ): Promise<DomainStreamingResponse> {
    const client = await getAnthropicClient({
      maxRetries: 0,
      model: request.model,
      source: 'adapter',
      fetchOverride,
    })
    const params = buildAnthropicWireBody(
      request,
    ) as unknown as BetaMessageStreamParams

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
    fetchOverride?: typeof globalThis.fetch,
  ): Promise<DomainMessageResponse> {
    const configApiKey = config.auth?.apiKey?.key
    const client = await getAnthropicClient({
      maxRetries: 0,
      model: request.model,
      source: 'adapter',
      fetchOverride,
      ...(configApiKey && { apiKey: configApiKey }),
    })
    const params = buildAnthropicWireBody(
      request,
    ) as unknown as BetaMessageStreamParams

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
        message: anthropicMessageToDomain(
          result.data as unknown as Parameters<
            typeof anthropicMessageToDomain
          >[0],
        ),
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
    if (inputTokens === null) return null
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
