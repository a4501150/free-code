/**
 * OpenAI Chat Completions Adapter
 *
 * Intercepts Anthropic SDK fetch calls and translates between
 * Anthropic Messages API ↔ OpenAI Chat Completions API format.
 *
 * Reference: llms repo anthropic.transformer.ts
 *
 * Supports:
 * - System prompts (array or string → system role message)
 * - Text messages (user/assistant)
 * - Tool definitions (input_schema → function.parameters)
 * - Tool use (tool_use blocks → tool_calls, tool_result → tool role)
 * - Thinking blocks (thinking → reasoning_content)
 * - Streaming SSE translation (Chat Completions → Anthropic format)
 * - Image content blocks
 * - cache_control stripping
 */

import type { ProviderConfig } from '../../utils/settings/types.js'

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

interface ChatCompletionsMessage {
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

interface ChatCompletionsTool {
  type: 'function'
  function: {
    name: string
    description?: string
    parameters?: Record<string, unknown>
  }
}

// ── Tool translation ────────────────────────────────────────────────

function translateTools(
  anthropicTools: AnthropicTool[],
): ChatCompletionsTool[] {
  return anthropicTools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      parameters: tool.input_schema || { type: 'object', properties: {} },
    },
  }))
}

// ── Message translation: Anthropic → Chat Completions ───────────────

function translateMessages(
  anthropicMessages: AnthropicMessage[],
): ChatCompletionsMessage[] {
  const messages: ChatCompletionsMessage[] = []

  for (const msg of anthropicMessages) {
    if (typeof msg.content === 'string') {
      messages.push({ role: msg.role, content: msg.content })
      continue
    }

    if (!Array.isArray(msg.content)) continue

    if (msg.role === 'user') {
      // Separate tool_result blocks from other content
      const contentParts: Array<Record<string, unknown>> = []
      const toolResults: Array<{
        toolUseId: string
        content: string
      }> = []

      for (const block of msg.content) {
        if (block.type === 'tool_result') {
          let outputText = ''
          if (typeof block.content === 'string') {
            outputText = block.content
          } else if (Array.isArray(block.content)) {
            outputText = block.content
              .map((c) => {
                if (c.type === 'text') return c.text
                if (c.type === 'image') return '[Image data]'
                return ''
              })
              .join('\n')
          }
          toolResults.push({
            toolUseId: block.tool_use_id || '',
            content: outputText,
          })
        } else if (block.type === 'text' && typeof block.text === 'string') {
          contentParts.push({ type: 'text', text: block.text })
        } else if (
          block.type === 'image' &&
          typeof block.source === 'object' &&
          block.source !== null
        ) {
          const src = block.source as Record<string, string>
          if (src.type === 'base64') {
            contentParts.push({
              type: 'image_url',
              image_url: {
                url: `data:${src.media_type};base64,${src.data}`,
              },
            })
          } else if (src.type === 'url') {
            contentParts.push({
              type: 'image_url',
              image_url: { url: src.url },
            })
          }
        }
      }

      // Emit tool results as separate tool-role messages
      for (const tr of toolResults) {
        messages.push({
          role: 'tool',
          tool_call_id: tr.toolUseId,
          content: tr.content,
        })
      }

      // Emit user content if any
      if (contentParts.length === 1 && contentParts[0].type === 'text') {
        messages.push({
          role: 'user',
          content: contentParts[0].text as string,
        })
      } else if (contentParts.length > 0) {
        messages.push({ role: 'user', content: contentParts })
      }
    } else if (msg.role === 'assistant') {
      // Collect text content and tool_use blocks
      let textContent = ''
      let reasoningContent = ''
      const toolCalls: ChatCompletionsMessage['tool_calls'] = []

      for (const block of msg.content) {
        if (block.type === 'text' && typeof block.text === 'string') {
          textContent += block.text
        } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
          reasoningContent += block.thinking
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
      }

      const assistantMsg: ChatCompletionsMessage = {
        role: 'assistant',
        content: textContent || null,
      }
      if (toolCalls.length > 0) {
        assistantMsg.tool_calls = toolCalls
      }
      if (reasoningContent) {
        assistantMsg.reasoning_content = reasoningContent
      }
      messages.push(assistantMsg)
    }
  }

  return messages
}

// ── Full request translation ────────────────────────────────────────

function translateToOpenAIBody(
  anthropicBody: Record<string, unknown>,
  targetModel: string,
): Record<string, unknown> {
  const anthropicMessages = (anthropicBody.messages || []) as AnthropicMessage[]
  const systemPrompt = anthropicBody.system as
    | string
    | Array<{ type: string; text?: string; cache_control?: unknown }>
    | undefined
  const anthropicTools = (anthropicBody.tools || []) as AnthropicTool[]

  const messages: ChatCompletionsMessage[] = []

  // System prompt → system role message
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
      messages.push({ role: 'system', content: systemText })
    }
  }

  // Translate messages
  messages.push(...translateMessages(anthropicMessages))

  const body: Record<string, unknown> = {
    model: targetModel,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  }

  // Tools
  if (anthropicTools.length > 0) {
    body.tools = translateTools(anthropicTools)
    body.tool_choice = 'auto'
  }

  // Max tokens
  if (anthropicBody.max_tokens) {
    body.max_tokens = anthropicBody.max_tokens
  }

  // Temperature
  if (anthropicBody.temperature !== undefined) {
    body.temperature = anthropicBody.temperature
  }

  // Thinking → reasoning_effort
  const thinking = anthropicBody.thinking as
    | { type: string; budget_tokens?: number }
    | undefined
  if (thinking?.type === 'enabled' && thinking.budget_tokens) {
    const budget = thinking.budget_tokens
    if (budget <= 1024) {
      body.reasoning_effort = 'low'
    } else if (budget <= 8192) {
      body.reasoning_effort = 'medium'
    } else {
      body.reasoning_effort = 'high'
    }
  }

  return body
}

// ── SSE helpers ─────────────────────────────────────────────────────

function formatSSE(event: string, data: string): string {
  return `event: ${event}\ndata: ${data}\n\n`
}

// ── Streaming response translation: Chat Completions → Anthropic ────

async function translateStreamToAnthropic(
  openaiResponse: Response,
  modelId: string,
): Promise<Response> {
  const messageId = `msg_oai_${Date.now()}`

  const readable = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder()
      let contentBlockIndex = 0
      let outputTokens = 0
      let inputTokens = 0

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

      let currentTextBlockStarted = false
      let inReasoningBlock = false
      let hadToolCalls = false
      // Track tool call indices from OpenAI → our content block indices
      const toolCallIndexMap = new Map<number, number>()

      try {
        const reader = openaiResponse.body?.getReader()
        if (!reader) {
          emitTextBlock(
            controller,
            encoder,
            contentBlockIndex,
            'Error: No response body',
          )
          finishStream(
            controller,
            encoder,
            outputTokens,
            inputTokens,
            false,
          )
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

            // Usage chunk (stream_options.include_usage)
            if (chunk.usage) {
              const usage = chunk.usage as Record<string, number>
              inputTokens = usage.prompt_tokens || inputTokens
              outputTokens = usage.completion_tokens || outputTokens
            }

            const choices = chunk.choices as
              | Array<Record<string, unknown>>
              | undefined
            if (!choices || choices.length === 0) continue
            const choice = choices[0]
            const delta = choice.delta as Record<string, unknown> | undefined
            const finishReason = choice.finish_reason as string | null

            if (delta) {
              // ── Reasoning content (thinking) ────────────────────
              if (delta.reasoning_content) {
                const text = delta.reasoning_content as string
                if (!inReasoningBlock) {
                  inReasoningBlock = true
                  controller.enqueue(
                    encoder.encode(
                      formatSSE(
                        'content_block_start',
                        JSON.stringify({
                          type: 'content_block_start',
                          index: contentBlockIndex,
                          content_block: { type: 'thinking', thinking: '' },
                        }),
                      ),
                    ),
                  )
                }
                controller.enqueue(
                  encoder.encode(
                    formatSSE(
                      'content_block_delta',
                      JSON.stringify({
                        type: 'content_block_delta',
                        index: contentBlockIndex,
                        delta: { type: 'thinking_delta', thinking: text },
                      }),
                    ),
                  ),
                )
              }

              // ── Text content ────────────────────────────────────
              if (delta.content) {
                const text = delta.content as string
                if (text.length > 0) {
                  // Close reasoning block if transitioning
                  if (inReasoningBlock) {
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
                    inReasoningBlock = false
                  }

                  if (!currentTextBlockStarted) {
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
                    currentTextBlockStarted = true
                  }
                  controller.enqueue(
                    encoder.encode(
                      formatSSE(
                        'content_block_delta',
                        JSON.stringify({
                          type: 'content_block_delta',
                          index: contentBlockIndex,
                          delta: { type: 'text_delta', text },
                        }),
                      ),
                    ),
                  )
                }
              }

              // ── Tool calls ──────────────────────────────────────
              if (delta.tool_calls) {
                const toolCalls = delta.tool_calls as Array<{
                  index: number
                  id?: string
                  type?: string
                  function?: { name?: string; arguments?: string }
                }>

                for (const tc of toolCalls) {
                  // Close text block if open and starting first tool call
                  if (
                    currentTextBlockStarted &&
                    !toolCallIndexMap.has(tc.index)
                  ) {
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
                    currentTextBlockStarted = false
                  }

                  // Close reasoning block if open
                  if (inReasoningBlock && !toolCallIndexMap.has(tc.index)) {
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
                    inReasoningBlock = false
                  }

                  if (!toolCallIndexMap.has(tc.index)) {
                    // New tool call — emit content_block_start
                    toolCallIndexMap.set(tc.index, contentBlockIndex)
                    hadToolCalls = true
                    controller.enqueue(
                      encoder.encode(
                        formatSSE(
                          'content_block_start',
                          JSON.stringify({
                            type: 'content_block_start',
                            index: contentBlockIndex,
                            content_block: {
                              type: 'tool_use',
                              id: tc.id || `toolu_${Date.now()}_${tc.index}`,
                              name: tc.function?.name || '',
                              input: {},
                            },
                          }),
                        ),
                      ),
                    )
                  }

                  // Stream argument deltas
                  if (tc.function?.arguments) {
                    const blockIdx = toolCallIndexMap.get(tc.index)!
                    controller.enqueue(
                      encoder.encode(
                        formatSSE(
                          'content_block_delta',
                          JSON.stringify({
                            type: 'content_block_delta',
                            index: blockIdx,
                            delta: {
                              type: 'input_json_delta',
                              partial_json: tc.function.arguments,
                            },
                          }),
                        ),
                      ),
                    )
                  }
                }
              }
            }

            // ── Finish reason → close blocks and emit message_delta ──
            if (finishReason) {
              // Close open blocks
              if (inReasoningBlock) {
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
                inReasoningBlock = false
              }
              if (currentTextBlockStarted) {
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
                currentTextBlockStarted = false
              }
              // Close any open tool call blocks
              for (const [, blockIdx] of toolCallIndexMap) {
                controller.enqueue(
                  encoder.encode(
                    formatSSE(
                      'content_block_stop',
                      JSON.stringify({
                        type: 'content_block_stop',
                        index: blockIdx,
                      }),
                    ),
                  ),
                )
              }
              toolCallIndexMap.clear()
            }
          }
        }
      } catch (err) {
        // Emit error as text
        if (!currentTextBlockStarted) {
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
          currentTextBlockStarted = true
        }
        controller.enqueue(
          encoder.encode(
            formatSSE(
              'content_block_delta',
              JSON.stringify({
                type: 'content_block_delta',
                index: contentBlockIndex,
                delta: {
                  type: 'text_delta',
                  text: `\n\n[Error: ${String(err)}]`,
                },
              }),
            ),
          ),
        )
      }

      // Close any remaining open blocks
      if (currentTextBlockStarted) {
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
      }
      if (inReasoningBlock) {
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
      }
      for (const [, blockIdx] of toolCallIndexMap) {
        controller.enqueue(
          encoder.encode(
            formatSSE(
              'content_block_stop',
              JSON.stringify({
                type: 'content_block_stop',
                index: blockIdx,
              }),
            ),
          ),
        )
      }

      finishStream(
        controller,
        encoder,
        outputTokens,
        inputTokens,
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

function emitTextBlock(
  controller: ReadableStreamDefaultController,
  encoder: TextEncoder,
  index: number,
  text: string,
): void {
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
  controller.enqueue(
    encoder.encode(
      formatSSE(
        'content_block_delta',
        JSON.stringify({
          type: 'content_block_delta',
          index,
          delta: { type: 'text_delta', text },
        }),
      ),
    ),
  )
  controller.enqueue(
    encoder.encode(
      formatSSE(
        'content_block_stop',
        JSON.stringify({ type: 'content_block_stop', index }),
      ),
    ),
  )
}

function finishStream(
  controller: ReadableStreamDefaultController,
  encoder: TextEncoder,
  outputTokens: number,
  inputTokens: number,
  hadToolCalls: boolean,
): void {
  const stopReason = hadToolCalls ? 'tool_use' : 'end_turn'

  controller.enqueue(
    encoder.encode(
      formatSSE(
        'message_delta',
        JSON.stringify({
          type: 'message_delta',
          delta: { stop_reason: stopReason, stop_sequence: null },
          usage: { output_tokens: outputTokens },
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
          usage: { input_tokens: inputTokens, output_tokens: outputTokens },
        }),
      ),
    ),
  )
  controller.close()
}

// ── Main fetch interceptor factory ──────────────────────────────────

/**
 * Creates a fetch function that intercepts Anthropic SDK calls and routes
 * them to an OpenAI Chat Completions-compatible endpoint.
 */
export function createChatCompletionsFetch(
  config: ProviderConfig,
  authHeaders: Record<string, string>,
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  const baseUrl = config.baseUrl || 'https://api.openai.com/v1'
  const targetModelId = config.models[0]?.id || 'gpt-4'

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

    // Resolve model: use the model from the request if it matches a
    // configured model, otherwise use the first configured model
    const requestModel = anthropicBody.model as string | undefined
    const resolvedModel = requestModel
      ? config.models.find(
          (m) => m.id === requestModel || m.alias === requestModel,
        )?.id || targetModelId
      : targetModelId

    // Translate to Chat Completions format
    const openaiBody = translateToOpenAIBody(anthropicBody, resolvedModel)

    // Make the request
    const endpoint = `${baseUrl.replace(/\/$/, '')}/chat/completions`
    const response = await globalThis.fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        ...authHeaders,
      },
      body: JSON.stringify(openaiBody),
    })

    if (!response.ok) {
      const errorText = await response.text()
      const errorBody = {
        type: 'error',
        error: {
          type: 'api_error',
          message: `Chat Completions API error (${response.status}): ${errorText}`,
        },
      }
      return new Response(JSON.stringify(errorBody), {
        status: response.status,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    return translateStreamToAnthropic(response, resolvedModel)
  }
}
