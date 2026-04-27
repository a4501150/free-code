/**
 * Codex Fetch Adapter
 *
 * Intercepts fetch calls from the Anthropic SDK and routes them to
 * ChatGPT's Codex backend API, translating between Anthropic Messages API
 * format and OpenAI Responses API format.
 *
 * Supports:
 * - Text messages (user/assistant)
 * - System prompts → instructions
 * - Tool definitions (Anthropic input_schema → OpenAI parameters)
 * - Tool use (tool_use → function_call, tool_result → function_call_output)
 * - Streaming events translation
 *
 * Endpoint: {baseUrl}/responses (default: https://chatgpt.com/backend-api/codex/responses)
 */

import { codexAdapter } from './adapters/codex-adapter-impl.js'
import { toAnthropicErrorType } from '../../utils/normalizedError.js'
import { getProviderRegistry } from '../../utils/model/providerRegistry.js'

// No hardcoded model list — the provider registry (freecode.json) is the
// single source of truth for available models. The adapter just passes
// through whatever model ID the registry resolved.

// ── JWT helpers ─────────────────────────────────────────────────────

const JWT_CLAIM_PATH = 'https://api.openai.com/auth'

/**
 * Extracts the account ID from a Codex JWT token.
 * @param token - The JWT token to extract the account ID from
 * @returns The account ID
 * @throws Error if the token is invalid or account ID cannot be extracted
 */
function extractAccountId(token: string): string {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) throw new Error('Invalid token')
    const payload = JSON.parse(atob(parts[1]))
    const accountId = payload?.[JWT_CLAIM_PATH]?.chatgpt_account_id
    if (!accountId) throw new Error('No account ID in token')
    return accountId
  } catch {
    throw new Error('Failed to extract account ID from Codex token')
  }
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
  thinking?: string
  signature?: string
  // Codex-specific side-channel fields carried on `thinking` blocks so that
  // prior-turn reasoning can be echoed verbatim back to OpenAI in `input[]`.
  // See `response.output_item.done` handler in
  // translateCodexStreamToAnthropic.
  codexReasoningId?: string
  codexEncryptedContent?: string
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
  // Anthropic server-tool shape: `{type: 'web_search_20250305', name: 'web_search', ...}`
  // and similar. Detected by presence of `type` (regular function tools omit it).
  type?: string
  allowed_domains?: string[]
  blocked_domains?: string[]
  max_uses?: number
}

/** Anthropic tool_choice payload as sent on outbound bodies. */
type AnthropicToolChoice =
  | { type: 'auto' }
  | { type: 'any' }
  | { type: 'tool'; name: string }
  | undefined

// ── Tool translation: Anthropic → Codex ─────────────────────────────

/**
 * Tool-owned schemas (MCP servers, StructuredOutput) and `.passthrough()`
 * opt-outs skip `makeJsonSchemaStrict` in toolToAPISchema (src/utils/api.ts),
 * so they reach the adapter without the strict-shape invariants OpenAI
 * requires (recursive `additionalProperties: false`, all properties in
 * `required`). Setting `strict: true` on them would 400 the entire request,
 * not just the offending tool — one rogue MCP tool kills every turn.
 *
 * Detect via the root-level `additionalProperties: false` marker that
 * `makeJsonSchemaStrict` always sets — present iff the tool went through
 * the universal strict transform.
 */
function isStrictCompatibleSchema(schema: unknown): boolean {
  return (
    typeof schema === 'object' &&
    schema !== null &&
    (schema as { additionalProperties?: unknown }).additionalProperties ===
      false
  )
}

/**
 * Translates Anthropic tool definitions to Codex format.
 *
 * The `strict` field is set from the model's `structuredOutputs` capability
 * flag (see `ProviderModelSchema` in `utils/settings/types.ts`):
 *
 *   - undefined → field omitted (server default applies).
 *   - false → `strict: false` for every tool (explicit best-effort).
 *   - true → `strict: true` only for tools whose schema is strict-compatible
 *     (root `additionalProperties: false`). Tool-owned (MCP/StructuredOutput)
 *     and passthrough tools omit the field to avoid the entire request 400'ing
 *     on a single non-conforming schema.
 *
 * @param anthropicTools - Array of Anthropic tool definitions
 * @param model - Model ID used to look up provider capabilities
 * @returns Array of Codex-compatible tool objects
 */
function translateTools(
  anthropicTools: AnthropicTool[],
  model: string,
): {
  tools: Array<Record<string, unknown>>
  hasWebSearch: boolean
} {
  const structuredOutputs = getProviderRegistry().getModelFlag(
    model,
    'structuredOutputs',
  )
  const tools: Array<Record<string, unknown>> = []
  let hasWebSearch = false
  for (const tool of anthropicTools) {
    // Anthropic web search server-tool → OpenAI native `web_search_preview`.
    // The codex adapter synthesizes Anthropic `server_tool_use` /
    // `web_search_tool_result` blocks from the Responses API's
    // `web_search_call` events on the response side. `allowed_domains`,
    // `blocked_domains`, and `max_uses` are not accepted by the OpenAI
    // preview tool — drop them. (Lossy but acceptable for a v1 surface.)
    if (tool.type === 'web_search_20250305') {
      tools.push({ type: 'web_search_preview' })
      hasWebSearch = true
      continue
    }
    // Other server tools we don't handle yet — drop with a warning by
    // omission; the function tool translation below covers regular tools.
    if (tool.type && tool.type !== 'function') {
      continue
    }
    const parameters = tool.input_schema || { type: 'object', properties: {} }
    let strictField: { strict: boolean } | Record<string, never> = {}
    if (structuredOutputs === true) {
      if (isStrictCompatibleSchema(parameters)) {
        strictField = { strict: true }
      }
      // else: omit — schema would 400 under strict; let server default apply.
    } else if (structuredOutputs === false) {
      strictField = { strict: false }
    }
    tools.push({
      type: 'function',
      name: tool.name,
      description: tool.description || '',
      parameters,
      ...strictField,
    })
  }
  return { tools, hasWebSearch }
}

/**
 * Translate an Anthropic tool_choice payload to the OpenAI Responses API
 * shape. Most cases pass through to `auto`; named-tool choice is honored
 * only when the named tool is the (translated) web_search server tool.
 */
function translateToolChoice(
  toolChoice: AnthropicToolChoice,
  hasWebSearch: boolean,
): Record<string, unknown> | string {
  if (!toolChoice) return 'auto'
  if (toolChoice.type === 'tool' && toolChoice.name === 'web_search') {
    if (hasWebSearch) {
      return { type: 'web_search_preview' }
    }
    return 'auto'
  }
  if (toolChoice.type === 'any') return 'required'
  return 'auto'
}

// ── Message translation: Anthropic → Codex input ────────────────────

/**
 * Translates Anthropic message format to Codex input format.
 * Handles text content, tool results, and image attachments.
 * @param anthropicMessages - Array of messages in Anthropic format
 * @returns Array of Codex-compatible input objects
 */
function translateMessages(
  anthropicMessages: AnthropicMessage[],
): Array<Record<string, unknown>> {
  const codexInput: Array<Record<string, unknown>> = []
  // Track tool_use IDs to generate call_ids for function_call_output
  // Anthropic uses tool_use_id, Codex uses call_id
  let toolCallCounter = 0

  for (const msg of anthropicMessages) {
    if (typeof msg.content === 'string') {
      codexInput.push({ role: msg.role, content: msg.content })
      continue
    }

    if (!Array.isArray(msg.content)) continue

    if (msg.role === 'user') {
      const contentArr: Array<Record<string, unknown>> = []
      for (const block of msg.content) {
        if (block.type === 'web_search_tool_result') {
          // Synthetic Anthropic block from a prior turn's web search result
          // (we synthesize these on the response side). The OpenAI Responses
          // API has no input shape for them; drop and rely on the assistant's
          // text response to carry the search outcome forward.
          continue
        }
        if (block.type === 'tool_result') {
          const callId = block.tool_use_id || `call_${toolCallCounter++}`
          let outputText = ''
          if (typeof block.content === 'string') {
            outputText = block.content
          } else if (Array.isArray(block.content)) {
            outputText = block.content
              .map(c => {
                if (c.type === 'text') return c.text
                if (c.type === 'image') return '[Image data attached]'
                return ''
              })
              .join('\n')
          }
          codexInput.push({
            type: 'function_call_output',
            call_id: callId,
            output: outputText || '',
          })
        } else if (block.type === 'text' && typeof block.text === 'string') {
          contentArr.push({ type: 'input_text', text: block.text })
        } else if (
          block.type === 'image' &&
          typeof block.source === 'object' &&
          block.source !== null &&
          (block.source as any).type === 'base64'
        ) {
          contentArr.push({
            type: 'input_image',
            image_url: `data:${(block.source as any).media_type};base64,${(block.source as any).data}`,
          })
        }
      }
      if (contentArr.length > 0) {
        if (contentArr.length === 1 && contentArr[0].type === 'input_text') {
          codexInput.push({ role: 'user', content: contentArr[0].text })
        } else {
          codexInput.push({ role: 'user', content: contentArr })
        }
      }
    } else {
      // Process assistant or tool blocks
      for (const block of msg.content) {
        if (block.type === 'server_tool_use') {
          // Synthetic Anthropic block we emitted for a `web_search_call`.
          // Has no representation in the Responses API `input[]` shape —
          // drop. Subsequent turns just carry the assistant's text reply.
          continue
        }
        if (block.type === 'text' && typeof block.text === 'string') {
          if (msg.role === 'assistant') {
            codexInput.push({
              type: 'message',
              role: 'assistant',
              content: [
                { type: 'output_text', text: block.text, annotations: [] },
              ],
              status: 'completed',
            })
          }
        } else if (block.type === 'tool_use') {
          const callId = block.id || `call_${toolCallCounter++}`
          codexInput.push({
            type: 'function_call',
            call_id: callId,
            name: block.name || '',
            arguments: JSON.stringify(block.input || {}),
          })
        } else if (
          block.type === 'thinking' &&
          msg.role === 'assistant' &&
          typeof block.codexReasoningId === 'string' &&
          block.codexReasoningId.length > 0 &&
          typeof block.codexEncryptedContent === 'string' &&
          block.codexEncryptedContent.length > 0
        ) {
          // Echo prior-turn Codex reasoning back verbatim so the model can
          // build on it. Blocks lacking the side-channel fields (foreign
          // provenance, or imported transcripts) are skipped — reasoning
          // continuity simply starts fresh at that message.
          const summaryText =
            typeof block.thinking === 'string' ? block.thinking : ''
          codexInput.push({
            type: 'reasoning',
            id: block.codexReasoningId,
            encrypted_content: block.codexEncryptedContent,
            summary: summaryText
              ? [{ type: 'summary_text', text: summaryText }]
              : [],
          })
        }
      }
    }
  }

  return codexInput
}

// ── Full request translation ────────────────────────────────────────

/**
 * Translates a complete Anthropic API request body to Codex format.
 * @param anthropicBody - The Anthropic request body to translate
 * @returns Object containing the translated Codex body and model
 */
function translateToCodexBody(
  anthropicBody: Record<string, unknown>,
  sessionId: string,
): {
  codexBody: Record<string, unknown>
  codexModel: string
} {
  const anthropicMessages = (anthropicBody.messages || []) as AnthropicMessage[]
  const systemPrompt = anthropicBody.system as
    | string
    | Array<{ type: string; text?: string; cache_control?: unknown }>
    | undefined
  const codexModel = (anthropicBody.model as string) || 'gpt-5.3-codex'
  const anthropicTools = (anthropicBody.tools || []) as AnthropicTool[]

  // Build system instructions
  let instructions = ''
  if (systemPrompt) {
    instructions =
      typeof systemPrompt === 'string'
        ? systemPrompt
        : Array.isArray(systemPrompt)
          ? systemPrompt
              .filter(b => b.type === 'text' && typeof b.text === 'string')
              .map(b => b.text!)
              .join('\n')
          : ''
  }

  // Convert messages
  const input = translateMessages(anthropicMessages)

  const codexBody: Record<string, unknown> = {
    model: codexModel,
    store: false,
    stream: true,
    instructions,
    input,
    tool_choice: 'auto',
    parallel_tool_calls: true,
    // Route requests to the same backend node so the KV cache is reused.
    // The official Codex CLI uses the conversation UUID for this field.
    prompt_cache_key: sessionId,
    // Request opaque `encrypted_content` on reasoning items in the response
    // so we can echo them back in `input[]` on subsequent turns for
    // stateless (store:false) reasoning continuity. Matches the official
    // Codex CLI (codex-rs/core/src/client.rs).
    include: ['reasoning.encrypted_content'],
  }

  // Add tools if present
  let hasWebSearch = false
  if (anthropicTools.length > 0) {
    const translated = translateTools(anthropicTools, codexModel)
    codexBody.tools = translated.tools
    hasWebSearch = translated.hasWebSearch
  }

  // Honor named tool_choice only for the web_search server tool. WebSearchTool
  // forces `tool_choice: {type: 'tool', name: 'web_search'}`; without this
  // translation the adapter would drop it and the model might pick a
  // different (or no) tool, breaking the nested WebSearch query.
  codexBody.tool_choice = translateToolChoice(
    anthropicBody.tool_choice as AnthropicToolChoice,
    hasWebSearch,
  )

  // Effort → reasoning_effort (OpenAI Responses API)
  const outputConfig = anthropicBody.output_config as
    | { effort?: string }
    | undefined
  if (outputConfig?.effort) {
    codexBody.reasoning = { effort: outputConfig.effort }
  }

  return { codexBody, codexModel }
}

// ── Response translation: Codex SSE → Anthropic SSE ─────────────────

/**
 * Formats data as Server-Sent Events (SSE) format.
 * @param event - The event type
 * @param data - The data payload
 * @returns Formatted SSE string
 */
function formatSSE(event: string, data: string): string {
  return `event: ${event}\ndata: ${data}\n\n`
}

/**
 * Translates Codex streaming response to Anthropic format.
 * Converts Codex SSE events into Anthropic-compatible streaming events.
 * @param codexResponse - The streaming response from Codex API
 * @param codexModel - The Codex model used for the request
 * @returns Transformed Response object with Anthropic-format stream
 */
async function translateCodexStreamToAnthropic(
  codexResponse: Response,
  codexModel: string,
): Promise<Response> {
  const messageId = `msg_codex_${Date.now()}`

  const readable = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder()
      let contentBlockIndex = 0
      let outputTokens = 0
      let inputTokens = 0
      let cacheReadInputTokens = 0

      // Emit Anthropic message_start
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
                model: codexModel,
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

      // Track state for tool calls
      let currentTextBlockStarted = false
      let currentToolCallId = ''
      let currentToolCallName = ''
      let currentToolCallArgs = ''
      let inToolCall = false
      let hadToolCalls = false

      // ── Web search state ──────────────────────────────────────
      // Codex emits `web_search_call` items with their own lifecycle:
      //   output_item.added (item.type='web_search_call', id, action.query)
      //   → response.web_search_call.in_progress / .searching
      //   → response.web_search_call.completed
      //   → output_item.done (item.action.results, citations)
      // We synthesize Anthropic `server_tool_use` + `web_search_tool_result`
      // blocks so the WebSearchTool consumer (which only knows Anthropic
      // shapes) can read structured results.
      let webSearchCount = 0
      // Per-call state, keyed by Codex item id (call_id).
      const pendingWebSearches = new Map<
        string,
        {
          query: string
          serverToolUseEmitted: boolean
          serverToolUseClosed: boolean
          serverToolUseIndex: number
          resultEmitted: boolean
        }
      >()
      // Citations harvested from output_text annotations, accumulated and
      // attached to the most recent web_search if the structured
      // `action.results` is missing.
      const pendingCitations: Array<{
        url: string
        title: string
      }> = []

      // ── Reasoning buffering state ─────────────────────────────
      // Codex / OpenAI Responses streams `reasoning` items as:
      //   output_item.added (id, empty content) → reasoning_*_delta (text)
      //                                         → output_item.done (encrypted_content)
      // We buffer text deltas so we can emit the full thinking block AT ONCE
      // when output_item.done arrives — that's when `encrypted_content` is
      // available, and we need it on the content_block_start so the block
      // can be round-tripped on the next turn via the side-channel fields
      // `codexReasoningId` / `codexEncryptedContent`.
      let pendingReasoningId: string | null = null
      let pendingReasoningText = ''

      try {
        const reader = codexResponse.body?.getReader()
        if (!reader) {
          emitTextBlock(
            controller,
            encoder,
            contentBlockIndex,
            'Error: No response body',
          )
          finishStream(controller, encoder, outputTokens, inputTokens, 0, false)
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
            if (!trimmed) continue

            // Parse "event: xxx" lines
            if (trimmed.startsWith('event: ')) continue

            if (!trimmed.startsWith('data: ')) continue
            const dataStr = trimmed.slice(6)
            if (dataStr === '[DONE]') continue

            let event: Record<string, unknown>
            try {
              event = JSON.parse(dataStr)
            } catch {
              continue
            }

            const eventType = event.type as string

            // ── Text output events ──────────────────────────────
            if (eventType === 'response.output_item.added') {
              const item = event.item as Record<string, unknown>
              if (item?.type === 'reasoning') {
                // Capture the reasoning item id for later round-tripping;
                // do NOT emit SSE yet — encrypted_content only becomes
                // available on output_item.done. Text deltas stream in
                // between and are accumulated into pendingReasoningText.
                pendingReasoningId = (item.id as string) || null
                pendingReasoningText = ''
              } else if (item?.type === 'message') {
                // New text message block starting
                if (inToolCall) {
                  // Close the previous tool call block
                  closeToolCallBlock(
                    controller,
                    encoder,
                    contentBlockIndex,
                    currentToolCallId,
                    currentToolCallName,
                    currentToolCallArgs,
                  )
                  contentBlockIndex++
                  inToolCall = false
                }
              } else if (item?.type === 'function_call') {
                // Close text block if open
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

                // Start tool_use block (Anthropic format)
                currentToolCallId =
                  (item.call_id as string) || `toolu_${Date.now()}`
                currentToolCallName = (item.name as string) || ''
                currentToolCallArgs = (item.arguments as string) || ''
                inToolCall = true
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
                          id: currentToolCallId,
                          name: currentToolCallName,
                          input: {},
                        },
                      }),
                    ),
                  ),
                )
              } else if (item?.type === 'web_search_call') {
                // Close any open text block before opening a synthetic
                // server_tool_use block. Don't touch function_call state —
                // web_search runs in its own item lifecycle.
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

                const callId =
                  (item.id as string) ||
                  `srvtoolu_${Date.now()}_${webSearchCount}`
                const action = item.action as { query?: string } | undefined
                const query = (action?.query as string) || ''

                // Open Anthropic server_tool_use block.
                controller.enqueue(
                  encoder.encode(
                    formatSSE(
                      'content_block_start',
                      JSON.stringify({
                        type: 'content_block_start',
                        index: contentBlockIndex,
                        content_block: {
                          type: 'server_tool_use',
                          id: callId,
                          name: 'web_search',
                          input: {},
                        },
                      }),
                    ),
                  ),
                )
                // Stream the query as input_json_delta so WebSearchTool's
                // progress regex (`"query"\s*:\s*"..."`) can pick it up.
                if (query) {
                  controller.enqueue(
                    encoder.encode(
                      formatSSE(
                        'content_block_delta',
                        JSON.stringify({
                          type: 'content_block_delta',
                          index: contentBlockIndex,
                          delta: {
                            type: 'input_json_delta',
                            partial_json: JSON.stringify({ query }),
                          },
                        }),
                      ),
                    ),
                  )
                }

                pendingWebSearches.set(callId, {
                  query,
                  serverToolUseEmitted: true,
                  serverToolUseClosed: false,
                  serverToolUseIndex: contentBlockIndex,
                  resultEmitted: false,
                })
                hadToolCalls = true
                webSearchCount++
              }
            }

            // Web search progress events — keep the synthetic server_tool_use
            // block open and let WebSearchTool's UI progress fire on the
            // input_json_delta we already emitted; nothing more to do here.
            else if (
              eventType === 'response.web_search_call.in_progress' ||
              eventType === 'response.web_search_call.searching'
            ) {
              // no-op
            }

            // Web search completed — close the server_tool_use block. The
            // structured result block is emitted at output_item.done where
            // the action.results / item annotations are available.
            else if (eventType === 'response.web_search_call.completed') {
              const callId = (event.item_id as string) || ''
              const state = callId ? pendingWebSearches.get(callId) : undefined
              if (state && !state.serverToolUseClosed) {
                controller.enqueue(
                  encoder.encode(
                    formatSSE(
                      'content_block_stop',
                      JSON.stringify({
                        type: 'content_block_stop',
                        index: state.serverToolUseIndex,
                      }),
                    ),
                  ),
                )
                state.serverToolUseClosed = true
                contentBlockIndex++
              }
            }

            // Text deltas
            else if (eventType === 'response.output_text.delta') {
              const text = event.delta as string
              if (typeof text === 'string' && text.length > 0) {
                if (!currentTextBlockStarted) {
                  // Start a new text content block
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
                outputTokens += 1
              }
            }

            // Reasoning deltas: accumulate into per-item buffer; emit
            // once output_item.done fires with encrypted_content. Codex
            // uses `response.reasoning_text.delta` and
            // `response.reasoning_summary_text.delta`; older shapes use
            // `response.reasoning.delta`. Treat all three identically.
            //
            // Same spec-authority rule as function_call_arguments: the
            // `.done` event's `text` field is the authoritative final
            // string. Deltas are an optional incremental channel. When the
            // `.done` event is present we replace the accumulator with its
            // `text`; for servers that emit only deltas (no `.done`), the
            // accumulated buffer is used as-is.
            else if (
              eventType === 'response.reasoning_text.delta' ||
              eventType === 'response.reasoning_summary_text.delta' ||
              eventType === 'response.reasoning.delta'
            ) {
              const text = event.delta as string | undefined
              if (typeof text === 'string') {
                pendingReasoningText += text
              }
            }

            // Reasoning terminal events — authoritative full text.
            else if (
              eventType === 'response.reasoning_text.done' ||
              eventType === 'response.reasoning_summary_text.done' ||
              eventType === 'response.reasoning.done'
            ) {
              const finalText = event.text as string | undefined
              if (typeof finalText === 'string' && finalText.length > 0) {
                pendingReasoningText = finalText
              }
            }

            // ── Tool call argument deltas ───────────────────────
            // Per the OpenAI Responses API spec, `.done.arguments` is the
            // authoritative final string; `.delta` events are an optional
            // incremental channel. Grammar-constrained servers (LM Studio,
            // vLLM with xgrammar, llama-server with json-schema grammar)
            // emit only `.done` and skip deltas entirely. To be spec-correct
            // for both shapes AND produce byte-identical output regardless of
            // server streaming style, we silently accumulate deltas here and
            // emit ONE `input_json_delta` on `.done`, preferring the
            // authoritative `.done.arguments` over the accumulator.
            //
            // Live token-by-token streaming of tool args to the UI was never
            // a user-visible feature: claude.ts skips BetaMessageStream's
            // partialParse(); `contentBlock.input` is accumulated as a raw
            // string and only JSON-parsed at content_block_stop inside
            // normalizeContentFromAPI. So this change has zero UX cost.
            else if (eventType === 'response.function_call_arguments.delta') {
              const argDelta = event.delta as string
              if (typeof argDelta === 'string' && inToolCall) {
                currentToolCallArgs += argDelta
              }
            }

            // Tool call arguments complete — emit the canonical args as a
            // single input_json_delta. Falls back to the delta accumulator
            // only if the server omits `event.arguments` (non-conformant).
            else if (eventType === 'response.function_call_arguments.done') {
              if (inToolCall) {
                const fullArgs =
                  (typeof event.arguments === 'string'
                    ? event.arguments
                    : undefined) ?? currentToolCallArgs
                if (fullArgs) {
                  controller.enqueue(
                    encoder.encode(
                      formatSSE(
                        'content_block_delta',
                        JSON.stringify({
                          type: 'content_block_delta',
                          index: contentBlockIndex,
                          delta: {
                            type: 'input_json_delta',
                            partial_json: fullArgs,
                          },
                        }),
                      ),
                    ),
                  )
                }
                currentToolCallArgs = fullArgs
              }
            }

            // Output item done — close blocks
            else if (eventType === 'response.output_item.done') {
              const item = event.item as Record<string, unknown>
              if (item?.type === 'function_call') {
                closeToolCallBlock(
                  controller,
                  encoder,
                  contentBlockIndex,
                  currentToolCallId,
                  currentToolCallName,
                  currentToolCallArgs,
                )
                contentBlockIndex++
                inToolCall = false
                currentToolCallArgs = ''
              } else if (item?.type === 'message') {
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
                // Harvest url_citation annotations from the assistant
                // message's output_text content. OpenAI returns search
                // results either as `web_search_call.action.results` (handled
                // below) or only as annotations on the assistant text.
                const content = item.content as
                  | Array<{
                      type?: string
                      annotations?: Array<{
                        type?: string
                        url?: string
                        title?: string
                      }>
                    }>
                  | undefined
                if (Array.isArray(content)) {
                  for (const part of content) {
                    if (
                      part?.type !== 'output_text' ||
                      !Array.isArray(part.annotations)
                    ) {
                      continue
                    }
                    for (const ann of part.annotations) {
                      if (
                        ann?.type === 'url_citation' &&
                        typeof ann.url === 'string' &&
                        ann.url.length > 0
                      ) {
                        pendingCitations.push({
                          url: ann.url,
                          title:
                            typeof ann.title === 'string' ? ann.title : ann.url,
                        })
                      }
                    }
                  }
                }
              } else if (item?.type === 'web_search_call') {
                const callId = (item.id as string) || ''
                const state = callId
                  ? pendingWebSearches.get(callId)
                  : undefined
                // The completed event may not have fired yet on some shapes;
                // close the server_tool_use block here defensively.
                if (state && !state.serverToolUseClosed) {
                  controller.enqueue(
                    encoder.encode(
                      formatSSE(
                        'content_block_stop',
                        JSON.stringify({
                          type: 'content_block_stop',
                          index: state.serverToolUseIndex,
                        }),
                      ),
                    ),
                  )
                  state.serverToolUseClosed = true
                  contentBlockIndex++
                }
                if (!state || state.resultEmitted) {
                  // Nothing else to do.
                } else {
                  // Prefer structured `action.results`; otherwise fall back
                  // to the citations we harvested from output_text.
                  const action = item.action as
                    | {
                        results?: Array<{
                          url?: string
                          title?: string
                        }>
                      }
                    | undefined
                  const structured = Array.isArray(action?.results)
                    ? action!.results
                    : []
                  const results: Array<{ url: string; title: string }> = []
                  for (const r of structured) {
                    if (typeof r?.url === 'string' && r.url.length > 0) {
                      results.push({
                        url: r.url,
                        title:
                          typeof r.title === 'string' && r.title.length > 0
                            ? r.title
                            : r.url,
                      })
                    }
                  }
                  if (results.length === 0 && pendingCitations.length > 0) {
                    results.push(...pendingCitations.splice(0))
                  }

                  controller.enqueue(
                    encoder.encode(
                      formatSSE(
                        'content_block_start',
                        JSON.stringify({
                          type: 'content_block_start',
                          index: contentBlockIndex,
                          content_block: {
                            type: 'web_search_tool_result',
                            tool_use_id: callId,
                            content: results.map(r => ({
                              type: 'web_search_result',
                              url: r.url,
                              title: r.title,
                            })),
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
                  contentBlockIndex++
                  state.resultEmitted = true
                }
              } else if (item?.type === 'reasoning') {
                // Now we have {id, encrypted_content, summary}. Emit the
                // full synthetic thinking sequence in one burst. The
                // `codexReasoningId` / `codexEncryptedContent` extra
                // fields ride along on the content_block_start payload
                // via `...content_block` spread in claude.ts's streaming
                // loop, surviving into the in-memory assistant message
                // and through disk persistence so they can be echoed
                // back in `input[]` on the next turn.
                const reasoningId =
                  (item.id as string) || pendingReasoningId || ''
                const encryptedContent =
                  (item.encrypted_content as string) || ''

                // If no text delta or `.done` event arrived, fall back to
                // scraping the terminal `output_item.done` payload.
                //
                // Two shapes in the wild:
                //   - OpenAI summary-only mode (effort="none" or similar):
                //     text lives in `item.summary[]` with type "summary_text".
                //   - LM Studio / grammar-constrained full-reasoning mode:
                //     text lives in `item.content[]` with type "reasoning_text".
                // Try summary first (OpenAI canonical), then content.
                if (!pendingReasoningText) {
                  const summary =
                    (item.summary as
                      | Array<{ type?: string; text?: string }>
                      | undefined) || []
                  pendingReasoningText = summary
                    .map(s =>
                      s?.type === 'summary_text' && typeof s.text === 'string'
                        ? s.text
                        : '',
                    )
                    .join('')
                }
                if (!pendingReasoningText) {
                  const content =
                    (item.content as
                      | Array<{ type?: string; text?: string }>
                      | undefined) || []
                  pendingReasoningText = content
                    .map(c =>
                      c?.type === 'reasoning_text' && typeof c.text === 'string'
                        ? c.text
                        : '',
                    )
                    .join('')
                }

                // Skip emission entirely if we have no reasoning id to
                // round-trip AND no text to show — nothing meaningful
                // to carry.
                if (reasoningId || pendingReasoningText || encryptedContent) {
                  const startPayload: Record<string, unknown> = {
                    type: 'thinking',
                    thinking: '',
                    signature: '',
                  }
                  if (reasoningId) {
                    startPayload.codexReasoningId = reasoningId
                  }
                  if (encryptedContent) {
                    startPayload.codexEncryptedContent = encryptedContent
                  }

                  controller.enqueue(
                    encoder.encode(
                      formatSSE(
                        'content_block_start',
                        JSON.stringify({
                          type: 'content_block_start',
                          index: contentBlockIndex,
                          content_block: startPayload,
                        }),
                      ),
                    ),
                  )

                  if (pendingReasoningText) {
                    controller.enqueue(
                      encoder.encode(
                        formatSSE(
                          'content_block_delta',
                          JSON.stringify({
                            type: 'content_block_delta',
                            index: contentBlockIndex,
                            delta: {
                              type: 'thinking_delta',
                              thinking: pendingReasoningText,
                            },
                          }),
                        ),
                      ),
                    )
                  }

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

                pendingReasoningId = null
                pendingReasoningText = ''
              }
            }

            // Response completed — extract usage
            else if (eventType === 'response.completed') {
              const response = event.response as Record<string, unknown>
              const usage = response?.usage as
                | Record<string, number | Record<string, number>>
                | undefined
              if (usage) {
                const totalInput = (usage.input_tokens as number) ?? 0
                const totalOutput = (usage.output_tokens as number) ?? 0

                // Split cached vs marginal input tokens to match Anthropic semantics.
                // Anthropic reports marginal (non-cached) as input_tokens and cached
                // separately as cache_read_input_tokens. Without this split the
                // accumulated total_input_tokens grows quadratically over a conversation.
                const details = usage.input_tokens_details as
                  | Record<string, number>
                  | undefined
                const cached = details?.cached_tokens ?? 0
                cacheReadInputTokens = cached
                inputTokens = totalInput - cached
                outputTokens = totalOutput
              }
            }
          }
        }
      } catch (err) {
        // Emit a proper SSE `event: error` so the SDK's error-handling
        // pipeline (and withRetry) can classify this. Previously this
        // injected `[Error: ...]` text into the assistant bubble, bypassing
        // every downstream error consumer.
        const normalized = codexAdapter.normalizeError(
          { mid_stream: true, cause: err },
          'openai-responses',
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
      if (inToolCall) {
        closeToolCallBlock(
          controller,
          encoder,
          contentBlockIndex,
          currentToolCallId,
          currentToolCallName,
          currentToolCallArgs,
        )
      }

      finishStream(
        controller,
        encoder,
        outputTokens,
        inputTokens,
        cacheReadInputTokens,
        hadToolCalls,
        webSearchCount,
      )
    },
  })

  function closeToolCallBlock(
    controller: ReadableStreamDefaultController,
    encoder: TextEncoder,
    index: number,
    _toolCallId: string,
    _toolCallName: string,
    _toolCallArgs: string,
  ) {
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
  }

  function emitTextBlock(
    controller: ReadableStreamDefaultController,
    encoder: TextEncoder,
    index: number,
    text: string,
  ) {
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
          JSON.stringify({
            type: 'content_block_stop',
            index,
          }),
        ),
      ),
    )
  }

  function finishStream(
    controller: ReadableStreamDefaultController,
    encoder: TextEncoder,
    outputTokens: number,
    inputTokens: number,
    cacheReadInputTokens: number,
    hadToolCalls: boolean,
    webSearchRequests = 0,
  ) {
    // Use 'tool_use' stop reason when model made tool calls
    const stopReason = hadToolCalls ? 'tool_use' : 'end_turn'

    // Codex/Responses API does NOT report cache write cost — prefix caching
    // is automatic. Surface as `null` so NormalizedUsage / StatusLine can
    // differentiate "not tracked" from "0 tokens written".
    const usagePayload: Record<string, unknown> = {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_read_input_tokens: cacheReadInputTokens,
      cache_creation_input_tokens: null,
    }
    if (webSearchRequests > 0) {
      usagePayload.server_tool_use = {
        web_search_requests: webSearchRequests,
      }
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
            'amazon-bedrock-invocationMetrics': {
              inputTokenCount: inputTokens,
              outputTokenCount: outputTokens,
              invocationLatency: 0,
              firstByteLatency: 0,
            },
            usage: usagePayload,
          }),
        ),
      ),
    )
    controller.close()
  }

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

// ── Main fetch interceptor ──────────────────────────────────────────

const DEFAULT_CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex'

type CodexFetchOptions = {
  accessToken: string
  getRefreshedToken?: () => string | null
  baseUrl?: string
  getSessionId: () => string
}

/**
 * Creates a fetch function that intercepts Anthropic API calls and routes them to Codex.
 *
 * URL composition follows the same pattern as other adapters (e.g.
 * openai-chat-completions): `baseUrl` is the root and the adapter appends
 * its canonical path — here, `/responses`. Users configuring a proxy or
 * alternate endpoint set `baseUrl` to everything before `/responses`.
 */
export function createCodexFetch(
  opts: CodexFetchOptions,
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  const isProxied = !!opts.baseUrl
  const codexBaseUrl = `${(opts.baseUrl || DEFAULT_CODEX_BASE_URL).replace(/\/$/, '')}/responses`
  // Account ID only needed for direct ChatGPT backend (proxy handles it)
  const accountId = isProxied ? null : extractAccountId(opts.accessToken)

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

    // Get current token (may have been refreshed via callback)
    const currentToken = opts.getRefreshedToken?.() || opts.accessToken

    // Translate to Codex format
    const { codexBody, codexModel } = translateToCodexBody(
      anthropicBody,
      opts.getSessionId(),
    )

    // Call Codex API
    const sessionId = opts.getSessionId()
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      Authorization: `Bearer ${currentToken}`,
      originator: 'pi',
      'OpenAI-Beta': 'responses=experimental',
      // session_id header helps the backend route requests to the same node
      // for prompt cache reuse (matches official Codex CLI behavior)
      session_id: sessionId,
    }
    if (accountId) {
      headers['chatgpt-account-id'] = accountId
    }
    const codexResponse = await globalThis.fetch(codexBaseUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(codexBody),
    })

    if (!codexResponse.ok) {
      const errorText = await codexResponse.text()
      const normalized = codexAdapter.normalizeError(
        {
          status: codexResponse.status,
          body: errorText,
          headers: codexResponse.headers,
        },
        'openai-responses',
      )
      const errorBody = {
        type: 'error',
        error: {
          type: toAnthropicErrorType(normalized.kind),
          message: `Codex API error (${codexResponse.status}): ${normalized.message}`,
          normalized,
        },
      }
      const outHeaders = new Headers(codexResponse.headers)
      outHeaders.set('Content-Type', 'application/json')
      return new Response(JSON.stringify(errorBody), {
        status: codexResponse.status,
        headers: outHeaders,
      })
    }

    // Translate streaming response
    return translateCodexStreamToAnthropic(codexResponse, codexModel)
  }
}
