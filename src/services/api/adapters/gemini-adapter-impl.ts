/**
 * Gemini (Vertex AI generateContent) adapter.
 *
 * Implements native domain transport: converts DomainMessageRequest → Gemini
 * generateContent JSON, makes the HTTP request directly, parses Gemini SSE
 * events, and yields DomainStreamEvents — no Anthropic SDK intermediary.
 *
 * Uses Gemini's native `:countTokens` REST endpoint for token counting.
 * Same GCP auth flow for both transport and counting.
 *
 * If anything fails (auth, network, translation) countTokens returns null
 * so the rough estimator can take over.
 */
import type {
  ProviderAdapter,
  FetchFn,
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
import { createGeminiFetch } from '../gemini-adapter.js'
import { logError } from '../../../utils/log.js'
import {
  getProviderRegistry,
  type ResolvedProvider,
} from '../../../utils/model/providerRegistry.js'
import { GoogleAuth } from 'google-auth-library'
import type {
  DomainMessageRequest,
  DomainStreamingResponse,
  DomainMessageParam,
  DomainToolDefinition,
} from '../domain-transport.js'
import type {
  DomainAssistantContent,
  DomainContentBlock,
  DomainStreamEvent,
  DomainStopReason,
} from '../../../types/domain.js'
import {
  DomainTransportError,
  DomainConnectionError,
  DomainUserAbortError,
} from '../domain-errors.js'

/**
 * Translate Anthropic messages into the Gemini `contents` array shape —
 * the minimum needed for `:countTokens` (which ignores tool schemas for the
 * most part but does count the messages + system prompt).
 */
function translateToGeminiContents(
  messages: TokenCountMessageParam[],
): Array<{ role: string; parts: Array<{ text: string }> }> {
  const out: Array<{ role: string; parts: Array<{ text: string }> }> = []
  for (const m of messages) {
    const role = m.role === 'assistant' ? 'model' : 'user'
    const parts: Array<{ text: string }> = []
    if (typeof m.content === 'string') {
      parts.push({ text: m.content })
    } else if (Array.isArray(m.content)) {
      for (const block of m.content) {
        if (block.type === 'text') {
          parts.push({ text: String(block.text ?? '') })
        } else if (block.type === 'tool_use') {
          parts.push({
            text: `${String(block.name ?? '')}(${JSON.stringify(block.input ?? {})})`,
          })
        } else if (block.type === 'tool_result') {
          const content = block.content
          if (typeof content === 'string') parts.push({ text: content })
          else if (Array.isArray(content)) {
            for (const c of content) {
              if (c && typeof c === 'object' && 'text' in c) {
                parts.push({
                  text: String(c.text ?? ''),
                })
              }
            }
          }
        }
      }
    }
    if (parts.length > 0) out.push({ role, parts })
  }
  return out
}

async function getGcpAccessToken(
  config: ProviderConfig,
): Promise<{ token: string; projectId?: string } | null> {
  try {
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
        : { projectId: config.auth?.gcp?.projectId }),
    })
    const authClient = await googleAuth.getClient()
    const headers = (await authClient.getRequestHeaders()) as unknown as Record<
      string,
      string | undefined
    >
    const token = headers['Authorization']?.replace('Bearer ', '')
    if (!token) return null
    const projectId =
      headers['x-goog-user-project'] ||
      (await googleAuth.getProjectId()) ||
      undefined
    return { token, projectId: projectId ?? undefined }
  } catch (err) {
    logError(err)
    return null
  }
}

// ── Gemini wire types ──────────────────────────────────────────────

interface GeminiPart {
  text?: string
  functionCall?: { name: string; args: Record<string, unknown> }
  functionResponse?: {
    name: string
    response: { content: unknown }
  }
  inlineData?: { mimeType: string; data: string }
}

interface GeminiContent {
  role: string
  parts: GeminiPart[]
}

// ── Domain → Gemini request translation ────────────────────────────

function domainToolsToGemini(
  tools: DomainToolDefinition[],
): Record<string, unknown> {
  return {
    functionDeclarations: tools.map(tool => ({
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      parameters: tool.input_schema || { type: 'object', properties: {} },
    })),
  }
}

function domainToolChoiceToGemini(
  toolChoice: DomainMessageRequest['toolChoice'],
): Record<string, unknown> | undefined {
  if (!toolChoice) return undefined
  const modeMap: Record<string, string> = {
    auto: 'AUTO',
    any: 'ANY',
    none: 'NONE',
  }
  const mode = modeMap[toolChoice.type]
  if (!mode) return undefined
  return { functionCallingConfig: { mode } }
}

function domainMessagesToGemini(
  messages: DomainMessageParam[],
): { contents: GeminiContent[]; toolIdToName: Map<string, string> } {
  const toolIdToName = new Map<string, string>()
  for (const msg of messages) {
    if (msg.role === 'assistant') {
      for (const block of msg.content) {
        if (block.type === 'tool_use' && block.id && block.name) {
          toolIdToName.set(block.id, block.name)
        }
      }
    }
  }

  const contents: GeminiContent[] = []
  for (const msg of messages) {
    const role = msg.role === 'assistant' ? 'model' : 'user'
    const parts: GeminiPart[] = []

    for (const block of msg.content) {
      if (block.type === 'text') {
        parts.push({ text: (block as { text: string }).text })
      } else if (block.type === 'tool_use') {
        const tb = block as { name: string; input: unknown }
        parts.push({
          functionCall: {
            name: tb.name || '',
            args: (tb.input as Record<string, unknown>) || {},
          },
        })
      } else if (block.type === 'tool_result') {
        const tr = block as {
          tool_use_id: string
          content?: string | Array<{ type: string; text?: string }>
        }
        const toolName = toolIdToName.get(tr.tool_use_id || '') || 'unknown'
        let resultContent: unknown
        if (typeof tr.content === 'string') {
          resultContent = tr.content
        } else if (Array.isArray(tr.content)) {
          resultContent = tr.content
            .map(c => {
              if (c.type === 'text') return (c as { text?: string }).text ?? ''
              if (c.type === 'image') return '[Image data]'
              return ''
            })
            .join('\n')
        } else {
          resultContent = ''
        }
        parts.push({
          functionResponse: {
            name: toolName,
            response: { content: resultContent },
          },
        })
      } else if (block.type === 'image') {
        const src = (block as { source: { type: string; media_type: string; data: string } }).source
        if (src?.type === 'base64') {
          parts.push({
            inlineData: {
              mimeType: src.media_type,
              data: src.data,
            },
          })
        }
      }
    }

    if (parts.length > 0) {
      contents.push({ role, parts })
    }
  }

  return { contents, toolIdToName }
}

function domainRequestToGeminiBody(
  request: DomainMessageRequest,
): Record<string, unknown> {
  const body: Record<string, unknown> = {}

  if (request.system && request.system.length > 0) {
    const systemText = request.system
      .filter(b => b.type === 'text' && typeof b.text === 'string')
      .map(b => b.text)
      .join('\n')
    if (systemText) {
      body.systemInstruction = { parts: [{ text: systemText }] }
    }
  }

  const { contents } = domainMessagesToGemini(request.messages)
  body.contents = contents

  if (request.tools && request.tools.length > 0) {
    body.tools = [domainToolsToGemini(request.tools)]
    const toolConfig = domainToolChoiceToGemini(request.toolChoice)
    if (toolConfig) {
      body.toolConfig = toolConfig
    }
  }

  const generationConfig: Record<string, unknown> = {}
  if (request.maxTokens) generationConfig.maxOutputTokens = request.maxTokens
  if (request.temperature !== undefined)
    generationConfig.temperature = request.temperature
  if (Object.keys(generationConfig).length > 0) {
    body.generationConfig = generationConfig
  }

  return body
}

// ── Gemini finish reason → DomainStopReason ────────────────────────

function geminiFinishReasonToStopReason(
  reason: string | undefined,
  hadToolCalls: boolean,
): DomainStopReason | null {
  if (hadToolCalls) return 'tool_use'
  if (!reason) return 'end_turn'
  if (reason === 'SAFETY' || reason === 'RECITATION') return null
  if (reason === 'MAX_TOKENS') return 'max_tokens'
  return 'end_turn'
}

// ── Gemini SSE → DomainStreamEvent ─────────────────────────────────

async function* parseGeminiStream(
  response: Response,
  modelId: string,
  providerType: ProviderType,
  normalizeError: (raw: unknown, pt: ProviderType) => NormalizedApiError,
): AsyncGenerator<DomainStreamEvent> {
  const messageId = `msg_gemini_${Date.now()}`

  yield {
    type: 'message_start',
    message: {
      id: messageId,
      type: 'message',
      role: 'assistant',
      content: [],
      model: modelId,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  }

  let contentBlockIndex = 0
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadInputTokens = 0
  let currentTextBlockOpen = false
  let hadToolCalls = false

  const reader = response.body?.getReader()
  if (!reader) {
    const normalized = normalizeError(
      { mid_stream: true, cause: new Error('No response body') },
      providerType,
    )
    throw new DomainConnectionError({
      normalized: { ...normalized, kind: 'transport' },
      cause: new Error('No response body'),
    })
  }

  const decoder = new TextDecoder()
  let buffer = ''

  function closeCurrentTextBlock(): DomainStreamEvent | null {
    if (!currentTextBlockOpen) return null
    currentTextBlockOpen = false
    const event: DomainStreamEvent = {
      type: 'content_block_stop',
      index: contentBlockIndex,
    }
    contentBlockIndex++
    return event
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data: ')) continue

        const dataStr = trimmed.slice(6)
        if (dataStr === '[DONE]') continue

        let chunk: Record<string, unknown>
        try {
          chunk = JSON.parse(dataStr)
        } catch {
          continue
        }

        if (chunk.error && typeof chunk.error === 'object') {
          const normalized = normalizeError(
            { body: JSON.stringify({ error: chunk.error }), mid_stream: true },
            providerType,
          )
          throw new DomainTransportError({
            normalized,
            raw: chunk.error,
          })
        }

        const usageMetadata = chunk.usageMetadata as
          | Record<string, number>
          | undefined
        if (usageMetadata) {
          if (usageMetadata.candidatesTokenCount !== undefined) {
            outputTokens = usageMetadata.candidatesTokenCount
          }
          if (usageMetadata.promptTokenCount !== undefined) {
            const cached = usageMetadata.cachedContentTokenCount ?? 0
            cacheReadInputTokens = cached
            inputTokens = usageMetadata.promptTokenCount - cached
          }
        }

        const candidates = chunk.candidates as
          | Array<Record<string, unknown>>
          | undefined
        if (!candidates || candidates.length === 0) continue

        const candidate = candidates[0]
        const content = candidate.content as
          | { role?: string; parts?: GeminiPart[] }
          | undefined
        const finishReason = candidate.finishReason as string | undefined

        if (content?.parts) {
          for (const part of content.parts) {
            if (part.text !== undefined) {
              if (!currentTextBlockOpen) {
                yield {
                  type: 'content_block_start',
                  index: contentBlockIndex,
                  content_block: { type: 'text', text: '' },
                }
                currentTextBlockOpen = true
              }
              yield {
                type: 'content_block_delta',
                index: contentBlockIndex,
                delta: { type: 'text_delta', text: part.text },
              }
            }

            if (part.functionCall) {
              const closeEvent = closeCurrentTextBlock()
              if (closeEvent) yield closeEvent

              hadToolCalls = true
              const toolUseId = `toolu_gemini_${Date.now()}_${contentBlockIndex}`

              yield {
                type: 'content_block_start',
                index: contentBlockIndex,
                content_block: {
                  type: 'tool_use',
                  id: toolUseId,
                  name: part.functionCall.name,
                  input: {},
                },
              }
              yield {
                type: 'content_block_delta',
                index: contentBlockIndex,
                delta: {
                  type: 'input_json_delta',
                  partial_json: JSON.stringify(part.functionCall.args || {}),
                },
              }
              yield { type: 'content_block_stop', index: contentBlockIndex }
              contentBlockIndex++
            }
          }
        }

        if (finishReason) {
          const closeEvent = closeCurrentTextBlock()
          if (closeEvent) yield closeEvent

          if (finishReason === 'SAFETY' || finishReason === 'RECITATION') {
            const normalized = normalizeError({ finishReason }, providerType)
            throw new DomainTransportError({
              normalized: { ...normalized, kind: 'content_filter' },
              raw: { finishReason },
            })
          }
        }
      }
    }
  } catch (error) {
    const closeEvent = closeCurrentTextBlock()
    if (closeEvent) yield closeEvent

    if (error instanceof DomainTransportError) throw error
    if (error instanceof DomainUserAbortError) throw error

    const normalized = normalizeError(
      { mid_stream: true, cause: error },
      providerType,
    )
    throw new DomainTransportError({ normalized, raw: error })
  }

  const closeEvent = closeCurrentTextBlock()
  if (closeEvent) yield closeEvent

  yield {
    type: 'message_delta',
    delta: {
      stop_reason: geminiFinishReasonToStopReason(undefined, hadToolCalls),
      stop_sequence: null,
    },
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_read_input_tokens: cacheReadInputTokens,
      cache_creation_input_tokens: null,
    },
  }

  yield { type: 'message_stop' }
}

// ── Non-streaming response parsing ─────────────────────────────────

function parseGeminiNonStreamingResponse(
  body: Record<string, unknown>,
  modelId: string,
  normalizeError: (raw: unknown, pt: ProviderType) => NormalizedApiError,
): DomainAssistantContent {
  const candidates = body.candidates as
    | Array<Record<string, unknown>>
    | undefined
  const usageMetadata = body.usageMetadata as
    | Record<string, number>
    | undefined

  const content: DomainContentBlock[] = []
  let hadToolCalls = false

  if (candidates && candidates.length > 0) {
    const candidate = candidates[0]
    const candidateContent = candidate.content as
      | { role?: string; parts?: GeminiPart[] }
      | undefined
    const finishReason = candidate.finishReason as string | undefined

    if (
      finishReason &&
      (finishReason === 'SAFETY' || finishReason === 'RECITATION')
    ) {
      const normalized = normalizeError({ finishReason }, 'gemini')
      throw new DomainTransportError({
        normalized: { ...normalized, kind: 'content_filter' },
        raw: { finishReason },
      })
    }

    if (candidateContent?.parts) {
      for (const part of candidateContent.parts) {
        if (part.text !== undefined) {
          content.push({ type: 'text', text: part.text })
        }
        if (part.functionCall) {
          hadToolCalls = true
          content.push({
            type: 'tool_use',
            id: `toolu_gemini_${Date.now()}_${content.length}`,
            name: part.functionCall.name,
            input: part.functionCall.args || {},
          })
        }
      }
    }
  }

  const stopReason: DomainStopReason = hadToolCalls ? 'tool_use' : 'end_turn'

  return {
    id: `msg_gemini_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    content,
    model: modelId,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens:
        (usageMetadata?.promptTokenCount ?? 0) -
        (usageMetadata?.cachedContentTokenCount ?? 0),
      output_tokens: usageMetadata?.candidatesTokenCount ?? 0,
      cache_read_input_tokens: usageMetadata?.cachedContentTokenCount ?? 0,
      cache_creation_input_tokens: null,
    },
  }
}

// ── Adapter ────────────────────────────────────────────────────────

export const geminiAdapter: ProviderAdapter = {
  providerType: 'gemini',
  capabilities: {} as ProviderCapabilities,

  async createStream(
    config: ProviderConfig,
    _authArgs: unknown,
    request: DomainMessageRequest,
    signal: AbortSignal,
  ): Promise<DomainStreamingResponse> {
    const authResult = await getGcpAccessToken(config)
    if (!authResult) {
      throw new DomainConnectionError({
        normalized: {
          kind: 'auth',
          message: 'Failed to obtain GCP access token for Gemini',
          providerType: 'gemini',
          raw: null,
        },
        cause: new Error('Failed to obtain GCP access token'),
      })
    }

    const region = config.auth?.gcp?.region || 'us-central1'
    const projectId = config.auth?.gcp?.projectId || authResult.projectId || ''
    const baseUrl =
      config.baseUrl ||
      `https://${region}-aiplatform.googleapis.com/v1`
    const geminiUrl = `${baseUrl.replace(/\/$/, '')}/projects/${projectId}/locations/${region}/publishers/google/models/${request.model}:streamGenerateContent?alt=sse`

    const geminiBody = domainRequestToGeminiBody(request)

    let response: Response
    try {
      response = await globalThis.fetch(geminiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authResult.token}`,
        },
        body: JSON.stringify(geminiBody),
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
        'gemini',
      )
      throw new DomainConnectionError({
        normalized: { ...normalized, kind: 'transport' },
        cause: error,
      })
    }

    if (!response.ok) {
      const errorText = await response.text()
      const normalized = this.normalizeError(
        {
          status: response.status,
          body: errorText,
          headers: response.headers,
        },
        'gemini',
      )
      throw new DomainTransportError({
        normalized,
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        raw: { status: response.status, body: errorText },
      })
    }

    const abortController = new AbortController()
    const stream = parseGeminiStream(
      response,
      request.model,
      'gemini',
      this.normalizeError,
    )

    return {
      stream,
      requestId: response.headers.get('x-request-id') ?? undefined,
      responseHeaders: Object.fromEntries(response.headers.entries()),
      abort() {
        abortController.abort()
      },
      release() {
        try {
          abortController.abort()
        } catch {
          // ignore
        }
        if (response.body) {
          response.body.cancel().catch(() => {})
        }
      },
    }
  },

  async createMessage(
    config: ProviderConfig,
    _authArgs: unknown,
    request: DomainMessageRequest,
    signal: AbortSignal,
  ): Promise<DomainAssistantContent> {
    const authResult = await getGcpAccessToken(config)
    if (!authResult) {
      throw new DomainConnectionError({
        normalized: {
          kind: 'auth',
          message: 'Failed to obtain GCP access token for Gemini',
          providerType: 'gemini',
          raw: null,
        },
        cause: new Error('Failed to obtain GCP access token'),
      })
    }

    const region = config.auth?.gcp?.region || 'us-central1'
    const projectId = config.auth?.gcp?.projectId || authResult.projectId || ''
    const baseUrl =
      config.baseUrl ||
      `https://${region}-aiplatform.googleapis.com/v1`
    const geminiUrl = `${baseUrl.replace(/\/$/, '')}/projects/${projectId}/locations/${region}/publishers/google/models/${request.model}:generateContent`

    const geminiBody = domainRequestToGeminiBody(request)

    let response: Response
    try {
      response = await globalThis.fetch(geminiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authResult.token}`,
        },
        body: JSON.stringify(geminiBody),
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
        'gemini',
      )
      throw new DomainConnectionError({
        normalized: { ...normalized, kind: 'transport' },
        cause: error,
      })
    }

    if (!response.ok) {
      const errorText = await response.text()
      const normalized = this.normalizeError(
        {
          status: response.status,
          body: errorText,
          headers: response.headers,
        },
        'gemini',
      )
      throw new DomainTransportError({
        normalized,
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        raw: { status: response.status, body: errorText },
      })
    }

    const json = (await response.json()) as Record<string, unknown>
    return parseGeminiNonStreamingResponse(json, request.model, this.normalizeError)
  },

  createFetch(config: ProviderConfig, authArgs: unknown): FetchFn {
    return createGeminiFetch(
      config,
      authArgs as Parameters<typeof createGeminiFetch>[1],
    )
  },

  async countTokens(
    messages: TokenCountMessageParam[],
    _tools: TokenCountToolParam[],
    model: string,
    options?: { system?: string; betas?: string[] },
  ): Promise<TokenBreakdown | null> {
    try {
      const resolved = getProviderRegistry().getProviderForModel(
        model,
      ) as ResolvedProvider | null
      if (!resolved || resolved.config.type !== 'gemini') return null

      const access = await getGcpAccessToken(resolved.config)
      if (!access) return null

      const region = resolved.config.auth?.gcp?.region || 'us-central1'
      const configProjectId =
        resolved.config.auth?.gcp?.projectId || access.projectId || ''
      const baseUrl =
        resolved.config.baseUrl ||
        `https://${region}-aiplatform.googleapis.com/v1`
      const url = `${baseUrl.replace(/\/$/, '')}/projects/${configProjectId}/locations/${region}/publishers/google/models/${model}:countTokens`

      const body: Record<string, unknown> = {
        contents: translateToGeminiContents(messages),
      }
      if (options?.system) {
        body.systemInstruction = {
          parts: [{ text: options.system }],
        }
      }

      const response = await globalThis.fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${access.token}`,
        },
        body: JSON.stringify(body),
      })

      if (!response.ok) return null
      const json = (await response.json()) as { totalTokens?: number }
      if (typeof json.totalTokens !== 'number') return null
      return { inputTokens: json.totalTokens, outputTokens: 0 }
    } catch (err) {
      logError(err)
      return null
    }
  },

  normalizeError(raw: unknown, providerType: ProviderType): NormalizedApiError {
    const r = (raw ?? {}) as {
      status?: number
      body?: unknown
      headers?: Headers | Record<string, string>
      mid_stream?: boolean
      cause?: unknown
      finishReason?: string
    }
    // SAFETY / RECITATION on a candidate is Google's content-filter signal.
    if (r.finishReason === 'SAFETY' || r.finishReason === 'RECITATION') {
      return {
        kind: 'content_filter',
        message: `Google ${r.finishReason}`,
        providerType,
        raw,
      }
    }

    // Google error shape: { error: { code, status, message } }
    let googleStatus: string | undefined
    let errMessage: string | undefined
    if (r.body) {
      try {
        const parsed =
          typeof r.body === 'string'
            ? (JSON.parse(r.body) as {
                error?: { code?: number; status?: string; message?: string }
              })
            : (r.body as {
                error?: { code?: number; status?: string; message?: string }
              })
        googleStatus = parsed?.error?.status
        errMessage = parsed?.error?.message
      } catch {
        // body is not JSON.
      }
    }

    const reclassifyByGoogleStatus = (
      base: NormalizedApiError,
    ): NormalizedApiError => {
      if (!googleStatus) return base
      if (googleStatus === 'RESOURCE_EXHAUSTED') {
        return { ...base, kind: 'rate_limit' }
      }
      if (
        googleStatus === 'PERMISSION_DENIED' ||
        googleStatus === 'UNAUTHENTICATED'
      ) {
        return { ...base, kind: 'auth' }
      }
      if (googleStatus === 'INVALID_ARGUMENT' || googleStatus === 'NOT_FOUND') {
        return { ...base, kind: 'invalid_request' }
      }
      if (googleStatus === 'UNAVAILABLE' || googleStatus === 'INTERNAL') {
        return { ...base, kind: 'server' }
      }
      return base
    }

    if (typeof r.status === 'number') {
      const base = fromHttpStatus(
        r.status,
        errMessage ??
          (typeof r.body === 'string' ? r.body : `HTTP ${r.status}`),
        providerType,
        r.headers,
        raw,
      )
      return reclassifyByGoogleStatus(base)
    }

    const causeMsg =
      r.cause instanceof Error
        ? r.cause.message
        : String(r.cause ?? 'stream error')
    // Mid-stream / pre-stream connection errors with no HTTP status are
    // classified `transport` so withRetry treats them as retryable.
    const base: NormalizedApiError = {
      kind: 'transport',
      message: errMessage ?? causeMsg,
      providerType,
      raw,
    }
    return reclassifyByGoogleStatus(base)
  },
}
