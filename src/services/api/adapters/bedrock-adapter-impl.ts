/**
 * AWS Bedrock (Converse) adapter.
 *
 * Implements native domain transport: converts DomainMessageRequest → Bedrock
 * Converse JSON, signs with SigV4, makes the HTTP request directly, parses
 * AWS EventStream binary frames, and yields DomainStreamEvents — no Anthropic
 * SDK intermediary.
 *
 * Token counting uses `CountTokensCommand` directly.
 */
import { Sha256 } from '@aws-crypto/sha256-js'
import {
  CountTokensCommand,
  type CountTokensCommandInput,
} from '@aws-sdk/client-bedrock-runtime'
import { SignatureV4 } from '@smithy/signature-v4'
import {
  hasThinkingBlocks,
  TOKEN_COUNT_MAX_TOKENS,
  TOKEN_COUNT_THINKING_BUDGET,
  type ProviderAdapter,
  type TokenBreakdown,
  type TokenCountMessageParam,
  type TokenCountToolParam,
} from '../adapter.js'
import type {
  ProviderCapabilities,
  ProviderConfig,
  ProviderType,
} from '../../../utils/settings/types.js'
import { logError } from '../../../utils/log.js'
import {
  createBedrockRuntimeClient,
  getInferenceProfileBackingModel,
  isFoundationModel,
} from '../../../utils/model/bedrock.js'
import {
  fromHttpStatus,
  type NormalizedApiError,
} from '../../../utils/normalizedError.js'
import { jsonStringify } from '../../../utils/slowOperations.js'
import { normalizeModelStringForAPI } from '../../../utils/model/model.js'
import type {
  DomainMessageRequest,
  DomainMessageResponse,
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
import { refreshAndGetAwsCredentials } from '../../../utils/auth.js'
import { isEnvTruthy } from '../../../utils/envUtils.js'

// ── AWS credentials ────────────────────────────────────────────────

interface AwsCredentials {
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
}

async function getAwsCredentials(): Promise<AwsCredentials | null> {
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

// ── SigV4 signing ──────────────────────────────────────────────────

async function signRequest(
  url: string,
  method: string,
  headers: Record<string, string>,
  body: string,
  region: string,
  credentials: AwsCredentials,
): Promise<Record<string, string>> {
  const parsedUrl = new URL(url)

  const signer = new SignatureV4({
    service: 'bedrock',
    region,
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      sessionToken: credentials.sessionToken,
    },
    sha256: Sha256,
  })

  const signableHeaders: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) {
    const lower = k.toLowerCase()
    if (lower !== 'host') {
      signableHeaders[lower] = v
    }
  }

  const signed = await signer.sign({
    method,
    protocol: parsedUrl.protocol,
    hostname: parsedUrl.hostname,
    port: parsedUrl.port ? parseInt(parsedUrl.port) : undefined,
    path: parsedUrl.pathname + parsedUrl.search,
    headers: {
      host: parsedUrl.host,
      ...signableHeaders,
    },
    body,
  })

  return signed.headers as Record<string, string>
}

// ── AWS EventStream binary parsing ─────────────────────────────────

function parseEventStreamMessage(buffer: Uint8Array): {
  headers: Record<string, string>
  payload: Uint8Array
} | null {
  if (buffer.length < 16) return null

  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  const totalLength = view.getUint32(0)
  const headersLength = view.getUint32(4)

  if (buffer.length < totalLength) return null

  const headers: Record<string, string> = {}
  let offset = 12
  const headersEnd = 12 + headersLength

  while (offset < headersEnd) {
    const nameLen = buffer[offset]!
    offset += 1
    const name = new TextDecoder().decode(
      buffer.slice(offset, offset + nameLen),
    )
    offset += nameLen

    const headerType = buffer[offset]!
    offset += 1

    if (headerType === 7) {
      const valueLen = view.getUint16(offset)
      offset += 2
      const value = new TextDecoder().decode(
        buffer.slice(offset, offset + valueLen),
      )
      offset += valueLen
      headers[name] = value
    } else {
      break
    }
  }

  const payloadStart = 12 + headersLength
  const payloadEnd = totalLength - 4
  const payload = buffer.slice(payloadStart, payloadEnd)

  return { headers, payload }
}

// ── Domain → Bedrock Converse request translation ──────────────────

function translateDomainContentBlock(
  block: DomainContentBlock | { type: string; [key: string]: unknown },
): Record<string, unknown> | null {
  switch (block.type) {
    case 'text':
      return { text: (block as { text: string }).text || '' }

    case 'tool_use': {
      const tb = block as { id: string; name: string; input: unknown }
      return {
        toolUse: {
          toolUseId: tb.id,
          name: tb.name,
          input: tb.input || {},
        },
      }
    }

    case 'tool_result': {
      const tr = block as unknown as {
        tool_use_id: string
        content?:
          | string
          | Array<{
              type: string
              text?: string
              source?: Record<string, string>
            }>
      }
      const resultContent: Array<Record<string, unknown>> = []
      if (typeof tr.content === 'string') {
        resultContent.push({ text: tr.content })
      } else if (Array.isArray(tr.content)) {
        for (const inner of tr.content) {
          if (inner.type === 'text' && typeof inner.text === 'string') {
            resultContent.push({ text: inner.text })
          } else if (inner.type === 'image') {
            const src = inner.source as Record<string, string> | undefined
            if (src?.type === 'base64' && src.media_type && src.data) {
              const format = src.media_type.split('/')[1] || 'png'
              resultContent.push({
                image: {
                  format,
                  source: { bytes: src.data },
                },
              })
            }
          } else {
            resultContent.push({ json: inner })
          }
        }
      }
      if (resultContent.length === 0) {
        resultContent.push({ text: '' })
      }
      return {
        toolResult: {
          toolUseId: tr.tool_use_id,
          content: resultContent,
        },
      }
    }

    case 'image': {
      const src = (block as unknown as { source: Record<string, string> })
        .source
      if (src?.type === 'base64' && src.media_type && src.data) {
        const format = src.media_type.split('/')[1] || 'png'
        return {
          image: {
            format,
            source: { bytes: src.data },
          },
        }
      }
      return null
    }

    case 'reasoning':
    case 'redacted_reasoning':
      return null

    default:
      return null
  }
}

function domainMessagesToConverse(
  messages: DomainMessageParam[],
): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = []

  for (const msg of messages) {
    const content: Array<Record<string, unknown>> = []
    for (const block of msg.content) {
      const translated = translateDomainContentBlock(block)
      if (translated) {
        content.push(translated)
      }
    }
    if (content.length > 0) {
      result.push({ role: msg.role, content })
    }
  }

  return result
}

function domainToolsToConverse(
  tools: DomainToolDefinition[],
  toolChoice?: DomainMessageRequest['toolChoice'],
): Record<string, unknown> {
  const toolConfig: Record<string, unknown> = {
    tools: tools.map(tool => ({
      toolSpec: {
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        inputSchema: {
          json: tool.input_schema || { type: 'object', properties: {} },
        },
      },
    })),
  }

  if (toolChoice) {
    if (toolChoice.type === 'auto') {
      toolConfig.toolChoice = { auto: {} }
    } else if (toolChoice.type === 'any') {
      toolConfig.toolChoice = { any: {} }
    } else if (toolChoice.type === 'tool') {
      toolConfig.toolChoice = { tool: { name: toolChoice.name } }
    }
  }

  return toolConfig
}

function domainRequestToConverseBody(
  request: DomainMessageRequest,
): Record<string, unknown> {
  const body: Record<string, unknown> = {}

  if (request.system && request.system.length > 0) {
    const systemBlocks: Array<{ text: string }> = []
    for (const block of request.system) {
      if (block.type === 'text' && typeof block.text === 'string') {
        systemBlocks.push({ text: block.text })
      }
    }
    if (systemBlocks.length > 0) {
      body.system = systemBlocks
    }
  }

  body.messages = domainMessagesToConverse(request.messages)

  if (request.tools && request.tools.length > 0) {
    body.toolConfig = domainToolsToConverse(request.tools, request.toolChoice)
  }

  const inferenceConfig: Record<string, unknown> = {}
  if (request.maxTokens) inferenceConfig.maxTokens = request.maxTokens
  if (request.temperature !== undefined)
    inferenceConfig.temperature = request.temperature
  if (request.stopSequences)
    inferenceConfig.stopSequences = request.stopSequences
  if (Object.keys(inferenceConfig).length > 0) {
    body.inferenceConfig = inferenceConfig
  }

  return body
}

// ── Bedrock EventStream → DomainStreamEvent ────────────────────────

async function* parseBedrockEventStream(
  eventStreamBody: ReadableStream<Uint8Array>,
  modelId: string,
  providerType: ProviderType,
  normalizeError: (raw: unknown, pt: ProviderType) => NormalizedApiError,
): AsyncGenerator<DomainStreamEvent> {
  const messageId = `msg_converse_${Date.now()}`

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

  let inputTokens = 0
  let outputTokens = 0
  let cacheReadInputTokens = 0
  let cacheWriteInputTokens = 0
  let stopReason: string | null = null

  const reader = eventStreamBody.getReader()
  let buffer = new Uint8Array(0)

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      const newBuffer = new Uint8Array(buffer.length + value.length)
      newBuffer.set(buffer)
      newBuffer.set(value, buffer.length)
      buffer = newBuffer

      while (buffer.length >= 12) {
        const view = new DataView(
          buffer.buffer,
          buffer.byteOffset,
          buffer.byteLength,
        )
        const totalLength = view.getUint32(0)

        if (buffer.length < totalLength) break

        const messageBytes = buffer.slice(0, totalLength)
        buffer = buffer.slice(totalLength)

        const message = parseEventStreamMessage(messageBytes)
        if (!message) continue

        const messageType = message.headers[':message-type']
        const eventType = message.headers[':event-type']

        if (messageType === 'exception') {
          const errorText = new TextDecoder().decode(message.payload)
          let exceptionType = message.headers[':exception-type']
          if (!exceptionType) {
            try {
              const parsed = JSON.parse(errorText) as { __type?: string }
              if (parsed?.__type) {
                const hash = parsed.__type.lastIndexOf('#')
                exceptionType =
                  hash >= 0 ? parsed.__type.slice(hash + 1) : parsed.__type
              }
            } catch {
              // ignore
            }
          }
          const normalized = normalizeError(
            { exceptionType, body: errorText, mid_stream: true },
            providerType,
          )
          throw new DomainTransportError({
            normalized,
            raw: { exceptionType, body: errorText },
          })
        }

        if (messageType !== 'event') continue

        let eventPayload: Record<string, unknown>
        try {
          const payloadJson = JSON.parse(
            new TextDecoder().decode(message.payload),
          )
          if (payloadJson.bytes) {
            const decoded = atob(payloadJson.bytes)
            eventPayload = JSON.parse(decoded)
          } else {
            eventPayload = payloadJson
          }
        } catch {
          continue
        }

        switch (eventType) {
          case 'messageStart':
            break

          case 'contentBlockStart': {
            const index = eventPayload.contentBlockIndex as number
            const start = eventPayload.start as Record<string, unknown>

            if (start?.toolUse) {
              const toolUse = start.toolUse as Record<string, unknown>
              yield {
                type: 'content_block_start',
                index,
                content_block: {
                  type: 'tool_use',
                  id: (toolUse.toolUseId as string) || `toolu_${Date.now()}`,
                  name: (toolUse.name as string) || '',
                  input: {},
                },
              }
            } else if (start?.reasoningContent) {
              yield {
                type: 'content_block_start',
                index,
                content_block: {
                  type: 'reasoning',
                  text: '',
                },
              }
            } else {
              yield {
                type: 'content_block_start',
                index,
                content_block: { type: 'text', text: '' },
              }
            }
            break
          }

          case 'contentBlockDelta': {
            const index = eventPayload.contentBlockIndex as number
            const delta = eventPayload.delta as Record<string, unknown>

            if (delta?.text !== undefined) {
              yield {
                type: 'content_block_delta',
                index,
                delta: {
                  type: 'text_delta',
                  text: delta.text as string,
                },
              }
            } else if (delta?.toolUse) {
              const toolUse = delta.toolUse as Record<string, unknown>
              yield {
                type: 'content_block_delta',
                index,
                delta: {
                  type: 'input_json_delta',
                  partial_json:
                    typeof toolUse.input === 'string'
                      ? toolUse.input
                      : JSON.stringify(toolUse.input),
                },
              }
            } else if (delta?.reasoningContent) {
              const reasoning = delta.reasoningContent as Record<
                string,
                unknown
              >
              const reasoningText =
                typeof reasoning.text === 'string' ? reasoning.text : ''
              if (reasoningText.length > 0) {
                yield {
                  type: 'content_block_delta',
                  index,
                  delta: {
                    type: 'thinking_delta',
                    thinking: reasoningText,
                  },
                }
              }
            }
            break
          }

          case 'contentBlockStop': {
            const index = eventPayload.contentBlockIndex as number
            yield { type: 'content_block_stop', index }
            break
          }

          case 'messageStop': {
            stopReason = (eventPayload.stopReason as string) || 'end_turn'
            break
          }

          case 'metadata': {
            const usage = eventPayload.usage as
              | Record<string, number>
              | undefined
            if (usage) {
              const totalInput = usage.inputTokens ?? 0
              outputTokens = usage.outputTokens ?? outputTokens
              const cached = usage.cacheReadInputTokens ?? 0
              const written = usage.cacheWriteInputTokens ?? 0
              cacheReadInputTokens = cached
              cacheWriteInputTokens = written
              inputTokens = totalInput - cached - written
            }
            break
          }

          default:
            break
        }
      }
    }
  } catch (error) {
    if (error instanceof DomainTransportError) throw error
    if (error instanceof DomainUserAbortError) throw error

    const normalized = normalizeError(
      { mid_stream: true, cause: error },
      providerType,
    )
    throw new DomainTransportError({ normalized, raw: error })
  }

  yield {
    type: 'message_delta',
    delta: {
      stop_reason: (stopReason || 'end_turn') as DomainStopReason,
      stop_sequence: null,
    },
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_read_input_tokens: cacheReadInputTokens,
      cache_creation_input_tokens: cacheWriteInputTokens,
    },
  }

  yield { type: 'message_stop' }
}

// ── Non-streaming response parsing ─────────────────────────────────

function parseConverseNonStreamingResponse(
  body: Record<string, unknown>,
  modelId: string,
): DomainAssistantContent {
  const output = body.output as Record<string, unknown> | undefined
  const outputMessage = output?.message as Record<string, unknown> | undefined
  const rawContent = (outputMessage?.content || []) as Array<
    Record<string, unknown>
  >
  const rawStopReason = (body.stopReason as string) || 'end_turn'
  const usage = body.usage as Record<string, number> | undefined

  const content: DomainContentBlock[] = []
  for (const block of rawContent) {
    if (block.text !== undefined) {
      content.push({ type: 'text', text: block.text as string })
    } else if (block.toolUse) {
      const toolUse = block.toolUse as Record<string, unknown>
      content.push({
        type: 'tool_use',
        id: toolUse.toolUseId as string,
        name: toolUse.name as string,
        input: toolUse.input || {},
      })
    } else if (block.reasoningContent) {
      const reasoning = block.reasoningContent as Record<string, unknown>
      const reasoningText = reasoning.reasoningText as
        | Record<string, unknown>
        | undefined
      const text =
        typeof reasoningText?.text === 'string' ? reasoningText.text : ''
      content.push({ type: 'reasoning', text })
    }
  }

  return {
    id: `msg_converse_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    content,
    model: modelId,
    stop_reason: rawStopReason as DomainStopReason,
    stop_sequence: null,
    usage: {
      input_tokens:
        (usage?.inputTokens ?? 0) -
        (usage?.cacheReadInputTokens ?? 0) -
        (usage?.cacheWriteInputTokens ?? 0),
      output_tokens: usage?.outputTokens ?? 0,
      cache_read_input_tokens: usage?.cacheReadInputTokens ?? 0,
      cache_creation_input_tokens: usage?.cacheWriteInputTokens ?? 0,
    },
  }
}

// ── Token counting via Bedrock CountTokensCommand ─────────────────

async function countTokensViaBedrock({
  model,
  messages,
  tools,
  betas,
  containsThinking,
  system,
}: {
  model: string
  messages: TokenCountMessageParam[]
  tools: TokenCountToolParam[]
  betas: string[]
  containsThinking: boolean
  system?: string
}): Promise<number | null> {
  try {
    const client = await createBedrockRuntimeClient()
    const modelId = isFoundationModel(model)
      ? model
      : await getInferenceProfileBackingModel(model)
    if (!modelId) {
      return null
    }

    const requestBody = {
      anthropic_version: 'bedrock-2023-05-31',
      messages:
        messages.length > 0 ? messages : [{ role: 'user', content: 'foo' }],
      max_tokens: containsThinking ? TOKEN_COUNT_MAX_TOKENS : 1,
      ...(system && { system }),
      ...(tools.length > 0 && { tools }),
      ...(betas.length > 0 && { anthropic_beta: betas }),
      ...(containsThinking && {
        thinking: {
          type: 'enabled',
          budget_tokens: TOKEN_COUNT_THINKING_BUDGET,
        },
      }),
    }

    const input: CountTokensCommandInput = {
      modelId,
      input: {
        invokeModel: {
          body: new TextEncoder().encode(jsonStringify(requestBody)),
        },
      },
    }
    const response = await client.send(new CountTokensCommand(input))
    return response.inputTokens ?? null
  } catch (error) {
    logError(error)
    return null
  }
}

// ── Adapter ────────────────────────────────────────────────────────

export const bedrockAdapter: ProviderAdapter = {
  providerType: 'bedrock-converse',
  capabilities: {} as ProviderCapabilities,

  async createStream(
    config: ProviderConfig,
    request: DomainMessageRequest,
    signal: AbortSignal,
    fetchOverride?: typeof globalThis.fetch,
  ): Promise<DomainStreamingResponse> {
    const fetch = fetchOverride ?? globalThis.fetch
    const region = config.auth?.aws?.region || 'us-east-1'
    const baseUrl =
      config.baseUrl || `https://bedrock-runtime.${region}.amazonaws.com`

    const converseBody = domainRequestToConverseBody(request)
    const encodedModel = encodeURIComponent(request.model)
    const converseUrl = `${baseUrl.replace(/\/$/, '')}/model/${encodedModel}/converse-stream`
    const bodyStr = JSON.stringify(converseBody)

    const requestHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/vnd.amazon.eventstream',
    }

    const creds = await getAwsCredentials()
    if (creds) {
      const signedHeaders = await signRequest(
        converseUrl,
        'POST',
        requestHeaders,
        bodyStr,
        region,
        creds,
      )
      Object.assign(requestHeaders, signedHeaders)
    }

    let response: Response
    try {
      response = await fetch(converseUrl, {
        method: 'POST',
        headers: requestHeaders,
        body: bodyStr,
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
        'bedrock-converse',
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
        'bedrock-converse',
      )
      throw new DomainTransportError({
        normalized,
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        raw: { status: response.status, body: errorText },
      })
    }

    if (!response.body) {
      throw new DomainConnectionError({
        normalized: {
          kind: 'transport',
          message: 'No response body from Bedrock',
          providerType: 'bedrock-converse',
          raw: null,
        },
        cause: new Error('No response body'),
      })
    }

    const abortController = new AbortController()
    const stream = parseBedrockEventStream(
      response.body,
      request.model,
      'bedrock-converse',
      this.normalizeError,
    )

    return {
      stream,
      requestId: response.headers.get('x-amzn-requestid') ?? undefined,
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
    const region = config.auth?.aws?.region || 'us-east-1'
    const baseUrl =
      config.baseUrl || `https://bedrock-runtime.${region}.amazonaws.com`

    const converseBody = domainRequestToConverseBody(request)
    const encodedModel = encodeURIComponent(request.model)
    const converseUrl = `${baseUrl.replace(/\/$/, '')}/model/${encodedModel}/converse`
    const bodyStr = JSON.stringify(converseBody)

    const requestHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    }

    const creds = await getAwsCredentials()
    if (creds) {
      const signedHeaders = await signRequest(
        converseUrl,
        'POST',
        requestHeaders,
        bodyStr,
        region,
        creds,
      )
      Object.assign(requestHeaders, signedHeaders)
    }

    let response: Response
    try {
      response = await fetch(converseUrl, {
        method: 'POST',
        headers: requestHeaders,
        body: bodyStr,
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
        'bedrock-converse',
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
        'bedrock-converse',
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
      message: parseConverseNonStreamingResponse(json, request.model),
      requestId: response.headers.get('x-amzn-requestid') ?? undefined,
      responseHeaders: Object.fromEntries(response.headers.entries()),
    }
  },

  async countTokens(
    messages: TokenCountMessageParam[],
    tools: TokenCountToolParam[],
    model: string,
    options?: { system?: string; betas?: string[] },
  ): Promise<TokenBreakdown | null> {
    const inputTokens = await countTokensViaBedrock({
      model: normalizeModelStringForAPI(model),
      messages,
      tools,
      betas: options?.betas ?? [],
      containsThinking: hasThinkingBlocks(messages),
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
      exceptionType?: string
    }
    if (r.exceptionType) {
      const kind =
        r.exceptionType === 'ThrottlingException'
          ? 'rate_limit'
          : r.exceptionType === 'ServiceUnavailableException'
            ? 'overloaded'
            : r.exceptionType === 'AccessDeniedException'
              ? 'auth'
              : r.exceptionType === 'ValidationException'
                ? 'invalid_request'
                : r.exceptionType === 'ModelErrorException' ||
                    r.exceptionType === 'ModelStreamErrorException' ||
                    r.exceptionType === 'InternalServerException'
                  ? 'server'
                  : 'unknown'
      const message =
        typeof r.body === 'string'
          ? r.body
          : r.cause instanceof Error
            ? r.cause.message
            : r.exceptionType
      return { kind, message, providerType, raw }
    }

    let errMessage: string | undefined
    if (r.body) {
      try {
        const parsed =
          typeof r.body === 'string'
            ? (JSON.parse(r.body) as { message?: string; Message?: string })
            : (r.body as { message?: string; Message?: string })
        errMessage = parsed?.message ?? parsed?.Message
      } catch {
        if (typeof r.body === 'string') errMessage = r.body
      }
    }

    if (typeof r.status === 'number') {
      return fromHttpStatus(
        r.status,
        errMessage ?? `HTTP ${r.status}`,
        providerType,
        r.headers,
        raw,
      )
    }

    const causeMsg =
      r.cause instanceof Error
        ? r.cause.message
        : String(r.cause ?? 'stream error')
    return {
      kind: 'transport',
      message: errMessage ?? causeMsg,
      providerType,
      raw,
    }
  },
}
