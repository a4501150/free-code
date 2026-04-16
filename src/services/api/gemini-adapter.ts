/**
 * Gemini generateContent Adapter
 *
 * Intercepts Anthropic SDK fetch calls and translates between
 * Anthropic Messages API <-> Gemini generateContent API format.
 *
 * Supports:
 * - System prompts (string or array of text blocks -> systemInstruction)
 * - Text messages (user/assistant -> user/model)
 * - Tool definitions (input_schema -> functionDeclarations.parameters)
 * - Tool use (tool_use -> functionCall, tool_result -> functionResponse)
 * - Image content blocks (base64 -> inlineData)
 * - Streaming SSE translation (Gemini SSE -> Anthropic SSE)
 * - Non-streaming response translation
 */

import type { ProviderConfig } from '../../utils/settings/types.js'
import { mapStatusToErrorType } from './adapter-error-utils.js'

// -- Types ------------------------------------------------------------------

interface AnthropicContentBlock {
  type: string
  text?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  tool_use_id?: string
  content?: string | AnthropicContentBlock[]
  source?: Record<string, unknown>
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

// -- SSE helper -------------------------------------------------------------

function formatSSE(event: string, data: string): string {
  return `event: ${event}\ndata: ${data}\n\n`
}

// -- Tool translation -------------------------------------------------------

function translateTools(
  anthropicTools: AnthropicTool[],
): Record<string, unknown> {
  return {
    functionDeclarations: anthropicTools.map((tool) => ({
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      parameters: tool.input_schema || { type: 'object', properties: {} },
    })),
  }
}

function translateToolConfig(
  toolChoice: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!toolChoice) return undefined
  const typeStr = toolChoice.type as string | undefined
  if (!typeStr) return undefined

  const modeMap: Record<string, string> = {
    auto: 'AUTO',
    any: 'ANY',
    none: 'NONE',
  }
  const mode = modeMap[typeStr]
  if (!mode) return undefined

  return { functionCallingConfig: { mode } }
}

// -- Body translation: Anthropic -> Gemini ----------------------------------

function translateToGeminiBody(
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

  // System instruction
  if (systemPrompt) {
    let systemText = ''
    if (typeof systemPrompt === 'string') {
      systemText = systemPrompt
    } else if (Array.isArray(systemPrompt)) {
      systemText = systemPrompt
        .filter((b) => b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text!)
        .join('\n')
    }
    if (systemText) {
      body.systemInstruction = { parts: [{ text: systemText }] }
    }
  }

  // Build tool_use_id -> tool_name map by scanning assistant messages
  const toolIdToName = new Map<string, string>()
  for (const msg of anthropicMessages) {
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'tool_use' && block.id && block.name) {
          toolIdToName.set(block.id, block.name)
        }
      }
    }
  }

  // Translate messages
  const contents: GeminiContent[] = []
  for (const msg of anthropicMessages) {
    const role = msg.role === 'assistant' ? 'model' : 'user'
    const parts: GeminiPart[] = []

    if (typeof msg.content === 'string') {
      parts.push({ text: msg.content })
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'text' && typeof block.text === 'string') {
          parts.push({ text: block.text })
        } else if (block.type === 'tool_use') {
          parts.push({
            functionCall: {
              name: block.name || '',
              args: (block.input as Record<string, unknown>) || {},
            },
          })
        } else if (block.type === 'tool_result') {
          const toolName =
            toolIdToName.get(block.tool_use_id || '') || 'unknown'
          let resultContent: unknown
          if (typeof block.content === 'string') {
            resultContent = block.content
          } else if (Array.isArray(block.content)) {
            resultContent = block.content
              .map((c) => {
                if (c.type === 'text') return c.text
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
        } else if (
          block.type === 'image' &&
          typeof block.source === 'object' &&
          block.source !== null
        ) {
          const src = block.source as Record<string, string>
          if (src.type === 'base64') {
            parts.push({
              inlineData: {
                mimeType: src.media_type,
                data: src.data,
              },
            })
          }
        }
        // Skip thinking, cache_control, and other unsupported block types
      }
    }

    if (parts.length > 0) {
      contents.push({ role, parts })
    }
  }

  body.contents = contents

  // Tools
  if (anthropicTools.length > 0) {
    body.tools = [translateTools(anthropicTools)]
    const toolConfig = translateToolConfig(toolChoice)
    if (toolConfig) {
      body.toolConfig = toolConfig
    }
  }

  // Generation config
  const generationConfig: Record<string, unknown> = {}
  if (anthropicBody.max_tokens !== undefined) {
    generationConfig.maxOutputTokens = anthropicBody.max_tokens
  }
  if (anthropicBody.temperature !== undefined) {
    generationConfig.temperature = anthropicBody.temperature
  }
  if (anthropicBody.top_p !== undefined) {
    generationConfig.topP = anthropicBody.top_p
  }
  if (anthropicBody.top_k !== undefined) {
    generationConfig.topK = anthropicBody.top_k
  }
  if (anthropicBody.stop_sequences !== undefined) {
    generationConfig.stopSequences = anthropicBody.stop_sequences
  }
  if (Object.keys(generationConfig).length > 0) {
    body.generationConfig = generationConfig
  }

  return body
}

// -- Finish reason mapping --------------------------------------------------

function mapFinishReason(geminiReason: string | undefined): string {
  if (!geminiReason) return 'end_turn'
  const map: Record<string, string> = {
    STOP: 'end_turn',
    MAX_TOKENS: 'max_tokens',
    SAFETY: 'end_turn',
    RECITATION: 'end_turn',
  }
  return map[geminiReason] || 'end_turn'
}

// -- Streaming response translation: Gemini SSE -> Anthropic SSE ------------

async function translateGeminiStreamToAnthropicSSE(
  response: Response,
  model: string,
): Promise<Response> {
  const messageId = `msg_gemini_${Date.now()}`

  const readable = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder()
      let contentBlockIndex = 0
      let inputTokens = 0
      let outputTokens = 0
      let cacheReadInputTokens = 0
      let messageStarted = false
      let currentTextBlockOpen = false
      let hadToolCalls = false

      function emitMessageStart(): void {
        if (messageStarted) return
        messageStarted = true
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
                  model,
                  stop_reason: null,
                  stop_sequence: null,
                  usage: { input_tokens: 0, output_tokens: 0 },
                },
              }),
            ),
          ),
        )
        controller.enqueue(
          encoder.encode(
            formatSSE('ping', JSON.stringify({ type: 'ping' })),
          ),
        )
      }

      function closeCurrentTextBlock(): void {
        if (!currentTextBlockOpen) return
        controller.enqueue(
          encoder.encode(
            formatSSE(
              'content_block_stop',
              JSON.stringify({
                type: 'content_block_stop',
                index: contentBlockIndex,
              }),
            ),
          ),
        )
        contentBlockIndex++
        currentTextBlockOpen = false
      }

      try {
        const reader = response.body?.getReader()
        if (!reader) {
          emitMessageStart()
          // Emit a minimal text block with the error
          controller.enqueue(
            encoder.encode(
              formatSSE(
                'content_block_start',
                JSON.stringify({
                  type: 'content_block_start',
                  index: contentBlockIndex,
                  content_block: { type: 'text', text: '' },
                }),
              ),
            ),
          )
          controller.enqueue(
            encoder.encode(
              formatSSE(
                'content_block_delta',
                JSON.stringify({
                  type: 'content_block_delta',
                  index: contentBlockIndex,
                  delta: {
                    type: 'text_delta',
                    text: 'Error: No response body',
                  },
                }),
              ),
            ),
          )
          controller.enqueue(
            encoder.encode(
              formatSSE(
                'content_block_stop',
                JSON.stringify({
                  type: 'content_block_stop',
                  index: contentBlockIndex,
                }),
              ),
            ),
          )
          finishGeminiStream(controller, encoder, 0, 0, false)
          return
        }

        const decoder = new TextDecoder()
        let buffer = ''

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

            // Extract usage
            const usageMetadata = chunk.usageMetadata as
              | Record<string, number>
              | undefined
            if (usageMetadata) {
              if (usageMetadata.candidatesTokenCount !== undefined) {
                outputTokens = usageMetadata.candidatesTokenCount
              }
              if (usageMetadata.promptTokenCount !== undefined) {
                // Split cached vs marginal input tokens to match Anthropic semantics.
                // Gemini reports total promptTokenCount; cachedContentTokenCount
                // tells us how many were served from cache.
                const cached = usageMetadata.cachedContentTokenCount ?? 0
                cacheReadInputTokens = cached
                inputTokens = usageMetadata.promptTokenCount - cached
              }
            }

            // Process candidates
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
              emitMessageStart()

              for (const part of content.parts) {
                // Text part
                if (part.text !== undefined) {
                  if (!currentTextBlockOpen) {
                    controller.enqueue(
                      encoder.encode(
                        formatSSE(
                          'content_block_start',
                          JSON.stringify({
                            type: 'content_block_start',
                            index: contentBlockIndex,
                            content_block: { type: 'text', text: '' },
                          }),
                        ),
                      ),
                    )
                    currentTextBlockOpen = true
                  }
                  controller.enqueue(
                    encoder.encode(
                      formatSSE(
                        'content_block_delta',
                        JSON.stringify({
                          type: 'content_block_delta',
                          index: contentBlockIndex,
                          delta: { type: 'text_delta', text: part.text },
                        }),
                      ),
                    ),
                  )
                }

                // Function call part
                if (part.functionCall) {
                  closeCurrentTextBlock()
                  hadToolCalls = true
                  const toolUseId = `toolu_gemini_${Date.now()}_${contentBlockIndex}`

                  // Emit content_block_start for tool_use
                  controller.enqueue(
                    encoder.encode(
                      formatSSE(
                        'content_block_start',
                        JSON.stringify({
                          type: 'content_block_start',
                          index: contentBlockIndex,
                          content_block: {
                            type: 'tool_use',
                            id: toolUseId,
                            name: part.functionCall.name,
                            input: {},
                          },
                        }),
                      ),
                    ),
                  )

                  // Emit the args as input_json_delta
                  controller.enqueue(
                    encoder.encode(
                      formatSSE(
                        'content_block_delta',
                        JSON.stringify({
                          type: 'content_block_delta',
                          index: contentBlockIndex,
                          delta: {
                            type: 'input_json_delta',
                            partial_json: JSON.stringify(
                              part.functionCall.args || {},
                            ),
                          },
                        }),
                      ),
                    ),
                  )

                  // Close the tool_use block
                  controller.enqueue(
                    encoder.encode(
                      formatSSE(
                        'content_block_stop',
                        JSON.stringify({
                          type: 'content_block_stop',
                          index: contentBlockIndex,
                        }),
                      ),
                    ),
                  )
                  contentBlockIndex++
                }
              }
            }

            // Handle finish reason
            if (finishReason) {
              emitMessageStart()
              closeCurrentTextBlock()
            }
          }
        }
      } catch (err) {
        emitMessageStart()
        controller.enqueue(
          encoder.encode(
            `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message: String(err) } })}\n\n`,
          ),
        )
      }

      // Close any remaining open text block
      closeCurrentTextBlock()

      finishGeminiStream(
        controller,
        encoder,
        outputTokens,
        inputTokens,
        cacheReadInputTokens,
        hadToolCalls,
      )
    },
  })

  return new Response(readable, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'x-request-id': messageId,
    },
  })
}

function finishGeminiStream(
  controller: ReadableStreamDefaultController,
  encoder: TextEncoder,
  outputTokens: number,
  inputTokens: number,
  cacheReadInputTokens: number,
  hadToolCalls: boolean,
): void {
  const stopReason = hadToolCalls ? 'tool_use' : 'end_turn'

  const usagePayload = {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_read_input_tokens: cacheReadInputTokens,
    cache_creation_input_tokens: 0,
  }

  controller.enqueue(
    encoder.encode(
      formatSSE(
        'message_delta',
        JSON.stringify({
          type: 'message_delta',
          delta: { stop_reason: stopReason, stop_sequence: null },
          usage: usagePayload,
        }),
      ),
    ),
  )
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
}

// -- Non-streaming response translation -------------------------------------

function translateGeminiResponseToAnthropic(
  geminiResponse: Record<string, unknown>,
  model: string,
): Record<string, unknown> {
  const candidates = geminiResponse.candidates as
    | Array<Record<string, unknown>>
    | undefined
  const usageMetadata = geminiResponse.usageMetadata as
    | Record<string, number>
    | undefined

  const content: Array<Record<string, unknown>> = []
  let stopReason = 'end_turn'
  let hadToolCalls = false

  if (candidates && candidates.length > 0) {
    const candidate = candidates[0]
    const candidateContent = candidate.content as
      | { role?: string; parts?: GeminiPart[] }
      | undefined
    const finishReason = candidate.finishReason as string | undefined

    if (finishReason) {
      stopReason = mapFinishReason(finishReason)
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

  if (hadToolCalls) {
    stopReason = 'tool_use'
  }

  return {
    id: `msg_gemini_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    content,
    model,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: (usageMetadata?.promptTokenCount ?? 0) - (usageMetadata?.cachedContentTokenCount ?? 0),
      output_tokens: usageMetadata?.candidatesTokenCount ?? 0,
      cache_read_input_tokens: usageMetadata?.cachedContentTokenCount ?? 0,
      cache_creation_input_tokens: 0,
    },
  }
}

// -- Main fetch interceptor factory -----------------------------------------

/**
 * Creates a fetch function that intercepts Anthropic SDK calls and routes
 * them to Google Vertex AI Gemini generateContent endpoint.
 *
 * @param config Provider config with auth.gcp containing region and projectId
 * @param getAccessToken Function that returns a GCP OAuth2 access token
 */
export function createGeminiFetch(
  config: ProviderConfig,
  getAccessToken: () => Promise<{ token: string; projectId?: string }>,
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  const region = config.auth?.gcp?.region || 'us-central1'
  const configProjectId = config.auth?.gcp?.projectId
  const baseUrl =
    config.baseUrl ||
    `https://${region}-aiplatform.googleapis.com/v1`

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

    // Extract model from the Anthropic body
    const model = (anthropicBody.model as string) || 'gemini-2.0-flash'
    const isStreaming = anthropicBody.stream !== false

    // Translate to Gemini format
    const geminiBody = translateToGeminiBody(anthropicBody)

    // Get GCP access token and project ID
    const authResult = await getAccessToken()
    const projectId = configProjectId || authResult.projectId || ''

    // Build Gemini URL
    const action = isStreaming
      ? 'streamGenerateContent?alt=sse'
      : 'generateContent'
    const geminiUrl = `${baseUrl.replace(/\/$/, '')}/projects/${projectId}/locations/${region}/publishers/google/models/${model}:${action}`

    // Build headers
    const requestHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${authResult.token}`,
    }

    // Copy through relevant headers from SDK
    const initHeaders = init?.headers as Record<string, string> | undefined
    if (initHeaders) {
      for (const key of [
        'x-app',
        'User-Agent',
        'X-Claude-Code-Session-Id',
      ]) {
        if (initHeaders[key]) {
          requestHeaders[key] = initHeaders[key]
        }
      }
    }

    // Make the request
    const response = await globalThis.fetch(geminiUrl, {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify(geminiBody),
    })

    if (!response.ok) {
      const errorText = await response.text()
      const errorBody = {
        type: 'error',
        error: {
          type: mapStatusToErrorType(response.status),
          message: `Gemini API error (${response.status}): ${errorText}`,
        },
      }
      return new Response(JSON.stringify(errorBody), {
        status: response.status,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // Handle streaming vs non-streaming
    if (isStreaming) {
      return translateGeminiStreamToAnthropicSSE(response, model)
    }

    // Non-streaming: parse full response and translate
    const geminiResponse = (await response.json()) as Record<string, unknown>
    const anthropicResponse = translateGeminiResponseToAnthropic(
      geminiResponse,
      model,
    )
    return new Response(JSON.stringify(anthropicResponse), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'x-request-id': `msg_gemini_${Date.now()}`,
      },
    })
  }
}
