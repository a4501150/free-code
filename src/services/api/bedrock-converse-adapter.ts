/**
 * Bedrock Converse API Adapter
 *
 * Intercepts Anthropic SDK fetch calls and translates between
 * Anthropic Messages API <-> AWS Bedrock Converse API format.
 *
 * Supports:
 * - System prompts (string or array -> system content blocks)
 * - Text, tool_use, tool_result, image, thinking content blocks
 * - Tool definitions (input_schema -> toolSpec.inputSchema.json)
 * - tool_choice translation
 * - Streaming via ConverseStream (EventStream binary -> Anthropic SSE)
 * - Non-streaming via Converse
 * - SigV4 request signing
 */

import { Sha256 } from '@aws-crypto/sha256-js'
import { SignatureV4 } from '@smithy/signature-v4'
import type { ProviderConfig } from '../../utils/settings/types.js'
import { bedrockAdapter } from './adapters/bedrock-adapter-impl.js'
import { toAnthropicErrorType } from '../../utils/normalizedError.js'

// ── AWS EventStream binary parsing ──────────────────────────────────
//
// AWS EventStream format: each message is a binary frame containing:
//   [total_length: u32] [headers_length: u32] [prelude_crc: u32]
//   [headers...] [payload...] [message_crc: u32]
//
// For Bedrock streaming, each message has a `:message-type` header
// ("event" or "exception") and a `:event-type` header ("chunk" for data).
// The payload is JSON containing `bytes` (base64-encoded) which decodes
// to the event data.

function parseEventStreamMessage(buffer: Uint8Array): {
  headers: Record<string, string>
  payload: Uint8Array
} | null {
  if (buffer.length < 16) return null // minimum: 4+4+4 prelude + 4 CRC

  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  const totalLength = view.getUint32(0)
  const headersLength = view.getUint32(4)
  // skip prelude CRC at offset 8

  if (buffer.length < totalLength) return null

  // Parse headers (starting at offset 12)
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

// ── SigV4 signing ───────────────────────────────────────────────────

interface AwsCredentials {
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
}

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

// ── Types ───────────────────────────────────────────────────────────

interface AnthropicContentBlock {
  type: string
  text?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  tool_use_id?: string
  content?: string | AnthropicContentBlock[]
  source?: Record<string, unknown>
  thinking?: string
  signature?: string
  cache_control?: unknown
  [key: string]: unknown
}

interface AnthropicMessage {
  role: string
  content: string | AnthropicContentBlock[]
}

interface AnthropicTool {
  name: string
  description?: string
  input_schema?: Record<string, unknown>
  cache_control?: unknown
}

// ── Body translation: Anthropic -> Bedrock Converse ─────────────────

function translateContentBlock(
  block: AnthropicContentBlock,
): Record<string, unknown> | null {
  switch (block.type) {
    case 'text':
      return { text: block.text || '' }

    case 'tool_use':
      return {
        toolUse: {
          toolUseId: block.id,
          name: block.name,
          input: block.input || {},
        },
      }

    case 'tool_result': {
      const resultContent: Array<Record<string, unknown>> = []
      if (typeof block.content === 'string') {
        resultContent.push({ text: block.content })
      } else if (Array.isArray(block.content)) {
        for (const inner of block.content) {
          if (inner.type === 'text' && typeof inner.text === 'string') {
            resultContent.push({ text: inner.text })
          } else if (inner.type === 'image') {
            const translated = translateContentBlock(inner)
            if (translated) resultContent.push(translated)
          } else {
            // Attempt JSON for structured content
            resultContent.push({ json: inner })
          }
        }
      }
      if (resultContent.length === 0) {
        resultContent.push({ text: '' })
      }
      return {
        toolResult: {
          toolUseId: block.tool_use_id,
          content: resultContent,
        },
      }
    }

    case 'image': {
      const src = block.source as Record<string, string> | undefined
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

    case 'thinking':
      // Bedrock does not preserve signed thinking blocks across turns
      // (signatures are stripped), so forwarding them is a net loss: it
      // leaks prior reasoning into the next request but cannot be
      // reconstructed as valid Anthropic-format thinking on the response.
      // Per Step 5 of the provider-agnostic plan, we drop outbound
      // thinking blocks entirely.
      return null

    default:
      return null
  }
}

function translateMessages(
  anthropicMessages: AnthropicMessage[],
): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = []

  for (const msg of anthropicMessages) {
    if (typeof msg.content === 'string') {
      messages.push({
        role: msg.role,
        content: [{ text: msg.content }],
      })
      continue
    }

    if (!Array.isArray(msg.content)) continue

    const content: Array<Record<string, unknown>> = []
    for (const block of msg.content) {
      const translated = translateContentBlock(block)
      if (translated) {
        content.push(translated)
      }
    }

    if (content.length > 0) {
      messages.push({ role: msg.role, content })
    }
  }

  return messages
}

function translateToolConfig(
  anthropicTools: AnthropicTool[],
  toolChoice?: Record<string, unknown>,
): Record<string, unknown> {
  const toolConfig: Record<string, unknown> = {
    tools: anthropicTools.map(tool => ({
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
    const choiceType = toolChoice.type as string
    if (choiceType === 'auto') {
      toolConfig.toolChoice = { auto: {} }
    } else if (choiceType === 'any') {
      toolConfig.toolChoice = { any: {} }
    } else if (choiceType === 'tool' && toolChoice.name) {
      toolConfig.toolChoice = { tool: { name: toolChoice.name } }
    }
  }

  return toolConfig
}

function translateToConverseBody(
  anthropicBody: Record<string, unknown>,
): Record<string, unknown> {
  const anthropicMessages = (anthropicBody.messages || []) as AnthropicMessage[]
  const systemPrompt = anthropicBody.system as
    | string
    | Array<{ type: string; text?: string; cache_control?: unknown }>
    | undefined
  const anthropicTools = (anthropicBody.tools || []) as AnthropicTool[]
  const toolChoice = anthropicBody.tool_choice as
    | Record<string, unknown>
    | undefined

  const body: Record<string, unknown> = {}

  // System prompt
  if (systemPrompt) {
    const systemBlocks: Array<{ text: string }> = []
    if (typeof systemPrompt === 'string') {
      systemBlocks.push({ text: systemPrompt })
    } else if (Array.isArray(systemPrompt)) {
      for (const block of systemPrompt) {
        if (block.type === 'text' && typeof block.text === 'string') {
          systemBlocks.push({ text: block.text })
        }
      }
    }
    if (systemBlocks.length > 0) {
      body.system = systemBlocks
    }
  }

  // Messages
  body.messages = translateMessages(anthropicMessages)

  // Tools
  if (anthropicTools.length > 0) {
    body.toolConfig = translateToolConfig(anthropicTools, toolChoice)
  }

  // Inference config
  const inferenceConfig: Record<string, unknown> = {}
  if (anthropicBody.max_tokens !== undefined) {
    inferenceConfig.maxTokens = anthropicBody.max_tokens
  }
  if (anthropicBody.temperature !== undefined) {
    inferenceConfig.temperature = anthropicBody.temperature
  }
  if (anthropicBody.top_p !== undefined) {
    inferenceConfig.topP = anthropicBody.top_p
  }
  if (anthropicBody.stop_sequences !== undefined) {
    inferenceConfig.stopSequences = anthropicBody.stop_sequences
  }
  if (Object.keys(inferenceConfig).length > 0) {
    body.inferenceConfig = inferenceConfig
  }

  return body
}

// ── SSE helpers ─────────────────────────────────────────────────────

function formatSSE(event: string, data: string): string {
  return `event: ${event}\ndata: ${data}\n\n`
}

// ── Streaming response translation: Converse EventStream -> Anthropic SSE ──

function converseEventStreamToSSE(
  eventStreamBody: ReadableStream<Uint8Array>,
  modelId: string,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const messageId = `msg_converse_${Date.now()}`

  return new ReadableStream({
    async start(controller) {
      let inputTokens = 0
      let outputTokens = 0
      let cacheReadInputTokens = 0
      let cacheWriteInputTokens = 0
      let stopReason: string | null = null

      // Emit message_start
      controller.enqueue(
        encoder.encode(
          formatSSE(
            'message_start',
            JSON.stringify({
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
            }),
          ),
        ),
      )

      // Emit ping
      controller.enqueue(
        encoder.encode(formatSSE('ping', JSON.stringify({ type: 'ping' }))),
      )

      try {
        const reader = eventStreamBody.getReader()
        let buffer = new Uint8Array(0)

        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          // Append to buffer
          const newBuffer = new Uint8Array(buffer.length + value.length)
          newBuffer.set(buffer)
          newBuffer.set(value, buffer.length)
          buffer = newBuffer

          // Try to parse complete messages from the buffer
          while (buffer.length >= 12) {
            const view = new DataView(
              buffer.buffer,
              buffer.byteOffset,
              buffer.byteLength,
            )
            const totalLength = view.getUint32(0)

            if (buffer.length < totalLength) break // need more data

            const messageBytes = buffer.slice(0, totalLength)
            buffer = buffer.slice(totalLength)

            const message = parseEventStreamMessage(messageBytes)
            if (!message) continue

            const messageType = message.headers[':message-type']
            const eventType = message.headers[':event-type']

            if (messageType === 'exception') {
              const errorText = new TextDecoder().decode(message.payload)
              // Extract exception type from the ':exception-type' header or
              // parse __type from the JSON payload.
              let exceptionType = message.headers[':exception-type']
              if (!exceptionType) {
                try {
                  const parsed = JSON.parse(errorText) as { __type?: string }
                  if (parsed?.__type) {
                    // "com.amazon.foo#ThrottlingException" → "ThrottlingException"
                    const hash = parsed.__type.lastIndexOf('#')
                    exceptionType =
                      hash >= 0 ? parsed.__type.slice(hash + 1) : parsed.__type
                  }
                } catch {
                  // ignore parse errors; fall through with undefined exceptionType
                }
              }
              const normalized = bedrockAdapter.normalizeError(
                { exceptionType, body: errorText, mid_stream: true },
                'bedrock-converse',
              )
              controller.enqueue(
                encoder.encode(
                  `event: error\ndata: ${JSON.stringify({
                    type: 'error',
                    error: {
                      type: toAnthropicErrorType(normalized.kind),
                      message: normalized.message,
                      normalized,
                    },
                  })}\n\n`,
                ),
              )
              continue
            }

            if (messageType !== 'event') continue

            // Decode the payload: JSON with { bytes: "<base64>" }
            let eventPayload: Record<string, unknown>
            try {
              const payloadJson = JSON.parse(
                new TextDecoder().decode(message.payload),
              )
              if (payloadJson.bytes) {
                const decoded = atob(payloadJson.bytes)
                eventPayload = JSON.parse(decoded)
              } else {
                // Some Converse events may have the payload directly
                eventPayload = payloadJson
              }
            } catch {
              continue
            }

            // Translate Converse events to Anthropic SSE
            switch (eventType) {
              case 'messageStart': {
                // messageStart has { role: "assistant" } — already emitted in message_start
                break
              }

              case 'contentBlockStart': {
                const index = eventPayload.contentBlockIndex as number
                const start = eventPayload.start as Record<string, unknown>

                if (start?.toolUse) {
                  const toolUse = start.toolUse as Record<string, unknown>
                  controller.enqueue(
                    encoder.encode(
                      formatSSE(
                        'content_block_start',
                        JSON.stringify({
                          type: 'content_block_start',
                          index,
                          content_block: {
                            type: 'tool_use',
                            id: toolUse.toolUseId || `toolu_${Date.now()}`,
                            name: toolUse.name || '',
                            input: {},
                          },
                        }),
                      ),
                    ),
                  )
                } else if (start?.reasoningContent) {
                  // Bedrock Converse streams reasoningContent for Anthropic
                  // models running on Bedrock. The AWS API strips
                  // signatures, so we emit an unsigned synthetic `thinking`
                  // block purely for UI visibility. Outbound translation
                  // (`translateBlock`) drops thinking blocks on the way
                  // back to Bedrock so they never reach the wire as input,
                  // avoiding the "strip-on-next-turn" bug. Bedrock users
                  // who need reasoning preserved across turns should use
                  // the native Anthropic path.
                  controller.enqueue(
                    encoder.encode(
                      formatSSE(
                        'content_block_start',
                        JSON.stringify({
                          type: 'content_block_start',
                          index,
                          content_block: {
                            type: 'thinking',
                            thinking: '',
                            signature: '',
                          },
                        }),
                      ),
                    ),
                  )
                } else {
                  // Text block
                  controller.enqueue(
                    encoder.encode(
                      formatSSE(
                        'content_block_start',
                        JSON.stringify({
                          type: 'content_block_start',
                          index,
                          content_block: { type: 'text', text: '' },
                        }),
                      ),
                    ),
                  )
                }
                break
              }

              case 'contentBlockDelta': {
                const index = eventPayload.contentBlockIndex as number
                const delta = eventPayload.delta as Record<string, unknown>

                if (delta?.text !== undefined) {
                  controller.enqueue(
                    encoder.encode(
                      formatSSE(
                        'content_block_delta',
                        JSON.stringify({
                          type: 'content_block_delta',
                          index,
                          delta: {
                            type: 'text_delta',
                            text: delta.text,
                          },
                        }),
                      ),
                    ),
                  )
                } else if (delta?.toolUse) {
                  const toolUse = delta.toolUse as Record<string, unknown>
                  controller.enqueue(
                    encoder.encode(
                      formatSSE(
                        'content_block_delta',
                        JSON.stringify({
                          type: 'content_block_delta',
                          index,
                          delta: {
                            type: 'input_json_delta',
                            partial_json:
                              typeof toolUse.input === 'string'
                                ? toolUse.input
                                : JSON.stringify(toolUse.input),
                          },
                        }),
                      ),
                    ),
                  )
                } else if (delta?.reasoningContent) {
                  const reasoning = delta.reasoningContent as Record<
                    string,
                    unknown
                  >
                  const reasoningText =
                    typeof reasoning.text === 'string' ? reasoning.text : ''
                  if (reasoningText.length > 0) {
                    controller.enqueue(
                      encoder.encode(
                        formatSSE(
                          'content_block_delta',
                          JSON.stringify({
                            type: 'content_block_delta',
                            index,
                            delta: {
                              type: 'thinking_delta',
                              thinking: reasoningText,
                            },
                          }),
                        ),
                      ),
                    )
                  }
                }
                break
              }

              case 'contentBlockStop': {
                const index = eventPayload.contentBlockIndex as number
                controller.enqueue(
                  encoder.encode(
                    formatSSE(
                      'content_block_stop',
                      JSON.stringify({
                        type: 'content_block_stop',
                        index,
                      }),
                    ),
                  ),
                )
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

                  // Split cached vs marginal input tokens to match Anthropic semantics.
                  // Bedrock Converse reports total inputTokens; cacheReadInputTokens
                  // and cacheWriteInputTokens tell us the cache breakdown.
                  const cached = usage.cacheReadInputTokens ?? 0
                  const written = usage.cacheWriteInputTokens ?? 0
                  cacheReadInputTokens = cached
                  cacheWriteInputTokens = written
                  inputTokens = totalInput - cached - written
                }
                break
              }

              default:
                // Unknown event type — skip
                break
            }
          }
        }
      } catch (err) {
        const normalized = bedrockAdapter.normalizeError(
          { mid_stream: true, cause: err },
          'bedrock-converse',
        )
        controller.enqueue(
          encoder.encode(
            `event: error\ndata: ${JSON.stringify({
              type: 'error',
              error: {
                type: toAnthropicErrorType(normalized.kind),
                message: normalized.message,
                normalized,
              },
            })}\n\n`,
          ),
        )
      }

      // Emit message_delta with stop reason
      const usagePayload = {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_read_input_tokens: cacheReadInputTokens,
        cache_creation_input_tokens: cacheWriteInputTokens,
      }

      controller.enqueue(
        encoder.encode(
          formatSSE(
            'message_delta',
            JSON.stringify({
              type: 'message_delta',
              delta: {
                stop_reason: stopReason || 'end_turn',
                stop_sequence: null,
              },
              usage: usagePayload,
            }),
          ),
        ),
      )

      // Emit message_stop
      controller.enqueue(
        encoder.encode(
          formatSSE(
            'message_stop',
            JSON.stringify({
              type: 'message_stop',
              usage: usagePayload,
            }),
          ),
        ),
      )

      controller.close()
    },
  })
}

// ── Non-streaming response translation ──────────────────────────────

function translateConverseResponse(
  converseBody: Record<string, unknown>,
  modelId: string,
): Record<string, unknown> {
  const output = converseBody.output as Record<string, unknown> | undefined
  const outputMessage = output?.message as Record<string, unknown> | undefined
  const rawContent = (outputMessage?.content || []) as Array<
    Record<string, unknown>
  >
  const stopReason = (converseBody.stopReason as string) || 'end_turn'
  const usage = converseBody.usage as Record<string, number> | undefined

  // Translate content blocks back to Anthropic format
  const content: Array<Record<string, unknown>> = []
  for (const block of rawContent) {
    if (block.text !== undefined) {
      content.push({ type: 'text', text: block.text })
    } else if (block.toolUse) {
      const toolUse = block.toolUse as Record<string, unknown>
      content.push({
        type: 'tool_use',
        id: toolUse.toolUseId,
        name: toolUse.name,
        input: toolUse.input || {},
      })
    } else if (block.reasoningContent) {
      // Emitted as unsigned synthetic `thinking` block for UI visibility.
      // Outbound translation drops thinking blocks so they never reach the
      // wire as input. See the streaming-path comments above.
      const reasoning = block.reasoningContent as Record<string, unknown>
      const reasoningText = reasoning.reasoningText as
        | Record<string, unknown>
        | undefined
      const text =
        typeof reasoningText?.text === 'string' ? reasoningText.text : ''
      content.push({ type: 'thinking', thinking: text, signature: '' })
    }
  }

  return {
    id: `msg_converse_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    content,
    model: modelId,
    stop_reason: stopReason,
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

// ── Main fetch interceptor factory ──────────────────────────────────

/**
 * Creates a fetch function that intercepts Anthropic SDK calls and routes
 * them to AWS Bedrock Converse API, handling body translation, SigV4 signing,
 * and EventStream -> Anthropic SSE conversion.
 */
export function createBedrockConverseFetch(
  config: ProviderConfig,
  getCredentials: () => Promise<AwsCredentials | null>,
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  const region = config.auth?.aws?.region || 'us-east-1'
  const baseUrl =
    config.baseUrl || `https://bedrock-runtime.${region}.amazonaws.com`

  return async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input)

    // Only intercept Anthropic API message calls
    if (!url.includes('/v1/messages')) {
      return globalThis.fetch(input, init)
    }

    // Parse the Anthropic request body
    let anthropicBody: Record<string, unknown>
    try {
      const bodyText =
        init?.body instanceof ReadableStream
          ? await new Response(init.body).text()
          : typeof init?.body === 'string'
            ? init.body
            : '{}'
      anthropicBody = JSON.parse(bodyText)
    } catch {
      anthropicBody = {}
    }

    // Extract model and streaming flag
    const model = anthropicBody.model as string
    const isStreaming = anthropicBody.stream !== false

    // Translate to Converse body
    const converseBody = translateToConverseBody(anthropicBody)

    // Build Converse URL
    const encodedModel = encodeURIComponent(model)
    const action = isStreaming ? 'converse-stream' : 'converse'
    const converseUrl = `${baseUrl.replace(/\/$/, '')}/model/${encodedModel}/${action}`

    const bodyStr = JSON.stringify(converseBody)

    // Build headers
    const requestHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: isStreaming
        ? 'application/vnd.amazon.eventstream'
        : 'application/json',
    }

    // Copy through relevant headers from the SDK
    const initHeaders = init?.headers as Record<string, string> | undefined
    if (initHeaders) {
      for (const key of ['x-app', 'User-Agent', 'X-Claude-Code-Session-Id']) {
        if (initHeaders[key]) {
          requestHeaders[key] = initHeaders[key]
        }
      }
    }

    // Get AWS credentials and sign the request
    const creds = await getCredentials()
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

    // Make the request
    const response = await globalThis.fetch(converseUrl, {
      method: 'POST',
      headers: requestHeaders,
      body: bodyStr,
    })

    if (!response.ok) {
      const errorText = await response.text()
      const normalized = bedrockAdapter.normalizeError(
        {
          status: response.status,
          body: errorText,
          headers: response.headers,
        },
        'bedrock-converse',
      )
      const errorBody = {
        type: 'error',
        error: {
          type: toAnthropicErrorType(normalized.kind),
          message: `Bedrock Converse API error (${response.status}): ${normalized.message}`,
          normalized,
        },
      }
      const outHeaders = new Headers(response.headers)
      outHeaders.set('Content-Type', 'application/json')
      return new Response(JSON.stringify(errorBody), {
        status: response.status,
        headers: outHeaders,
      })
    }

    if (!isStreaming || !response.body) {
      // Non-streaming: translate Converse response to Anthropic format
      const responseBody = await response.json()
      const anthropicResponse = translateConverseResponse(responseBody, model)
      return new Response(JSON.stringify(anthropicResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // Streaming: convert EventStream binary -> Anthropic SSE
    const sseStream = converseEventStreamToSSE(response.body, model)

    return new Response(sseStream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    })
  }
}
