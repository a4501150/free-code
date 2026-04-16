import Anthropic, { type ClientOptions } from '@anthropic-ai/sdk'
import { randomUUID } from 'crypto'
import {
  computeCch,
  hasCchPlaceholder,
  replaceCchPlaceholder,
} from 'src/utils/cch.js'
import {
  checkAndRefreshOAuthTokenIfNeeded,
  getAnthropicApiKey,
  getApiKeyFromApiKeyHelper,
  getCodexOAuthTokens,
  refreshAndGetAwsCredentials,
  refreshGcpCredentialsIfNeeded,
} from 'src/utils/auth.js'
import { getUserAgent } from 'src/utils/http.js'
import { getProxyFetchOptions } from 'src/utils/proxy.js'
import {
  getIsNonInteractiveSession,
  getSessionId,
} from '../../bootstrap/state.js'
import { isDebugToStdErr, logForDebugging } from '../../utils/debug.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { createCodexFetch } from './codex-fetch-adapter.js'
import { createChatCompletionsFetch } from './openai-chat-completions-adapter.js'
import { createBedrockConverseFetch } from './bedrock-converse-adapter.js'
import { createVertexFetch } from './vertex-adapter.js'
import { createFoundryFetch } from './foundry-adapter.js'
import { createGeminiFetch } from './gemini-adapter.js'
import {
  getProviderRegistry,
  type ResolvedProvider,
} from '../../utils/model/providerRegistry.js'

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

export async function getAnthropicClient({
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
  const containerId = process.env.CLAUDE_CODE_CONTAINER_ID
  const clientApp = process.env.CLAUDE_AGENT_SDK_CLIENT_APP
  const customHeaders = getCustomHeaders()
  const defaultHeaders: { [key: string]: string } = {
    'x-app': 'cli',
    'User-Agent': getUserAgent(),
    'X-Claude-Code-Session-Id': getSessionId(),
    ...customHeaders,
    ...(containerId ? { 'x-claude-remote-container-id': containerId } : {}),
    ...(clientApp ? { 'x-client-app': clientApp } : {}),
  }

  logForDebugging(
    `[API:request] Creating client, ANTHROPIC_CUSTOM_HEADERS present: ${!!process.env.ANTHROPIC_CUSTOM_HEADERS}, has Authorization header: ${!!customHeaders['Authorization']}`,
  )

  const additionalProtectionEnabled = isEnvTruthy(
    process.env.CLAUDE_CODE_ADDITIONAL_PROTECTION,
  )
  if (additionalProtectionEnabled) {
    defaultHeaders['x-anthropic-additional-protection'] = 'true'
  }

  logForDebugging('[API:auth] OAuth token check starting')
  await checkAndRefreshOAuthTokenIfNeeded()
  logForDebugging('[API:auth] OAuth token check complete')

  // Only inject API key / bearer token headers when the default provider
  // uses apiKey or bearer auth (not OAuth). This avoids conflicting
  // Authorization headers when OAuth is configured.
  const defaultAuthActive = getProviderRegistry()
    .getDefaultProvider()
    ?.config.auth?.active
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

  // ── Unified provider-registry dispatch ───────────────────────────
  // All providers (anthropic, bedrock, vertex, foundry, openai, etc.)
  // are resolved through the registry. Legacy env vars are auto-migrated
  // to provider configs at registry init time.
  const registry = getProviderRegistry()

  // 1. Try exact model match in registry
  const resolved = model
    ? registry.getProviderForModel(model)
    : null

  if (resolved) {
    const client = await createClientForProvider(resolved, ARGS, { apiKey })
    if (client) return client
  }

  // 2. No exact match — use the default provider.
  // This handles: model=undefined, and unknown model strings (e.g. model
  // validation probes that send arbitrary model IDs to the API — the API
  // itself returns 404 if the model doesn't exist).
  const defaultResolved = resolveDefaultProvider(registry)
  if (defaultResolved) {
    const client = await createClientForProvider(
      defaultResolved,
      ARGS,
      { apiKey },
    )
    if (client) return client
  }

  // 3. Registry is completely empty (should not happen after migration,
  // but guard against it). Fail with a clear error.
  throw new Error(
    'No providers configured. Set providers in freecode.json or ' +
      'configure ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL environment variables.',
  )
}

/**
 * When no model is specified, resolve the default provider from the registry.
 * Uses the first model of the first (default) provider.
 */
function resolveDefaultProvider(
  registry: ReturnType<typeof getProviderRegistry>,
): ResolvedProvider | null {
  const defaultProvider = registry.getDefaultProvider()
  if (!defaultProvider) return null
  const firstModel = defaultProvider.config.models[0]
  if (!firstModel) return null
  return registry.getProviderForModel(firstModel.id)
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

export const CLIENT_REQUEST_ID_HEADER = 'x-client-request-id'

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

// ── Provider-registry client creation ─────────────────────────────────

/**
 * Resolve auth headers from a provider's auth config.
 */
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
        (auth.bearer?.tokenEnv
          ? process.env[auth.bearer.tokenEnv]
          : undefined)
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

/**
 * Create a client for any provider type resolved from the registry.
 * Handles ALL provider types — no fallthrough to legacy code.
 */
async function createClientForProvider(
  provider: ResolvedProvider,
  baseArgs: Record<string, unknown>,
  opts: { apiKey?: string } = {},
): Promise<Anthropic | null> {
  const { config } = provider

  switch (config.type) {
    // ── Anthropic native (direct API, Claude.ai, or proxy) ──────
    case 'anthropic': {
      const clientConfig: ConstructorParameters<typeof Anthropic>[0] = {
        ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
        ...baseArgs,
        ...(isDebugToStdErr() && { logger: createStderrLogger() }),
      }

      // Auth is purely config-driven via config.auth.active.
      // OAuth tokens, API keys, and bearer tokens are all resolved from
      // the provider config — no runtime isClaudeAISubscriber() checks.
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

    // ── OpenAI Chat Completions ─────────────────────────────────
    case 'openai-chat-completions': {
      const authHeaders = resolveAuthHeaders(provider)
      const fetch = createChatCompletionsFetch(config, authHeaders)
      return new Anthropic({
        apiKey: 'provider-registry-placeholder',
        ...baseArgs,
        fetch: fetch as unknown as typeof globalThis.fetch,
      })
    }

    // ── OpenAI Responses API (Codex) ────────────────────────────
    case 'openai-responses': {
      // Get Codex OAuth tokens at runtime (may have been refreshed)
      const codexTokens = getCodexOAuthTokens()
      const accessToken = codexTokens?.accessToken
      if (!accessToken) {
        // Fall back to auth headers from config
        const authHeaders = resolveAuthHeaders(provider)
        if (!authHeaders['Authorization']) return null
        // TODO: createCodexFetch currently requires a token string directly;
        // for now, extract from Authorization header
        const token = authHeaders['Authorization'].replace('Bearer ', '')
        const codexFetch = createCodexFetch({ accessToken: token, baseUrl: config.baseUrl, getSessionId })
        return new Anthropic({
          apiKey: 'codex-placeholder',
          ...baseArgs,
          fetch: codexFetch as unknown as typeof globalThis.fetch,
          ...(isDebugToStdErr() && { logger: createStderrLogger() }),
        })
      }
      // Pass a callback so the adapter can get refreshed tokens without importing auth
      const codexFetch = createCodexFetch({
        accessToken,
        getRefreshedToken: () => getCodexOAuthTokens()?.accessToken ?? null,
        baseUrl: config.baseUrl,
        getSessionId,
      })
      return new Anthropic({
        apiKey: 'codex-placeholder',
        ...baseArgs,
        fetch: codexFetch as unknown as typeof globalThis.fetch,
        ...(isDebugToStdErr() && { logger: createStderrLogger() }),
      })
    }

    // ── AWS Bedrock ─────────────────────────────────────────────
    case 'bedrock-converse': {
      const getCredentials = async () => {
        if (process.env.AWS_BEARER_TOKEN_BEDROCK) {
          return null
        }
        if (!isEnvTruthy(process.env.CLAUDE_CODE_SKIP_BEDROCK_AUTH)) {
          const creds = await refreshAndGetAwsCredentials()
          if (creds) {
            return {
              accessKeyId: creds.accessKeyId,
              secretAccessKey: creds.secretAccessKey,
              sessionToken: creds.sessionToken,
            }
          }
        }
        return null
      }
      const fetch = createBedrockConverseFetch(config, getCredentials)
      return new Anthropic({
        apiKey: 'bedrock-placeholder',
        ...baseArgs,
        fetch: fetch as unknown as typeof globalThis.fetch,
        ...(isDebugToStdErr() && { logger: createStderrLogger() }),
      })
    }

    // ── Google Vertex AI ────────────────────────────────────────
    case 'vertex': {
      const getAccessToken = async () => {
        if (!isEnvTruthy(process.env.CLAUDE_CODE_SKIP_VERTEX_AUTH)) {
          await refreshGcpCredentialsIfNeeded()
        }
        const { GoogleAuth } = await import('google-auth-library')

        const hasProjectEnvVar =
          process.env['GCLOUD_PROJECT'] ||
          process.env['GOOGLE_CLOUD_PROJECT'] ||
          process.env['gcloud_project'] ||
          process.env['google_cloud_project']
        const hasKeyFile =
          process.env['GOOGLE_APPLICATION_CREDENTIALS'] ||
          process.env['google_application_credentials']

        const googleAuth = isEnvTruthy(
          process.env.CLAUDE_CODE_SKIP_VERTEX_AUTH,
        )
          ? ({
              getClient: () => ({
                getRequestHeaders: () => ({}),
              }),
            } as unknown as InstanceType<typeof GoogleAuth>)
          : new GoogleAuth({
              scopes: ['https://www.googleapis.com/auth/cloud-platform'],
              ...(hasProjectEnvVar || hasKeyFile
                ? {}
                : {
                    projectId: process.env.ANTHROPIC_VERTEX_PROJECT_ID,
                  }),
            })

        const authClient = await googleAuth.getClient()
        const headers = await authClient.getRequestHeaders()
        const token =
          headers['Authorization']?.replace('Bearer ', '') || ''
        const projectId =
          headers['x-goog-user-project'] ||
          (await googleAuth.getProjectId()) ||
          undefined
        return { token, projectId: projectId ?? undefined }
      }
      const fetch = createVertexFetch(config, getAccessToken)
      return new Anthropic({
        apiKey: 'vertex-placeholder',
        ...baseArgs,
        fetch: fetch as unknown as typeof globalThis.fetch,
        ...(isDebugToStdErr() && { logger: createStderrLogger() }),
      })
    }

    // ── Azure Foundry ───────────────────────────────────────────
    case 'foundry': {
      const getToken = async () => {
        // If an API key is configured, return it as the token.
        // The adapter uses heuristics to set the right header (x-api-key vs Bearer).
        const apiKeyFromAuth = resolveAuthHeaders(provider)['x-api-key']
        if (apiKeyFromAuth) {
          return apiKeyFromAuth
        }
        if (isEnvTruthy(process.env.CLAUDE_CODE_SKIP_FOUNDRY_AUTH)) {
          return ''
        }
        const {
          DefaultAzureCredential: AzureCredential,
          getBearerTokenProvider,
        } = await import('@azure/identity')
        const tokenProvider = getBearerTokenProvider(
          new AzureCredential(),
          'https://cognitiveservices.azure.com/.default',
        )
        return tokenProvider()
      }
      const fetch = createFoundryFetch(config, getToken)
      return new Anthropic({
        apiKey: 'foundry-placeholder',
        ...baseArgs,
        fetch: fetch as unknown as typeof globalThis.fetch,
        ...(isDebugToStdErr() && { logger: createStderrLogger() }),
      })
    }

    // ── Gemini (Vertex AI generateContent) ───────────────────────
    case 'gemini': {
      const getAccessToken = async () => {
        const { GoogleAuth } = await import('google-auth-library')

        const hasProjectEnvVar =
          process.env['GCLOUD_PROJECT'] ||
          process.env['GOOGLE_CLOUD_PROJECT'] ||
          process.env['gcloud_project'] ||
          process.env['google_cloud_project']
        const hasKeyFile =
          process.env['GOOGLE_APPLICATION_CREDENTIALS'] ||
          process.env['google_application_credentials']

        const googleAuth = new GoogleAuth({
          scopes: ['https://www.googleapis.com/auth/cloud-platform'],
          ...(hasProjectEnvVar || hasKeyFile
            ? {}
            : {
                projectId: config.auth?.gcp?.projectId,
              }),
        })

        const authClient = await googleAuth.getClient()
        const headers = await authClient.getRequestHeaders()
        const token =
          headers['Authorization']?.replace('Bearer ', '') || ''
        const projectId =
          headers['x-goog-user-project'] ||
          (await googleAuth.getProjectId()) ||
          undefined
        return { token, projectId: projectId ?? undefined }
      }
      const fetch = createGeminiFetch(config, getAccessToken)
      return new Anthropic({
        apiKey: 'gemini-placeholder',
        ...baseArgs,
        fetch: fetch as unknown as typeof globalThis.fetch,
        ...(isDebugToStdErr() && { logger: createStderrLogger() }),
      })
    }

    default:
      return null
  }
}
