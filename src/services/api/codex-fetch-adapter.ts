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
import { logForDebugging } from '../../utils/debug.js'

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
  const registry = getProviderRegistry()
  const structuredOutputs = registry.getModelFlag(model, 'structuredOutputs')
  const supportsWebSearch = registry.getCapability(model, 'webSearch')
  const tools: Array<Record<string, unknown>> = []
  let hasWebSearch = false
  for (const tool of anthropicTools) {
    if (tool.type === 'web_search_20250305') {
      if (supportsWebSearch) {
        tools.push({ type: 'web_search_preview' })
        hasWebSearch = true
      }
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
          block.codexReasoningId.length > 0
        ) {
          // Echo prior-turn Codex reasoning back so the model can build on it.
          // Two backends to satisfy in one shape:
          //   - OpenAI Codex / GPT-5.x: stateful; uses opaque
          //     `encrypted_content` for continuity. Visible `summary[]` may
          //     be empty (high-effort summary-less mode).
          //   - llama.cpp /v1/responses (Qwen3.x with --chat-template-kwargs
          //     preserve_thinking=true): stateless; always returns
          //     encrypted_content:"" on responses, and reads
          //     `content[].text` (type "reasoning_text") into
          //     `message.reasoning_content` on input. `summary[]` is
          //     parsed-and-discarded server-side but its presence is a
          //     type-discriminator on the input parser.
          // Foreign-provenance / imported transcripts have no
          // `codexReasoningId` and are skipped above — reasoning continuity
          // simply restarts at that message.
          const summaryText =
            typeof block.thinking === 'string' ? block.thinking : ''
          const encryptedContent =
            typeof block.codexEncryptedContent === 'string'
              ? block.codexEncryptedContent
              : ''

          // Skip the round-trip only when there's literally nothing to carry.
          if (!summaryText && !encryptedContent) {
            continue
          }

          const reasoningItem: Record<string, unknown> = {
            type: 'reasoning',
            id: block.codexReasoningId,
            encrypted_content: encryptedContent,
            summary: summaryText
              ? [{ type: 'summary_text', text: summaryText }]
              : [],
          }
          // `content[]` is what llama.cpp actually reads; OpenAI tolerates
          // it per the Responses-API input spec. Omit when no visible text
          // exists (real-OpenAI summary-less path) — an empty `content[]`
          // would 400 on llama.cpp's parser.
          if (summaryText) {
            reasoningItem.content = [
              { type: 'reasoning_text', text: summaryText },
            ]
          }

          codexInput.push(reasoningItem)
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

type CodexStreamItem = Record<string, unknown>

type StreamItemState = {
  key: string
  type: string
  order: number
  id?: string
  callId?: string
  name?: string
  item?: CodexStreamItem
  finalItem?: CodexStreamItem
  argumentDeltas: string
  argumentsDone?: string
  textStreamed: string
  reasoningText: string
  rendered: boolean
  serverToolUseIndex?: number
  serverToolUseClosed: boolean
  webSearchResultEmitted: boolean
  webSearchCounted: boolean
}

type OpenCodexBlock =
  | { kind: 'text'; key: string; index: number }
  | { kind: 'thinking'; key: string; index: number }
  | { kind: 'server_tool_use'; key: string; index: number }

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function extractMessageText(item: CodexStreamItem | undefined): string {
  const content = item?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(part => {
      if (!part || typeof part !== 'object') return ''
      const p = part as Record<string, unknown>
      const type = p.type
      if (type === 'output_text' || type === 'text') {
        return typeof p.text === 'string' ? p.text : ''
      }
      return ''
    })
    .join('')
}

function extractReasoningText(item: CodexStreamItem | undefined): string {
  const summary = item?.summary
  if (Array.isArray(summary)) {
    const text = summary
      .map(part => {
        if (!part || typeof part !== 'object') return ''
        const p = part as Record<string, unknown>
        return p.type === 'summary_text' && typeof p.text === 'string'
          ? p.text
          : ''
      })
      .join('')
    if (text) return text
  }

  const content = item?.content
  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (!part || typeof part !== 'object') return ''
        const p = part as Record<string, unknown>
        return p.type === 'reasoning_text' && typeof p.text === 'string'
          ? p.text
          : ''
      })
      .join('')
  }

  return ''
}

function harvestMessageCitations(
  item: CodexStreamItem | undefined,
  pendingCitations: Array<{ url: string; title: string }>,
): void {
  const content = item?.content
  if (!Array.isArray(content)) return
  for (const part of content) {
    if (!part || typeof part !== 'object') continue
    const p = part as Record<string, unknown>
    if (p.type !== 'output_text' || !Array.isArray(p.annotations)) continue
    for (const ann of p.annotations) {
      if (!ann || typeof ann !== 'object') continue
      const a = ann as Record<string, unknown>
      if (a.type === 'url_citation' && typeof a.url === 'string' && a.url) {
        pendingCitations.push({
          url: a.url,
          title: typeof a.title === 'string' && a.title ? a.title : a.url,
        })
      }
    }
  }
}

function extractWebSearchResults(
  item: CodexStreamItem | undefined,
): Array<{ url: string; title: string }> {
  const action = item?.action as
    | { results?: Array<{ url?: string; title?: string }> }
    | undefined
  if (!Array.isArray(action?.results)) return []
  const results: Array<{ url: string; title: string }> = []
  for (const result of action.results) {
    if (typeof result?.url === 'string' && result.url.length > 0) {
      results.push({
        url: result.url,
        title:
          typeof result.title === 'string' && result.title.length > 0
            ? result.title
            : result.url,
      })
    }
  }
  return results
}

/**
 * Translates Codex streaming response to Anthropic format.
 * Converts Codex SSE events into Anthropic-compatible streaming events.
 * @param codexResponse - The streaming response from Codex API
 * @param codexModel - The Codex model used for the request
 * @returns Transformed Response object with Anthropic-format stream
 */
type CodexStreamControl = {
  abortUpstream?: (reason?: unknown) => void
  cleanup?: () => void
}

async function translateCodexStreamToAnthropic(
  codexResponse: Response,
  codexModel: string,
  control: CodexStreamControl = {},
): Promise<Response> {
  const messageId = `msg_codex_${Date.now()}`
  let upstreamReader: ReadableStreamDefaultReader<Uint8Array> | null = null
  let downstreamCancelled = false
  let cleanupCalled = false

  const cleanup = (): void => {
    if (cleanupCalled) return
    cleanupCalled = true
    control.cleanup?.()
  }

  const readable = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder()
      let contentBlockIndex = 0
      let outputTokens = 0
      let inputTokens = 0
      let cacheReadInputTokens = 0
      let hadToolCalls = false
      let webSearchCount = 0
      let streamFinished = false

      const enqueue = (event: string, data: Record<string, unknown>): void => {
        controller.enqueue(
          encoder.encode(formatSSE(event, JSON.stringify(data))),
        )
      }

      enqueue('message_start', {
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
      })
      enqueue('ping', { type: 'ping' })

      const items = new Map<string, StreamItemState>()
      let nextItemOrder = 0
      let nextSyntheticItemId = 0
      let currentMessageKey: string | null = null
      let currentReasoningKey: string | null = null
      let openBlock: OpenCodexBlock | null = null
      const pendingCitations: Array<{ url: string; title: string }> = []

      const getItemKey = (
        event: Record<string, unknown>,
        item: CodexStreamItem | undefined,
        typeHint?: string,
        fallbackKey?: string | null,
      ): { key: string; type: string } => {
        const type = readString(item?.type) ?? typeHint ?? 'unknown'
        const identity =
          readString(item?.id) ??
          readString(item?.call_id) ??
          readString(event.item_id) ??
          readString(event.call_id)
        if (identity) return { key: `${type}:${identity}`, type }
        if (fallbackKey) return { key: fallbackKey, type }
        return { key: `${type}:synthetic_${nextSyntheticItemId++}`, type }
      }

      const upsertItem = (
        event: Record<string, unknown>,
        item: CodexStreamItem | undefined,
        typeHint?: string,
        fallbackKey?: string | null,
      ): StreamItemState => {
        const { key, type } = getItemKey(event, item, typeHint, fallbackKey)
        let state = items.get(key)
        if (!state) {
          state = {
            key,
            type,
            order: nextItemOrder++,
            argumentDeltas: '',
            textStreamed: '',
            reasoningText: '',
            rendered: false,
            serverToolUseClosed: false,
            webSearchResultEmitted: false,
            webSearchCounted: false,
          }
          items.set(key, state)
        }
        state.type = type
        if (item) {
          state.item = item
          const id = readString(item.id)
          const callId = readString(item.call_id)
          const name = readString(item.name)
          if (id) state.id = id
          if (callId) state.callId = callId
          if (name) state.name = name
        }
        return state
      }

      const emitBlockStop = (index: number): void => {
        enqueue('content_block_stop', {
          type: 'content_block_stop',
          index,
        })
      }

      const emitInputJsonDelta = (index: number, partialJson: string): void => {
        if (!partialJson) return
        enqueue('content_block_delta', {
          type: 'content_block_delta',
          index,
          delta: { type: 'input_json_delta', partial_json: partialJson },
        })
      }

      const closeThinkingBlock = (
        state: StreamItemState,
        finalItem?: CodexStreamItem,
      ): void => {
        if (state.rendered) {
          const encrypted = readString(finalItem?.encrypted_content) ?? ''
          if (encrypted) {
            logForDebugging(
              `[codex-adapter] late reasoning encrypted_content after block close key=${state.key}`,
              { level: 'warn' },
            )
          }
          return
        }

        const fallbackText = extractReasoningText(finalItem)
        if (
          !openBlock ||
          openBlock.kind !== 'thinking' ||
          openBlock.key !== state.key
        ) {
          const hasMeaningfulPayload =
            state.id ||
            readString(finalItem?.id) ||
            state.reasoningText ||
            fallbackText ||
            readString(finalItem?.encrypted_content)
          if (!hasMeaningfulPayload) return
          closeOpenBlock()
          const startPayload: Record<string, unknown> = {
            type: 'thinking',
            thinking: '',
            signature: '',
          }
          const reasoningId = readString(finalItem?.id) ?? state.id
          if (reasoningId) startPayload.codexReasoningId = reasoningId
          enqueue('content_block_start', {
            type: 'content_block_start',
            index: contentBlockIndex,
            content_block: startPayload,
          })
          openBlock = {
            kind: 'thinking',
            key: state.key,
            index: contentBlockIndex,
          }
          if (!state.reasoningText && fallbackText) {
            state.reasoningText = fallbackText
            enqueue('content_block_delta', {
              type: 'content_block_delta',
              index: contentBlockIndex,
              delta: { type: 'thinking_delta', thinking: fallbackText },
            })
          }
        } else if (!state.reasoningText && fallbackText) {
          state.reasoningText = fallbackText
          enqueue('content_block_delta', {
            type: 'content_block_delta',
            index: openBlock.index,
            delta: { type: 'thinking_delta', thinking: fallbackText },
          })
        }

        if (openBlock?.kind !== 'thinking' || openBlock.key !== state.key)
          return

        const finalId = readString(finalItem?.id) ?? ''
        const finalEncrypted = readString(finalItem?.encrypted_content) ?? ''
        if (finalId || finalEncrypted) {
          const delta: Record<string, unknown> = {
            type: 'codex_reasoning_meta_delta',
          }
          if (finalId) delta.codexReasoningId = finalId
          if (finalEncrypted) delta.codexEncryptedContent = finalEncrypted
          enqueue('content_block_delta', {
            type: 'content_block_delta',
            index: openBlock.index,
            delta,
          })
        }

        emitBlockStop(openBlock.index)
        contentBlockIndex++
        openBlock = null
        state.rendered = true
      }

      const closeWebSearchServerTool = (state: StreamItemState): void => {
        if (state.serverToolUseClosed) return
        const index = state.serverToolUseIndex
        if (typeof index !== 'number') return
        emitBlockStop(index)
        state.serverToolUseClosed = true
        if (
          openBlock?.kind === 'server_tool_use' &&
          openBlock.key === state.key
        ) {
          openBlock = null
        }
        contentBlockIndex = Math.max(contentBlockIndex, index + 1)
      }

      function closeOpenBlock(): void {
        if (!openBlock) return
        const state = items.get(openBlock.key)
        if (openBlock.kind === 'thinking' && state) {
          closeThinkingBlock(state)
          return
        }
        if (openBlock.kind === 'server_tool_use' && state) {
          closeWebSearchServerTool(state)
          return
        }
        emitBlockStop(openBlock.index)
        contentBlockIndex++
        openBlock = null
      }

      const startThinkingBlock = (state: StreamItemState): void => {
        if (state.rendered) return
        if (openBlock?.kind === 'thinking' && openBlock.key === state.key)
          return
        closeOpenBlock()
        const startPayload: Record<string, unknown> = {
          type: 'thinking',
          thinking: '',
          signature: '',
        }
        if (state.id) startPayload.codexReasoningId = state.id
        enqueue('content_block_start', {
          type: 'content_block_start',
          index: contentBlockIndex,
          content_block: startPayload,
        })
        openBlock = {
          kind: 'thinking',
          key: state.key,
          index: contentBlockIndex,
        }
      }

      const streamThinkingDelta = (
        state: StreamItemState,
        text: string,
      ): void => {
        if (!text || state.rendered) return
        startThinkingBlock(state)
        if (openBlock?.kind !== 'thinking' || openBlock.key !== state.key)
          return
        state.reasoningText += text
        enqueue('content_block_delta', {
          type: 'content_block_delta',
          index: openBlock.index,
          delta: { type: 'thinking_delta', thinking: text },
        })
      }

      const streamTextDelta = (state: StreamItemState, text: string): void => {
        if (!text) return
        if (openBlock?.kind !== 'text' || openBlock.key !== state.key) {
          closeOpenBlock()
          enqueue('content_block_start', {
            type: 'content_block_start',
            index: contentBlockIndex,
            content_block: { type: 'text', text: '' },
          })
          openBlock = { kind: 'text', key: state.key, index: contentBlockIndex }
        }
        state.textStreamed += text
        enqueue('content_block_delta', {
          type: 'content_block_delta',
          index: openBlock.index,
          delta: { type: 'text_delta', text },
        })
        outputTokens += 1
      }

      const renderMessageDone = (
        state: StreamItemState,
        finalItem?: CodexStreamItem,
      ): void => {
        if (state.rendered) return
        const finalText = extractMessageText(finalItem)
        if (!state.textStreamed && finalText) {
          streamTextDelta(state, finalText)
        } else if (
          finalText &&
          finalText.length > state.textStreamed.length &&
          finalText.startsWith(state.textStreamed)
        ) {
          streamTextDelta(state, finalText.slice(state.textStreamed.length))
        }
        harvestMessageCitations(finalItem, pendingCitations)
        if (openBlock?.kind === 'text' && openBlock.key === state.key) {
          closeOpenBlock()
        }
        state.rendered = true
      }

      const getFunctionArguments = (state: StreamItemState): string => {
        const finalArgs = readString(state.finalItem?.arguments)
        const initialArgs = readString(state.item?.arguments)
        return (
          finalArgs ||
          state.argumentsDone ||
          state.argumentDeltas ||
          initialArgs ||
          ''
        )
      }

      const renderFunctionTool = (state: StreamItemState): void => {
        if (state.rendered) return
        closeOpenBlock()
        const id = state.callId || state.id || state.key
        const name = readString(state.finalItem?.name) ?? state.name ?? ''
        enqueue('content_block_start', {
          type: 'content_block_start',
          index: contentBlockIndex,
          content_block: {
            type: 'tool_use',
            id,
            name,
            input: {},
          },
        })
        emitInputJsonDelta(contentBlockIndex, getFunctionArguments(state))
        emitBlockStop(contentBlockIndex)
        contentBlockIndex++
        hadToolCalls = true
        state.rendered = true
      }

      const renderWebSearchStart = (state: StreamItemState): void => {
        if (typeof state.serverToolUseIndex === 'number') return
        closeOpenBlock()
        const callId = state.id || state.key
        const action = state.item?.action as { query?: string } | undefined
        const query = typeof action?.query === 'string' ? action.query : ''
        enqueue('content_block_start', {
          type: 'content_block_start',
          index: contentBlockIndex,
          content_block: {
            type: 'server_tool_use',
            id: callId,
            name: 'web_search',
            input: {},
          },
        })
        emitInputJsonDelta(contentBlockIndex, JSON.stringify({ query }))
        state.serverToolUseIndex = contentBlockIndex
        openBlock = {
          kind: 'server_tool_use',
          key: state.key,
          index: contentBlockIndex,
        }
        if (!state.webSearchCounted) {
          webSearchCount++
          state.webSearchCounted = true
        }
        hadToolCalls = true
      }

      const renderWebSearchDone = (
        state: StreamItemState,
        finalItem?: CodexStreamItem,
      ): void => {
        if (state.webSearchResultEmitted) return
        if (typeof state.serverToolUseIndex !== 'number') {
          renderWebSearchStart(state)
        }
        closeWebSearchServerTool(state)
        let results = extractWebSearchResults(finalItem)
        if (results.length === 0 && pendingCitations.length > 0) {
          results = pendingCitations.splice(0)
        }
        enqueue('content_block_start', {
          type: 'content_block_start',
          index: contentBlockIndex,
          content_block: {
            type: 'web_search_tool_result',
            tool_use_id: state.id || state.key,
            content: results.map(result => ({
              type: 'web_search_result',
              url: result.url,
              title: result.title,
            })),
          },
        })
        emitBlockStop(contentBlockIndex)
        contentBlockIndex++
        state.webSearchResultEmitted = true
        state.rendered = true
        hadToolCalls = true
      }

      const handleItemDone = (
        state: StreamItemState,
        finalItem?: CodexStreamItem,
      ): void => {
        if (finalItem) state.finalItem = finalItem
        if (state.type === 'function_call') {
          renderFunctionTool(state)
        } else if (state.type === 'message') {
          renderMessageDone(state, finalItem)
        } else if (state.type === 'web_search_call') {
          renderWebSearchDone(state, finalItem)
        } else if (state.type === 'reasoning') {
          closeThinkingBlock(state, finalItem)
        }
      }

      const synthesizeUnrenderedOutputItems = (
        response: Record<string, unknown>,
      ): void => {
        const output = response.output
        if (!Array.isArray(output)) return
        for (const item of output) {
          if (!item || typeof item !== 'object') continue
          const finalItem = item as CodexStreamItem
          const state = upsertItem({}, finalItem)
          if (!state.rendered) handleItemDone(state, finalItem)
        }
      }

      const finishStream = (): void => {
        if (streamFinished) return
        closeOpenBlock()
        const stopReason = hadToolCalls ? 'tool_use' : 'end_turn'
        const usagePayload: Record<string, unknown> = {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          cache_read_input_tokens: cacheReadInputTokens,
          cache_creation_input_tokens: null,
        }
        if (webSearchCount > 0) {
          usagePayload.server_tool_use = {
            web_search_requests: webSearchCount,
          }
        }
        enqueue('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: stopReason, stop_sequence: null },
          usage: usagePayload,
        })
        enqueue('message_stop', {
          type: 'message_stop',
          'amazon-bedrock-invocationMetrics': {
            inputTokenCount: inputTokens,
            outputTokenCount: outputTokens,
            invocationLatency: 0,
            firstByteLatency: 0,
          },
          usage: usagePayload,
        })
        streamFinished = true
        cleanup()
        controller.close()
      }

      const emitErrorAndClose = (
        message: string,
        raw: unknown,
        level: 'warn' | 'error' = 'error',
      ): void => {
        if (streamFinished) return
        closeOpenBlock()
        logForDebugging(`[codex-adapter] ${message}`, { level })
        const normalized = codexAdapter.normalizeError(
          typeof raw === 'object' && raw !== null
            ? { ...(raw as Record<string, unknown>), mid_stream: true }
            : { mid_stream: true, cause: raw },
          'openai-responses',
        )
        enqueue('error', {
          type: 'error',
          error: {
            type: toAnthropicErrorType(normalized.kind),
            message: normalized.message || message,
            normalized,
          },
        })
        streamFinished = true
        cleanup()
        controller.close()
      }

      let firstSseLogged = false
      let chunkCount = 0
      const eventTypeCounts: Record<string, number> = {}
      let sawResponseCompleted = false
      let sawResponseFailed = false
      const streamStart = Date.now()

      try {
        const reader = codexResponse.body?.getReader()
        upstreamReader = reader ?? null
        if (!reader) {
          streamTextDelta(
            upsertItem({}, { type: 'message' }, 'message'),
            'Error: No response body',
          )
          finishStream()
          return
        }

        const decoder = new TextDecoder()
        let buffer = ''
        let sseEventName = ''

        while (true) {
          const { done, value } = await reader.read()
          if (done) {
            buffer += decoder.decode()
            if (buffer.trim()) buffer += '\n'
          } else {
            buffer += decoder.decode(value, { stream: true })
          }
          const lines = buffer.split('\n')
          buffer = lines.pop() || ''

          for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed) continue
            if (trimmed.startsWith('event: ')) {
              sseEventName = trimmed.slice(7).trim()
              continue
            }
            if (!trimmed.startsWith('data: ')) continue
            const dataStr = trimmed.slice(6)
            const framedEventName = sseEventName
            sseEventName = ''
            if (dataStr === '[DONE]') {
              if (!firstSseLogged) {
                logForDebugging(
                  `[codex-adapter] first SSE was [DONE] (empty stream) model=${codexModel}`,
                  { level: 'warn' },
                )
                firstSseLogged = true
              }
              sawResponseCompleted = true
              logForDebugging(
                `[codex-adapter] stream end via [DONE] model=${codexModel} duration_ms=${Date.now() - streamStart} chunks=${chunkCount} content_blocks=${contentBlockIndex} input=${inputTokens} output=${outputTokens} cacheRead=${cacheReadInputTokens} hadToolCalls=${hadToolCalls} webSearch=${webSearchCount} response.completed=${sawResponseCompleted} response.failed=${sawResponseFailed} eventTypes=${JSON.stringify(eventTypeCounts)}`,
              )
              finishStream()
              return
            }

            let event: Record<string, unknown>
            try {
              event = JSON.parse(dataStr)
            } catch (e) {
              logForDebugging(
                `[codex-adapter] SSE JSON parse failed: ${(e as Error)?.message ?? String(e)} :: ${dataStr.slice(0, 200)}`,
                { level: 'warn' },
              )
              continue
            }

            chunkCount++
            if (!firstSseLogged) {
              logForDebugging(
                `[codex-adapter] first SSE chunk model=${codexModel}: ${dataStr.slice(0, 500)}`,
              )
              firstSseLogged = true
            }

            const responseStatus = readString(
              (event.response as Record<string, unknown> | undefined)?.status,
            )
            const eventType =
              readString(event.type) ||
              framedEventName ||
              (responseStatus === 'completed' ? 'response.completed' : '')
            if (eventType) {
              eventTypeCounts[eventType] = (eventTypeCounts[eventType] ?? 0) + 1
            }

            if (
              eventType === 'response.failed' ||
              eventType === 'error' ||
              eventType.endsWith('.failed')
            ) {
              sawResponseFailed = true
              const errPayload =
                (event.error as Record<string, unknown> | undefined) ??
                ((event.response as Record<string, unknown> | undefined)
                  ?.error as Record<string, unknown> | undefined)
              const fallbackMessage =
                readString(errPayload?.message) ?? `Codex ${eventType}`
              emitErrorAndClose(fallbackMessage, {
                body: errPayload
                  ? JSON.stringify({ error: errPayload })
                  : dataStr,
              })
              return
            }

            if (eventType === 'response.output_item.added') {
              const item = event.item as CodexStreamItem | undefined
              const state = upsertItem(event, item)
              if (state.type === 'reasoning') {
                currentReasoningKey = state.key
                startThinkingBlock(state)
              } else if (state.type === 'message') {
                currentMessageKey = state.key
                if (openBlock) closeOpenBlock()
              } else if (state.type === 'function_call') {
                if (openBlock) closeOpenBlock()
              } else if (state.type === 'web_search_call') {
                renderWebSearchStart(state)
              }
            } else if (eventType === 'response.output_text.delta') {
              const state = upsertItem(
                event,
                undefined,
                'message',
                currentMessageKey,
              )
              currentMessageKey = state.key
              const text = readString(event.delta)
              if (text) streamTextDelta(state, text)
            } else if (
              eventType === 'response.reasoning_text.delta' ||
              eventType === 'response.reasoning_summary_text.delta' ||
              eventType === 'response.reasoning.delta'
            ) {
              const state = upsertItem(
                event,
                undefined,
                'reasoning',
                currentReasoningKey,
              )
              currentReasoningKey = state.key
              const text = readString(event.delta)
              if (text) streamThinkingDelta(state, text)
            } else if (
              eventType === 'response.reasoning_text.done' ||
              eventType === 'response.reasoning_summary_text.done' ||
              eventType === 'response.reasoning.done'
            ) {
              const state = upsertItem(
                event,
                undefined,
                'reasoning',
                currentReasoningKey,
              )
              currentReasoningKey = state.key
              const finalText = readString(event.text)
              if (
                finalText &&
                finalText.length > state.reasoningText.length &&
                finalText.startsWith(state.reasoningText)
              ) {
                streamThinkingDelta(
                  state,
                  finalText.slice(state.reasoningText.length),
                )
              } else if (finalText && state.reasoningText.length === 0) {
                streamThinkingDelta(state, finalText)
              }
            } else if (eventType === 'response.function_call_arguments.delta') {
              const state = upsertItem(event, undefined, 'function_call')
              const delta = readString(event.delta)
              if (delta) state.argumentDeltas += delta
            } else if (eventType === 'response.function_call_arguments.done') {
              const state = upsertItem(event, undefined, 'function_call')
              const args = readString(event.arguments)
              if (args !== undefined) state.argumentsDone = args
            } else if (
              eventType === 'response.web_search_call.in_progress' ||
              eventType === 'response.web_search_call.searching'
            ) {
              // no-op; server_tool_use start carries the query for progress UI.
            } else if (eventType === 'response.web_search_call.completed') {
              const state = upsertItem(event, undefined, 'web_search_call')
              closeWebSearchServerTool(state)
            } else if (eventType === 'response.output_item.done') {
              const item = event.item as CodexStreamItem | undefined
              const type = readString(item?.type)
              const fallbackKey = type === 'message' ? currentMessageKey : null
              const state = upsertItem(event, item, type, fallbackKey)
              handleItemDone(state, item)
            } else if (eventType === 'response.completed') {
              sawResponseCompleted = true
              const response = event.response as Record<string, unknown>
              const usage = response?.usage as
                | Record<string, number | Record<string, number>>
                | undefined
              if (usage) {
                const totalInput = (usage.input_tokens as number) ?? 0
                const totalOutput = (usage.output_tokens as number) ?? 0
                const details = usage.input_tokens_details as
                  | Record<string, number>
                  | undefined
                const cached = details?.cached_tokens ?? 0
                cacheReadInputTokens = cached
                inputTokens = totalInput - cached
                outputTokens = totalOutput
              }
              synthesizeUnrenderedOutputItems(response ?? {})
              for (const state of [...items.values()].sort(
                (a, b) => a.order - b.order,
              )) {
                if (
                  !state.rendered &&
                  (state.type === 'function_call' ||
                    state.type === 'web_search_call')
                ) {
                  logForDebugging(
                    `[codex-adapter] synthesizing ${state.type} without output_item.done key=${state.key}`,
                    { level: 'warn' },
                  )
                  handleItemDone(state, state.finalItem)
                }
              }
              logForDebugging(
                `[codex-adapter] stream end model=${codexModel} duration_ms=${Date.now() - streamStart} chunks=${chunkCount} content_blocks=${contentBlockIndex} input=${inputTokens} output=${outputTokens} cacheRead=${cacheReadInputTokens} hadToolCalls=${hadToolCalls} webSearch=${webSearchCount} response.completed=${sawResponseCompleted} response.failed=${sawResponseFailed} eventTypes=${JSON.stringify(eventTypeCounts)}`,
              )
              finishStream()
              return
            }
          }
          if (done) break
        }
      } catch (err) {
        if (downstreamCancelled) {
          cleanup()
          return
        }
        logForDebugging(
          `[codex-adapter] stream loop threw: ${(err as Error)?.message ?? String(err)} stack=${(err as Error)?.stack?.split('\n').slice(0, 3).join(' | ') ?? 'none'}`,
          { level: 'error' },
        )
        emitErrorAndClose(
          (err as Error)?.message ?? 'Codex stream loop failed',
          { cause: err },
        )
        return
      }

      if (downstreamCancelled) {
        cleanup()
        return
      }

      if (!sawResponseCompleted && !streamFinished) {
        emitErrorAndClose('Codex stream ended before response.completed', {
          cause: new Error('Codex stream ended before response.completed'),
          stream_truncated: true,
        })
      }
    },
    cancel(reason) {
      downstreamCancelled = true
      control.abortUpstream?.(reason)
      void upstreamReader?.cancel(reason).catch(() => {})
      cleanup()
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
    const reqBodyStr = JSON.stringify(codexBody)
    const reqInputCount = Array.isArray(
      (codexBody as { input?: unknown[] }).input,
    )
      ? ((codexBody as { input: unknown[] }).input.length as number)
      : 0
    const reqToolCount = Array.isArray(
      (codexBody as { tools?: unknown[] }).tools,
    )
      ? ((codexBody as { tools: unknown[] }).tools.length as number)
      : 0
    const reqReasoning =
      (codexBody as { reasoning?: { effort?: string } }).reasoning?.effort ??
      'none'
    logForDebugging(
      `[codex-adapter] POST ${codexBaseUrl} model=${codexModel} input_items=${reqInputCount} tools=${reqToolCount} reasoning=${reqReasoning} body_bytes=${reqBodyStr.length}`,
    )

    const upstreamController = new AbortController()
    const callerSignal =
      init?.signal ?? (input instanceof Request ? input.signal : undefined)
    let cleanupCallerAbort = (): void => {}
    if (callerSignal) {
      const abortUpstream = (): void => {
        upstreamController.abort(callerSignal.reason)
      }
      if (callerSignal.aborted) {
        upstreamController.abort(callerSignal.reason)
      } else {
        callerSignal.addEventListener('abort', abortUpstream, { once: true })
        cleanupCallerAbort = () => {
          callerSignal.removeEventListener('abort', abortUpstream)
        }
      }
    }

    const fetchStart = Date.now()
    let codexResponse: Response
    try {
      codexResponse = await globalThis.fetch(codexBaseUrl, {
        method: 'POST',
        headers,
        body: reqBodyStr,
        signal: upstreamController.signal,
      })
    } catch (err) {
      cleanupCallerAbort()
      throw err
    }

    logForDebugging(
      `[codex-adapter] response status=${codexResponse.status} content-type=${codexResponse.headers.get('content-type') ?? ''} ttfb_ms=${Date.now() - fetchStart}`,
    )

    if (!codexResponse.ok) {
      let errorText = ''
      try {
        errorText = await codexResponse.text()
      } finally {
        cleanupCallerAbort()
      }
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
    try {
      return await translateCodexStreamToAnthropic(codexResponse, codexModel, {
        abortUpstream: reason => upstreamController.abort(reason),
        cleanup: cleanupCallerAbort,
      })
    } catch (err) {
      cleanupCallerAbort()
      throw err
    }
  }
}
