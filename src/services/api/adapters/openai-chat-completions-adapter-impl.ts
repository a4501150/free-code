/**
 * OpenAI Chat Completions adapter.
 *
 * Implements native domain transport: converts DomainMessageRequest → OpenAI
 * Chat Completions JSON, makes the HTTP request directly, parses OpenAI SSE
 * events, and yields DomainStreamEvents — no Anthropic SDK intermediary.
 *
 * Token counting uses the `gpt-tokenizer` npm package locally so `/context`
 * and statusline pre-flight counting do not require a live round-trip.
 * `gpt-tokenizer` ships `cl100k_base` (GPT-3.5 / GPT-4 family) and
 * `o200k_base` (GPT-4o / o-series) encodings. We pick based on a small
 * model-family allow-list; unknown models default to `o200k_base`, the
 * encoding for all recently-released OpenAI models.
 *
 * Dynamic import of `gpt-tokenizer` keeps the ~120KB gzipped encoding data
 * out of builds that do not configure an OpenAI provider.
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
import type {
  DomainMessageRequest,
  DomainMessageResponse,
  DomainStreamingResponse,
  DomainMessageParam,
  DomainSystemBlock,
  DomainToolDefinition,
} from '../domain-transport.js'
import type {
  DomainAssistantContent,
  DomainContentBlock,
  DomainStreamEvent,
  DomainStopReason,
  DomainUserContentBlock,
} from '../../../types/domain.js'
import {
  DomainTransportError,
  DomainConnectionError,
  DomainUserAbortError,
} from '../domain-errors.js'

// ── Auth resolution ─────────────────────────────────────────────────

function resolveOpenAIChatCompletionsAuthHeaders(
  config: ProviderConfig,
): Record<string, string> {
  const auth = config.auth
  let token: string | undefined
  if (auth?.active === 'apiKey') {
    token =
      auth.apiKey?.key ||
      (auth.apiKey?.keyEnv ? process.env[auth.apiKey.keyEnv] : undefined)
  } else if (auth?.active === 'bearer') {
    token =
      auth.bearer?.token ||
      (auth.bearer?.tokenEnv ? process.env[auth.bearer.tokenEnv] : undefined)
  } else if (auth?.active === 'oauth') {
    token = auth.oauth?.accessToken
  }

  return token ? { Authorization: `Bearer ${token}` } : {}
}

// ── Tokenizer ───────────────────────────────────────────────────────

type GptTokenizerModule = {
  encode: (text: string) => number[]
}

async function loadTokenizerForModel(
  model: string,
): Promise<GptTokenizerModule> {
  const isCl100k =
    /^gpt-4(?:-|$)/i.test(model) ||
    /^gpt-3\.5-/i.test(model) ||
    /^text-embedding-/i.test(model)
  if (isCl100k) {
    return (await import('gpt-tokenizer/encoding/cl100k_base')) as unknown as GptTokenizerModule
  }
  return (await import('gpt-tokenizer/encoding/o200k_base')) as unknown as GptTokenizerModule
}

function serializeForTokenization(
  messages: TokenCountMessageParam[],
  tools: TokenCountToolParam[],
  system?: string,
): string {
  const parts: string[] = []
  if (system) parts.push(`system:\n${system}`)
  for (const t of tools) {
    const name = (t as { name?: string }).name
    if (!name) continue
    parts.push(
      `tool:${name}\n${(t as { description?: string }).description ?? ''}\n${JSON.stringify((t as { input_schema?: unknown }).input_schema ?? {})}`,
    )
  }
  for (const m of messages) {
    parts.push(`${m.role}:`)
    if (typeof m.content === 'string') {
      parts.push(m.content)
      continue
    }
    if (!Array.isArray(m.content)) continue
    for (const block of m.content) {
      if (block.type === 'text') {
        parts.push(String(block.text ?? ''))
      } else if (block.type === 'tool_use') {
        parts.push(
          `${String(block.name ?? '')}(${JSON.stringify(block.input ?? {})})`,
        )
      } else if (block.type === 'tool_result') {
        const content = block.content
        if (typeof content === 'string') parts.push(content)
        else if (Array.isArray(content)) {
          for (const c of content) {
            if (c && typeof c === 'object' && 'text' in c) {
              parts.push(String(c.text ?? ''))
            }
          }
        }
      } else if (block.type === 'thinking') {
        parts.push(String(block.thinking ?? ''))
      }
    }
  }
  return parts.join('\n')
}

// ── OpenAI wire types ───────────────────────────────────────────────

interface OpenAIChatMessage {
  role: string
  content?: string | Array<Record<string, unknown>> | null
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
  tool_call_id?: string
  name?: string
  reasoning_content?: string
}

interface OpenAIChatTool {
  type: 'function'
  function: {
    name: string
    description?: string
    parameters?: Record<string, unknown>
  }
}

// ── Domain → OpenAI request translation ─────────────────────────────

function domainToolsToOpenAI(tools: DomainToolDefinition[]): OpenAIChatTool[] {
  return tools.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      parameters: tool.input_schema || { type: 'object', properties: {} },
    },
  }))
}

function domainMessagesToOpenAI(
  messages: DomainMessageParam[],
): OpenAIChatMessage[] {
  const result: OpenAIChatMessage[] = []

  for (const msg of messages) {
    if (msg.role === 'user') {
      const contentParts: Array<Record<string, unknown>> = []
      const toolResults: Array<{ toolUseId: string; content: string }> = []

      for (const block of msg.content) {
        if (block.type === 'tool_result') {
          let outputText = ''
          if (typeof block.content === 'string') {
            outputText = block.content
          } else if (Array.isArray(block.content)) {
            outputText = block.content
              .map(c => {
                if (c.type === 'text')
                  return (c as { text?: string }).text ?? ''
                if (c.type === 'image') return '[Image data]'
                return ''
              })
              .join('\n')
          }
          toolResults.push({
            toolUseId: block.tool_use_id || '',
            content: outputText,
          })
        } else if (block.type === 'text') {
          contentParts.push({ type: 'text', text: block.text })
        } else if (block.type === 'image') {
          const src = block.source
          if (src.type === 'base64') {
            contentParts.push({
              type: 'image_url',
              image_url: {
                url: `data:${src.media_type};base64,${src.data}`,
              },
            })
          }
        }
      }

      for (const tr of toolResults) {
        result.push({
          role: 'tool',
          tool_call_id: tr.toolUseId,
          content: tr.content,
        })
      }

      if (contentParts.length === 1 && contentParts[0].type === 'text') {
        result.push({ role: 'user', content: contentParts[0].text as string })
      } else if (contentParts.length > 0) {
        result.push({ role: 'user', content: contentParts })
      }
    } else if (msg.role === 'assistant') {
      let textContent = ''
      const toolCalls: NonNullable<OpenAIChatMessage['tool_calls']> = []

      for (const block of msg.content) {
        if (block.type === 'text') {
          textContent += block.text
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id || `call_${Date.now()}`,
            type: 'function',
            function: {
              name: block.name || '',
              arguments: JSON.stringify(block.input || {}),
            },
          })
        }
        // reasoning / redacted_reasoning: dropped on outbound
      }

      const assistantMsg: OpenAIChatMessage = {
        role: 'assistant',
        content: textContent || null,
      }
      if (toolCalls.length > 0) {
        assistantMsg.tool_calls = toolCalls
      }
      result.push(assistantMsg)
    }
  }

  return result
}

function domainRequestToOpenAIBody(
  request: DomainMessageRequest,
): Record<string, unknown> {
  const messages: OpenAIChatMessage[] = []

  if (request.system && request.system.length > 0) {
    const systemText = request.system
      .filter(b => b.type === 'text' && typeof b.text === 'string')
      .map(b => b.text)
      .join('\n')
    if (systemText) {
      messages.push({ role: 'system', content: systemText })
    }
  }

  messages.push(...domainMessagesToOpenAI(request.messages))

  const body: Record<string, unknown> = {
    model: request.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  }

  if (request.tools && request.tools.length > 0) {
    body.tools = domainToolsToOpenAI(request.tools)
    body.tool_choice = 'auto'
  }

  if (request.maxTokens) body.max_tokens = request.maxTokens
  if (request.temperature !== undefined) body.temperature = request.temperature
  if (request.stopSequences) body.stop = request.stopSequences

  const outputConfig = request.outputConfig as { effort?: string } | undefined
  if (outputConfig?.effort) {
    body.reasoning_effort = outputConfig.effort
  }

  return body
}

// ── OpenAI SSE → DomainStreamEvent ──────────────────────────────────

function openaiFinishReasonToStopReason(
  reason: string | null,
  hadToolCalls: boolean,
): DomainStopReason {
  if (reason === 'length') return 'max_tokens'
  if (hadToolCalls) return 'tool_use'
  return 'end_turn'
}

async function* parseOpenAIStream(
  response: Response,
  modelId: string,
  providerType: ProviderType,
  normalizeError: (raw: unknown, pt: ProviderType) => NormalizedApiError,
): AsyncGenerator<DomainStreamEvent> {
  const messageId = `msg_oai_${Date.now()}`

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
  let outputTokens = 0
  let inputTokens = 0
  let cacheReadInputTokens = 0
  let currentTextBlockStarted = false
  let inReasoningBlock = false
  let hadToolCalls = false
  let lastFinishReason: string | null = null
  const toolCallIndexMap = new Map<number, number>()

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

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('event:')) continue
        if (!trimmed.startsWith('data: ')) continue

        const dataStr = trimmed.slice(6)
        if (dataStr === '[DONE]') continue

        let chunk: Record<string, unknown>
        try {
          chunk = JSON.parse(dataStr)
        } catch {
          continue
        }

        // Upstream inline error chunk
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

        // Usage chunk
        if (chunk.usage) {
          const usage = chunk.usage as Record<
            string,
            number | Record<string, number>
          >
          const totalInput = (usage.prompt_tokens as number) ?? inputTokens
          outputTokens = (usage.completion_tokens as number) ?? outputTokens
          const details = usage.prompt_tokens_details as
            | Record<string, number>
            | undefined
          const cached = details?.cached_tokens ?? 0
          cacheReadInputTokens = cached
          inputTokens = totalInput - cached
        }

        const choices = chunk.choices as
          | Array<Record<string, unknown>>
          | undefined
        if (!choices || choices.length === 0) continue
        const choice = choices[0]
        const delta = choice.delta as Record<string, unknown> | undefined
        const finishReason = choice.finish_reason as string | null

        if (delta) {
          // Reasoning content
          if (delta.reasoning_content) {
            const reasoningText = delta.reasoning_content as string
            if (reasoningText.length > 0) {
              if (!inReasoningBlock) {
                yield {
                  type: 'content_block_start',
                  index: contentBlockIndex,
                  content_block: {
                    type: 'reasoning',
                    text: '',
                  },
                }
                inReasoningBlock = true
              }
              yield {
                type: 'content_block_delta',
                index: contentBlockIndex,
                delta: { type: 'thinking_delta', thinking: reasoningText },
              }
            }
          }

          // Text content
          if (delta.content) {
            const text = delta.content as string
            if (text.length > 0) {
              if (inReasoningBlock) {
                yield { type: 'content_block_stop', index: contentBlockIndex }
                contentBlockIndex++
                inReasoningBlock = false
              }
              if (!currentTextBlockStarted) {
                yield {
                  type: 'content_block_start',
                  index: contentBlockIndex,
                  content_block: { type: 'text', text: '' },
                }
                currentTextBlockStarted = true
              }
              yield {
                type: 'content_block_delta',
                index: contentBlockIndex,
                delta: { type: 'text_delta', text },
              }
            }
          }

          // Tool calls
          if (delta.tool_calls) {
            const toolCalls = delta.tool_calls as Array<{
              index: number
              id?: string
              type?: string
              function?: { name?: string; arguments?: string }
            }>

            for (const tc of toolCalls) {
              if (currentTextBlockStarted && !toolCallIndexMap.has(tc.index)) {
                yield { type: 'content_block_stop', index: contentBlockIndex }
                contentBlockIndex++
                currentTextBlockStarted = false
              }
              if (inReasoningBlock && !toolCallIndexMap.has(tc.index)) {
                yield { type: 'content_block_stop', index: contentBlockIndex }
                contentBlockIndex++
                inReasoningBlock = false
              }

              if (!toolCallIndexMap.has(tc.index)) {
                toolCallIndexMap.set(tc.index, contentBlockIndex)
                hadToolCalls = true
                yield {
                  type: 'content_block_start',
                  index: contentBlockIndex,
                  content_block: {
                    type: 'tool_use',
                    id: tc.id || `toolu_${Date.now()}_${tc.index}`,
                    name: tc.function?.name || '',
                    input: {},
                  },
                }
              }

              if (tc.function?.arguments) {
                const blockIdx = toolCallIndexMap.get(tc.index)!
                yield {
                  type: 'content_block_delta',
                  index: blockIdx,
                  delta: {
                    type: 'input_json_delta',
                    partial_json: tc.function.arguments,
                  },
                }
              }
            }
          }
        }

        if (finishReason) {
          lastFinishReason = finishReason
          if (inReasoningBlock) {
            yield { type: 'content_block_stop', index: contentBlockIndex }
            contentBlockIndex++
            inReasoningBlock = false
          }
          if (currentTextBlockStarted) {
            yield { type: 'content_block_stop', index: contentBlockIndex }
            contentBlockIndex++
            currentTextBlockStarted = false
          }
          for (const [, blockIdx] of toolCallIndexMap) {
            yield { type: 'content_block_stop', index: blockIdx }
          }
          toolCallIndexMap.clear()
        }
      }
    }
  } catch (error) {
    // Close any remaining open blocks before re-throwing
    if (currentTextBlockStarted) {
      yield { type: 'content_block_stop', index: contentBlockIndex }
    }
    if (inReasoningBlock) {
      yield { type: 'content_block_stop', index: contentBlockIndex }
    }
    for (const [, blockIdx] of toolCallIndexMap) {
      yield { type: 'content_block_stop', index: blockIdx }
    }

    if (error instanceof DomainTransportError) throw error
    if (error instanceof DomainUserAbortError) throw error

    const normalized = normalizeError(
      { mid_stream: true, cause: error },
      providerType,
    )
    throw new DomainTransportError({ normalized, raw: error })
  }

  // Close any blocks left open at end of stream
  if (currentTextBlockStarted) {
    yield { type: 'content_block_stop', index: contentBlockIndex }
  }
  if (inReasoningBlock) {
    yield { type: 'content_block_stop', index: contentBlockIndex }
  }
  for (const [, blockIdx] of toolCallIndexMap) {
    yield { type: 'content_block_stop', index: blockIdx }
  }

  const usagePayload = {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_read_input_tokens: cacheReadInputTokens,
    cache_creation_input_tokens: null,
  }

  yield {
    type: 'message_delta',
    delta: {
      stop_reason: openaiFinishReasonToStopReason(
        lastFinishReason,
        hadToolCalls,
      ),
      stop_sequence: null,
    },
    usage: usagePayload,
  }

  yield { type: 'message_stop' }
}

// ── Non-streaming response parsing ──────────────────────────────────

function parseOpenAINonStreamingResponse(
  body: Record<string, unknown>,
  modelId: string,
): DomainAssistantContent {
  const messageId = (body.id as string) || `msg_oai_${Date.now()}`
  const choices = (body.choices || []) as Array<Record<string, unknown>>
  const choice = choices[0] || {}
  const msg = (choice.message || {}) as Record<string, unknown>
  const finishReason = (choice.finish_reason as string) || 'stop'

  const content: DomainContentBlock[] = []
  let hadToolCalls = false

  if (msg.reasoning_content && typeof msg.reasoning_content === 'string') {
    content.push({
      type: 'reasoning',
      text: msg.reasoning_content,
    })
  }

  if (msg.content && typeof msg.content === 'string') {
    content.push({ type: 'text', text: msg.content })
  }

  if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
    hadToolCalls = true
    for (const tc of msg.tool_calls as Array<{
      id: string
      function: { name: string; arguments: string }
    }>) {
      let input: unknown = {}
      try {
        input = JSON.parse(tc.function.arguments)
      } catch {
        input = {}
      }
      content.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input,
      })
    }
  }

  const usage = (body.usage || {}) as Record<
    string,
    number | Record<string, number>
  >
  const totalInput = (usage.prompt_tokens as number) || 0
  const outputTokens = (usage.completion_tokens as number) || 0
  const details = usage.prompt_tokens_details as
    | Record<string, number>
    | undefined
  const cached = details?.cached_tokens ?? 0

  return {
    id: messageId,
    type: 'message',
    role: 'assistant',
    content,
    model: modelId,
    stop_reason: openaiFinishReasonToStopReason(
      finishReason === 'stop' ? null : finishReason,
      hadToolCalls,
    ),
    stop_sequence: null,
    usage: {
      input_tokens: totalInput - cached,
      output_tokens: outputTokens,
      cache_read_input_tokens: cached,
      cache_creation_input_tokens: null,
    },
  }
}

// ── Adapter ─────────────────────────────────────────────────────────

export const openaiChatCompletionsAdapter: ProviderAdapter = {
  providerType: 'openai-chat-completions',
  capabilities: {} as ProviderCapabilities,

  async createStream(
    config: ProviderConfig,
    request: DomainMessageRequest,
    signal: AbortSignal,
    fetchOverride?: typeof globalThis.fetch,
  ): Promise<DomainStreamingResponse> {
    const fetch = fetchOverride ?? globalThis.fetch
    const authHeaders = resolveOpenAIChatCompletionsAuthHeaders(config)
    const baseUrl = config.baseUrl || 'https://api.openai.com/v1'
    const endpoint = `${baseUrl.replace(/\/$/, '')}/chat/completions`

    const body = domainRequestToOpenAIBody(request)

    let response: Response
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          ...authHeaders,
        },
        body: JSON.stringify(body),
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
        'openai-chat-completions',
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
        'openai-chat-completions',
      )
      throw new DomainTransportError({
        normalized,
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        raw: { status: response.status, body: errorText },
      })
    }

    const abortController = new AbortController()
    const stream = parseOpenAIStream(
      response,
      request.model,
      'openai-chat-completions',
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
    request: DomainMessageRequest,
    signal: AbortSignal,
    fetchOverride?: typeof globalThis.fetch,
  ): Promise<DomainMessageResponse> {
    const fetch = fetchOverride ?? globalThis.fetch
    const authHeaders = resolveOpenAIChatCompletionsAuthHeaders(config)
    const baseUrl = config.baseUrl || 'https://api.openai.com/v1'
    const endpoint = `${baseUrl.replace(/\/$/, '')}/chat/completions`

    const body = domainRequestToOpenAIBody(request)
    body.stream = false
    delete body.stream_options

    let response: Response
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders,
        },
        body: JSON.stringify(body),
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
        'openai-chat-completions',
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
        'openai-chat-completions',
      )
      throw new DomainTransportError({
        normalized,
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        raw: { status: response.status, body: errorText },
      })
    }

    const json = (await response.json()) as Record<string, unknown>
    return {
      message: parseOpenAINonStreamingResponse(json, request.model),
      requestId: response.headers.get('x-request-id') ?? undefined,
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
      const enc = await loadTokenizerForModel(model)
      const serialized = serializeForTokenization(
        messages,
        tools,
        options?.system,
      )
      const tokens = enc.encode(serialized).length
      return { inputTokens: tokens, outputTokens: 0 }
    } catch {
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
    }
    let code: string | undefined
    let apiErrorType: string | undefined
    let errMessage: string | undefined
    if (r.body) {
      try {
        const parsed =
          typeof r.body === 'string'
            ? (JSON.parse(r.body) as {
                error?: { code?: string; type?: string; message?: string }
              })
            : (r.body as {
                error?: { code?: string; type?: string; message?: string }
              })
        code = parsed?.error?.code
        apiErrorType = parsed?.error?.type
        errMessage = parsed?.error?.message
      } catch {
        // body is not JSON.
      }
    }

    const reclassifyByCode = (base: NormalizedApiError): NormalizedApiError => {
      if (code === 'content_filter') return { ...base, kind: 'content_filter' }
      if (code === 'rate_limit_exceeded' || code === 'insufficient_quota') {
        return { ...base, kind: 'rate_limit' }
      }
      if (code === 'invalid_api_key') return { ...base, kind: 'auth' }
      if (code === 'context_length_exceeded') {
        return { ...base, kind: 'context_overflow' }
      }
      if (
        code === 'invalid_request_error' ||
        apiErrorType === 'invalid_request_error'
      ) {
        return { ...base, kind: 'invalid_request' }
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
      return reclassifyByCode(base)
    }

    const causeMsg =
      r.cause instanceof Error
        ? r.cause.message
        : String(r.cause ?? 'stream error')
    const base: NormalizedApiError = {
      kind: 'transport',
      message: errMessage ?? causeMsg,
      providerType,
      raw,
    }
    return reclassifyByCode(base)
  },
}
