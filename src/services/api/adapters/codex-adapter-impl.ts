/**
 * Codex (OpenAI Responses API) adapter.
 *
 * Implements native domain transport: converts DomainMessageRequest → OpenAI
 * Responses API JSON, makes the HTTP request directly, parses OpenAI Responses
 * SSE events, and yields DomainStreamEvents — no Anthropic SDK intermediary.
 *
 * Same tokenizer path as OpenAI Chat Completions — Codex uses the o-series
 * encoding (`o200k_base`). `gpt-tokenizer` is dynamic-imported so bundles
 * without a Codex provider don't pay the cost.
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
import { getProviderRegistry } from '../../../utils/model/providerRegistry.js'
import { getCodexOAuthTokens } from '../../../utils/auth.js'
import { getSessionId } from '../../../bootstrap/state.js'
import { logForDebugging } from '../../../utils/debug.js'
import { isEnvDefinedFalsy } from '../../../utils/envUtils.js'
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

// ── Tokenizer ──────────────────────────────────────────────────────

type GptTokenizerModule = {
  encode: (text: string) => number[]
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
      if (block.type === 'text')
        parts.push(String(block.text ?? ''))
      else if (block.type === 'tool_use')
        parts.push(
          `${String(block.name ?? '')}(${JSON.stringify(block.input ?? {})})`,
        )
      else if (block.type === 'tool_result') {
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

// ── Constants ──────────────────────────────────────────────────────

const DEFAULT_CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex'
const CODEX_STREAM_FIRST_CHUNK_TIMEOUT_MS = 300_000
const CODEX_STREAM_BETWEEN_CHUNKS_TIMEOUT_MS = 30_000
const CODEX_UPSTREAM_IDLE_TIMEOUT_ERROR =
  'Codex stream idle timeout waiting for upstream SSE'

function getCodexStreamFirstChunkTimeoutMs(): number | null {
  if (isEnvDefinedFalsy(process.env.CLAUDE_ENABLE_STREAM_WATCHDOG)) {
    return null
  }
  return (
    parseInt(process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS || '', 10) ||
    CODEX_STREAM_FIRST_CHUNK_TIMEOUT_MS
  )
}

function getCodexStreamBetweenChunksTimeoutMs(): number | null {
  if (isEnvDefinedFalsy(process.env.CLAUDE_ENABLE_STREAM_WATCHDOG)) {
    return null
  }
  return (
    parseInt(process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS || '', 10) ||
    CODEX_STREAM_BETWEEN_CHUNKS_TIMEOUT_MS
  )
}

// ── JWT helpers ────────────────────────────────────────────────────

const JWT_CLAIM_PATH = 'https://api.openai.com/auth'

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

// ── Auth resolution ────────────────────────────────────────────────

function resolveCodexAuth(config: ProviderConfig): {
  accessToken: string
  getRefreshedToken: () => string
  baseUrl: string
  isProxied: boolean
} | null {
  const codexTokens = getCodexOAuthTokens()
  const oauthToken = codexTokens?.accessToken

  if (oauthToken) {
    return {
      accessToken: oauthToken,
      getRefreshedToken: () => getCodexOAuthTokens()?.accessToken ?? oauthToken,
      baseUrl: config.baseUrl || DEFAULT_CODEX_BASE_URL,
      isProxied: !!config.baseUrl,
    }
  }

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

  if (!token) return null

  return {
    accessToken: token,
    getRefreshedToken: () => token!,
    baseUrl: config.baseUrl || DEFAULT_CODEX_BASE_URL,
    isProxied: !!config.baseUrl,
  }
}

// ── Domain → Codex request translation ─────────────────────────────

function domainToolsToCodex(
  tools: DomainToolDefinition[],
  model: string,
): { tools: Array<Record<string, unknown>>; hasWebSearch: boolean } {
  const registry = getProviderRegistry()
  const supportsWebSearch = registry.getCapability(model, 'webSearch')
  const result: Array<Record<string, unknown>> = []
  let hasWebSearch = false

  for (const tool of tools) {
    if (tool.type === 'web_search_20250305') {
      if (supportsWebSearch) {
        result.push({ type: 'web_search_preview' })
        hasWebSearch = true
      }
      continue
    }
    if (tool.type && tool.type !== 'function') continue

    result.push({
      type: 'function',
      name: tool.name,
      description: tool.description || '',
      parameters: tool.input_schema || { type: 'object', properties: {} },
    })
  }

  return { tools: result, hasWebSearch }
}

function domainToolChoiceToCodex(
  toolChoice: DomainMessageRequest['toolChoice'],
  hasWebSearch: boolean,
): Record<string, unknown> | string {
  if (!toolChoice) return 'auto'
  if (toolChoice.type === 'tool' && toolChoice.name === 'web_search') {
    if (hasWebSearch) return { type: 'web_search_preview' }
    return 'auto'
  }
  if (toolChoice.type === 'any') return 'required'
  return 'auto'
}

function domainMessagesToCodexInput(
  messages: DomainMessageParam[],
): Array<Record<string, unknown>> {
  const codexInput: Array<Record<string, unknown>> = []
  let toolCallCounter = 0

  for (const msg of messages) {
    if (msg.role === 'user') {
      const contentArr: Array<Record<string, unknown>> = []
      for (const block of msg.content) {
        if ((block as { type: string }).type === 'web_search_tool_result') {
          continue
        }
        if (block.type === 'tool_result') {
          const tr = block as unknown as {
            tool_use_id: string
            content?: string | Array<{ type: string; text?: string }>
          }
          const callId = tr.tool_use_id || `call_${toolCallCounter++}`
          let outputText = ''
          if (typeof tr.content === 'string') {
            outputText = tr.content
          } else if (Array.isArray(tr.content)) {
            outputText = tr.content
              .map(c => {
                if (c.type === 'text') return c.text ?? ''
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
        } else if (block.type === 'text') {
          contentArr.push({
            type: 'input_text',
            text: (block as { text: string }).text,
          })
        } else if (block.type === 'image') {
          const src = (block as unknown as {
            source: { type: string; media_type: string; data: string }
          }).source
          if (src?.type === 'base64') {
            contentArr.push({
              type: 'input_image',
              image_url: `data:${src.media_type};base64,${src.data}`,
            })
          }
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
      for (const block of msg.content) {
        if (block.type === 'server_tool_use') {
          continue
        }
        if (block.type === 'text') {
          codexInput.push({
            type: 'message',
            role: 'assistant',
            content: [
              {
                type: 'output_text',
                text: (block as { text: string }).text,
                annotations: [],
              },
            ],
            status: 'completed',
          })
        } else if (block.type === 'tool_use') {
          const tb = block as { id: string; name: string; input: unknown }
          const callId = tb.id || `call_${toolCallCounter++}`
          codexInput.push({
            type: 'function_call',
            call_id: callId,
            name: tb.name || '',
            arguments: JSON.stringify(tb.input || {}),
          })
        } else if (block.type === 'reasoning') {
          const rb = block as {
            text: string
            providerState?: {
              openaiResponses?: {
                reasoningId?: string
                encryptedContent?: string
              }
            }
          }
          const oaiState = rb.providerState?.openaiResponses
          const reasoningId = oaiState?.reasoningId ?? ''
          if (!reasoningId) continue

          const summaryText = typeof rb.text === 'string' ? rb.text : ''
          const encryptedContent =
            typeof oaiState?.encryptedContent === 'string'
              ? oaiState.encryptedContent
              : ''

          if (!summaryText && !encryptedContent) continue

          const reasoningItem: Record<string, unknown> = {
            type: 'reasoning',
            id: reasoningId,
            encrypted_content: encryptedContent,
            summary: summaryText
              ? [{ type: 'summary_text', text: summaryText }]
              : [],
          }
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

function domainRequestToCodexBody(
  request: DomainMessageRequest,
  sessionId: string,
): Record<string, unknown> {
  let instructions = ''
  if (request.system && request.system.length > 0) {
    instructions = request.system
      .filter(b => b.type === 'text' && typeof b.text === 'string')
      .map(b => b.text)
      .join('\n')
  }

  const input = domainMessagesToCodexInput(request.messages)

  const codexBody: Record<string, unknown> = {
    model: request.model,
    store: false,
    stream: true,
    instructions,
    input,
    tool_choice: 'auto',
    parallel_tool_calls: true,
    prompt_cache_key: sessionId,
    include: ['reasoning.encrypted_content'],
  }

  let hasWebSearch = false
  if (request.tools && request.tools.length > 0) {
    const translated = domainToolsToCodex(request.tools, request.model)
    codexBody.tools = translated.tools
    hasWebSearch = translated.hasWebSearch
  }

  codexBody.tool_choice = domainToolChoiceToCodex(
    request.toolChoice,
    hasWebSearch,
  )

  const outputConfig = request.outputConfig as { effort?: string } | undefined
  if (outputConfig?.effort) {
    codexBody.reasoning = { effort: outputConfig.effort }
  }

  return codexBody
}

// ── Codex SSE helpers ──────────────────────────────────────────────

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

// ── Codex SSE → DomainStreamEvent ──────────────────────────────────

async function* parseCodexStream(
  codexResponse: Response,
  modelId: string,
  providerType: ProviderType,
  normalizeError: (raw: unknown, pt: ProviderType) => NormalizedApiError,
): AsyncGenerator<DomainStreamEvent> {
  const messageId = `msg_codex_${Date.now()}`

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
  let hadToolCalls = false
  let webSearchCount = 0

  const items = new Map<string, StreamItemState>()
  let nextItemOrder = 0
  let currentMessageKey: string | null = null
  let currentReasoningKey: string | null = null
  const pendingCitations: Array<{ url: string; title: string }> = []

  type OpenBlock =
    | { kind: 'text'; key: string; index: number }
    | { kind: 'thinking'; key: string; index: number }
    | { kind: 'server_tool_use'; key: string; index: number }
  let openBlock: OpenBlock | null = null

  const yieldQueue: DomainStreamEvent[] = []
  const enqueue = (event: DomainStreamEvent): void => {
    yieldQueue.push(event)
  }

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
    return { key: `${type}:unknown`, type }
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
    enqueue({ type: 'content_block_stop', index })
  }

  const closeWebSearchServerTool = (state: StreamItemState): void => {
    if (state.serverToolUseClosed) return
    const index = state.serverToolUseIndex
    if (typeof index !== 'number') return
    emitBlockStop(index)
    state.serverToolUseClosed = true
    if (openBlock?.kind === 'server_tool_use' && openBlock.key === state.key) {
      openBlock = null
    }
    contentBlockIndex = Math.max(contentBlockIndex, index + 1)
  }

  const closeThinkingBlock = (
    state: StreamItemState,
    finalItem?: CodexStreamItem,
  ): void => {
    if (state.rendered) return

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
      enqueue({
        type: 'content_block_start',
        index: contentBlockIndex,
        content_block: { type: 'reasoning', text: '' },
      })
      openBlock = {
        kind: 'thinking',
        key: state.key,
        index: contentBlockIndex,
      }
      if (!state.reasoningText && fallbackText) {
        state.reasoningText = fallbackText
        enqueue({
          type: 'content_block_delta',
          index: contentBlockIndex,
          delta: { type: 'thinking_delta', thinking: fallbackText },
        })
      }
    } else if (!state.reasoningText && fallbackText) {
      state.reasoningText = fallbackText
      enqueue({
        type: 'content_block_delta',
        index: openBlock.index,
        delta: { type: 'thinking_delta', thinking: fallbackText },
      })
    }

    if (openBlock?.kind !== 'thinking' || openBlock.key !== state.key) return

    const finalId = readString(finalItem?.id) ?? ''
    const finalEncrypted = readString(finalItem?.encrypted_content) ?? ''
    if (finalId || finalEncrypted) {
      enqueue({
        type: 'content_block_delta',
        index: openBlock.index,
        delta: {
          type: 'codex_reasoning_meta_delta',
          codexReasoningId: finalId || undefined,
          codexEncryptedContent: finalEncrypted || undefined,
        } as { type: string; [key: string]: unknown },
      })
    }

    emitBlockStop(openBlock.index)
    contentBlockIndex++
    openBlock = null
    state.rendered = true
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
    if (openBlock?.kind === 'thinking' && openBlock.key === state.key) return
    closeOpenBlock()
    enqueue({
      type: 'content_block_start',
      index: contentBlockIndex,
      content_block: { type: 'reasoning', text: '' },
    })
    openBlock = { kind: 'thinking', key: state.key, index: contentBlockIndex }
  }

  const streamThinkingDelta = (state: StreamItemState, text: string): void => {
    if (!text || state.rendered) return
    startThinkingBlock(state)
    if (openBlock?.kind !== 'thinking' || openBlock.key !== state.key) return
    state.reasoningText += text
    enqueue({
      type: 'content_block_delta',
      index: openBlock.index,
      delta: { type: 'thinking_delta', thinking: text },
    })
  }

  const streamTextDelta = (state: StreamItemState, text: string): void => {
    if (!text) return
    if (openBlock?.kind !== 'text' || openBlock.key !== state.key) {
      closeOpenBlock()
      enqueue({
        type: 'content_block_start',
        index: contentBlockIndex,
        content_block: { type: 'text', text: '' },
      })
      openBlock = { kind: 'text', key: state.key, index: contentBlockIndex }
    }
    state.textStreamed += text
    enqueue({
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

  const renderFunctionTool = (state: StreamItemState): void => {
    if (state.rendered) return
    closeOpenBlock()
    const id = state.callId || state.id || state.key
    const name = readString(state.finalItem?.name) ?? state.name ?? ''
    enqueue({
      type: 'content_block_start',
      index: contentBlockIndex,
      content_block: { type: 'tool_use', id, name, input: {} },
    })
    const args = state.argumentsDone || state.argumentDeltas || ''
    if (args) {
      enqueue({
        type: 'content_block_delta',
        index: contentBlockIndex,
        delta: { type: 'input_json_delta', partial_json: args },
      })
    }
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
    enqueue({
      type: 'content_block_start',
      index: contentBlockIndex,
      content_block: {
        type: 'server_tool_use',
        id: callId,
        name: 'web_search',
        input: {},
      },
    })
    if (query) {
      enqueue({
        type: 'content_block_delta',
        index: contentBlockIndex,
        delta: {
          type: 'input_json_delta',
          partial_json: JSON.stringify({ query }),
        },
      })
    }
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
    enqueue({
      type: 'content_block_start',
      index: contentBlockIndex,
      content_block: {
        type: 'web_search_tool_result',
        tool_use_id: state.id || state.key,
        content: results.map(r => ({
          type: 'web_search_result',
          url: r.url,
          title: r.title,
        })),
      } as { type: string; [key: string]: unknown },
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

  const reader = codexResponse.body?.getReader()
  if (!reader) {
    throw new DomainConnectionError({
      normalized: {
        kind: 'transport',
        message: 'No response body from Codex',
        providerType,
        raw: null,
      },
      cause: new Error('No response body'),
    })
  }

  const decoder = new TextDecoder()
  let buffer = ''
  let sseEventName = ''
  let hasReceivedUpstreamChunk = false
  let sawResponseCompleted = false
  const firstChunkTimeoutMs = getCodexStreamFirstChunkTimeoutMs()
  const betweenChunksTimeoutMs = getCodexStreamBetweenChunksTimeoutMs()
  const streamStart = Date.now()

  type UpstreamReadResult = Awaited<ReturnType<typeof reader.read>>
  const readUpstream = async (): Promise<UpstreamReadResult> => {
    const streamIdleTimeoutMs = hasReceivedUpstreamChunk
      ? betweenChunksTimeoutMs
      : firstChunkTimeoutMs
    if (streamIdleTimeoutMs === null) return reader.read()
    let timeoutId: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        reader.read(),
        new Promise<UpstreamReadResult>((_resolve, reject) => {
          timeoutId = setTimeout(() => {
            const error = new Error(CODEX_UPSTREAM_IDLE_TIMEOUT_ERROR)
            void reader.cancel(error).catch(() => {})
            reject(error)
          }, streamIdleTimeoutMs)
        }),
      ])
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId)
    }
  }

  try {
    while (true) {
      const { done, value } = await readUpstream()
      if (!done) hasReceivedUpstreamChunk = true
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
        if (dataStr === '[DONE]') continue

        let event: Record<string, unknown>
        try {
          event = JSON.parse(dataStr)
        } catch {
          continue
        }

        const responseStatus = readString(
          (event.response as Record<string, unknown> | undefined)?.status,
        )
        const eventType =
          readString(event.type) ||
          framedEventName ||
          (responseStatus === 'completed' ? 'response.completed' : '')

        if (
          eventType === 'response.failed' ||
          eventType === 'error' ||
          eventType.endsWith('.failed')
        ) {
          const errPayload =
            (event.error as Record<string, unknown> | undefined) ??
            ((event.response as Record<string, unknown> | undefined)
              ?.error as Record<string, unknown> | undefined)
          const fallbackMessage =
            readString(errPayload?.message) ?? `Codex ${eventType}`
          closeOpenBlock()
          const normalized = normalizeError(
            {
              body: errPayload
                ? JSON.stringify({ error: errPayload })
                : dataStr,
              mid_stream: true,
            },
            providerType,
          )
          throw new DomainTransportError({ normalized, raw: errPayload ?? dataStr })
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
          const state = upsertItem(event, undefined, 'message', currentMessageKey)
          currentMessageKey = state.key
          const text = readString(event.delta)
          if (text) streamTextDelta(state, text)
        } else if (
          eventType === 'response.reasoning_text.delta' ||
          eventType === 'response.reasoning_summary_text.delta'
        ) {
          const state = upsertItem(event, undefined, 'reasoning', currentReasoningKey)
          currentReasoningKey = state.key
          const text = readString(event.delta)
          if (text) streamThinkingDelta(state, text)
        } else if (
          eventType === 'response.reasoning_text.done' ||
          eventType === 'response.reasoning_summary_text.done'
        ) {
          const state = upsertItem(event, undefined, 'reasoning', currentReasoningKey)
          currentReasoningKey = state.key
          const finalText = readString(event.text)
          if (
            finalText &&
            finalText.length > state.reasoningText.length &&
            finalText.startsWith(state.reasoningText)
          ) {
            streamThinkingDelta(state, finalText.slice(state.reasoningText.length))
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
          logForDebugging(
            `[codex-adapter] stream end model=${modelId} duration_ms=${Date.now() - streamStart} content_blocks=${contentBlockIndex} input=${inputTokens} output=${outputTokens} cacheRead=${cacheReadInputTokens} hadToolCalls=${hadToolCalls} webSearch=${webSearchCount}`,
          )
        }
      }

      // Flush all queued events
      while (yieldQueue.length > 0) {
        yield yieldQueue.shift()!
      }

      if (done) break
    }
  } catch (error) {
    // Flush any remaining queued events
    while (yieldQueue.length > 0) {
      yield yieldQueue.shift()!
    }

    closeOpenBlock()
    while (yieldQueue.length > 0) {
      yield yieldQueue.shift()!
    }

    if (error instanceof DomainTransportError) throw error
    if (error instanceof DomainUserAbortError) throw error

    const message = (error as Error)?.message ?? 'Codex stream loop failed'
    const normalized = normalizeError(
      message === CODEX_UPSTREAM_IDLE_TIMEOUT_ERROR
        ? { cause: error, stream_truncated: true }
        : { cause: error, mid_stream: true },
      providerType,
    )
    throw new DomainTransportError({ normalized, raw: error })
  }

  // Flush final events
  while (yieldQueue.length > 0) {
    yield yieldQueue.shift()!
  }

  if (!sawResponseCompleted) {
    closeOpenBlock()
    while (yieldQueue.length > 0) {
      yield yieldQueue.shift()!
    }
    const normalized = normalizeError(
      {
        cause: new Error('Codex stream ended before response.completed'),
        stream_truncated: true,
        mid_stream: true,
      },
      providerType,
    )
    throw new DomainTransportError({ normalized, raw: 'stream ended early' })
  }

  closeOpenBlock()
  while (yieldQueue.length > 0) {
    yield yieldQueue.shift()!
  }

  const stopReason: DomainStopReason = hadToolCalls ? 'tool_use' : 'end_turn'
  const usagePayload: Record<string, unknown> = {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_read_input_tokens: cacheReadInputTokens,
    cache_creation_input_tokens: null,
  }
  if (webSearchCount > 0) {
    usagePayload.server_tool_use = { web_search_requests: webSearchCount }
  }

  yield {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: usagePayload as DomainAssistantContent['usage'],
  }

  yield { type: 'message_stop' }
}

// ── Adapter ────────────────────────────────────────────────────────

export const codexAdapter: ProviderAdapter = {
  providerType: 'openai-responses',
  capabilities: {} as ProviderCapabilities,

  async createStream(
    config: ProviderConfig,
    _authArgs: unknown,
    request: DomainMessageRequest,
    signal: AbortSignal,
  ): Promise<DomainStreamingResponse> {
    const auth = resolveCodexAuth(config)
    if (!auth) {
      throw new DomainConnectionError({
        normalized: {
          kind: 'auth',
          message: 'No Codex access token available',
          providerType: 'openai-responses',
          raw: null,
        },
        cause: new Error('No Codex access token'),
      })
    }

    const currentToken = auth.getRefreshedToken()
    const sessionId = getSessionId()
    const codexBody = domainRequestToCodexBody(request, sessionId)
    const codexUrl = `${auth.baseUrl.replace(/\/$/, '')}/responses`

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      Authorization: `Bearer ${currentToken}`,
      originator: 'pi',
      'OpenAI-Beta': 'responses=experimental',
      session_id: sessionId,
    }
    if (!auth.isProxied) {
      try {
        headers['chatgpt-account-id'] = extractAccountId(currentToken)
      } catch {
        // non-fatal — proxy endpoints don't need the account header
      }
    }

    const reqBodyStr = JSON.stringify(codexBody)

    let codexResponse: Response
    try {
      codexResponse = await globalThis.fetch(codexUrl, {
        method: 'POST',
        headers,
        body: reqBodyStr,
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
        'openai-responses',
      )
      throw new DomainConnectionError({
        normalized: { ...normalized, kind: 'transport' },
        cause: error,
      })
    }

    if (!codexResponse.ok) {
      const errorText = await codexResponse.text()
      const normalized = this.normalizeError(
        {
          status: codexResponse.status,
          body: errorText,
          headers: codexResponse.headers,
        },
        'openai-responses',
      )
      throw new DomainTransportError({
        normalized,
        status: codexResponse.status,
        headers: Object.fromEntries(codexResponse.headers.entries()),
        raw: { status: codexResponse.status, body: errorText },
      })
    }

    const abortController = new AbortController()
    const stream = parseCodexStream(
      codexResponse,
      request.model,
      'openai-responses',
      this.normalizeError,
    )

    return {
      stream,
      requestId: codexResponse.headers.get('x-request-id') ?? undefined,
      responseHeaders: Object.fromEntries(codexResponse.headers.entries()),
      abort() {
        abortController.abort()
      },
      release() {
        try {
          abortController.abort()
        } catch {
          // ignore
        }
        if (codexResponse.body) {
          codexResponse.body.cancel().catch(() => {})
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
    const auth = resolveCodexAuth(config)
    if (!auth) {
      throw new DomainConnectionError({
        normalized: {
          kind: 'auth',
          message: 'No Codex access token available',
          providerType: 'openai-responses',
          raw: null,
        },
        cause: new Error('No Codex access token'),
      })
    }

    const currentToken = auth.getRefreshedToken()
    const sessionId = getSessionId()
    const codexBody = domainRequestToCodexBody(request, sessionId)
    codexBody.stream = false

    const codexUrl = `${auth.baseUrl.replace(/\/$/, '')}/responses`

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${currentToken}`,
      originator: 'pi',
      'OpenAI-Beta': 'responses=experimental',
      session_id: sessionId,
    }
    if (!auth.isProxied) {
      try {
        headers['chatgpt-account-id'] = extractAccountId(currentToken)
      } catch {
        // non-fatal
      }
    }

    let response: Response
    try {
      response = await globalThis.fetch(codexUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(codexBody),
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
        'openai-responses',
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
        'openai-responses',
      )
      throw new DomainTransportError({
        normalized,
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        raw: { status: response.status, body: errorText },
      })
    }

    const json = (await response.json()) as Record<string, unknown>
    return parseCodexNonStreamingResponse(json, request.model)
  },

  async countTokens(
    messages: TokenCountMessageParam[],
    tools: TokenCountToolParam[],
    _model: string,
    options?: { system?: string; betas?: string[] },
  ): Promise<TokenBreakdown | null> {
    try {
      const enc =
        (await import('gpt-tokenizer/encoding/o200k_base')) as unknown as GptTokenizerModule
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
      refusal?: boolean
      stream_truncated?: boolean
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
      if (r.refusal) return { ...base, kind: 'content_filter' }
      if (code === 'content_filter') return { ...base, kind: 'content_filter' }
      if (code === 'rate_limit_exceeded' || code === 'insufficient_quota') {
        return { ...base, kind: 'rate_limit' }
      }
      if (code === 'invalid_api_key') return { ...base, kind: 'auth' }
      if (code === 'server_error' || apiErrorType === 'server_error') {
        return { ...base, kind: 'server' }
      }
      if (code === 'context_length_exceeded') {
        return { ...base, kind: 'context_overflow' }
      }
      if (apiErrorType === 'invalid_request_error') {
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

// ── Non-streaming response parsing ─────────────────────────────────

function parseCodexNonStreamingResponse(
  body: Record<string, unknown>,
  modelId: string,
): DomainAssistantContent {
  const messageId = (body.id as string) || `msg_codex_${Date.now()}`
  const output = (body.output || []) as Array<Record<string, unknown>>
  const usage = (body.usage || {}) as Record<string, number | Record<string, number>>

  const content: DomainContentBlock[] = []
  let hadToolCalls = false

  for (const item of output) {
    const type = item.type as string
    if (type === 'message') {
      const text = extractMessageText(item)
      if (text) {
        content.push({ type: 'text', text })
      }
    } else if (type === 'function_call') {
      hadToolCalls = true
      let input: unknown = {}
      try {
        input = JSON.parse((item.arguments as string) || '{}')
      } catch {
        input = {}
      }
      content.push({
        type: 'tool_use',
        id: (item.call_id as string) || (item.id as string) || `call_${Date.now()}`,
        name: (item.name as string) || '',
        input,
      })
    } else if (type === 'reasoning') {
      const text = extractReasoningText(item)
      if (text) {
        content.push({
          type: 'reasoning',
          text,
          providerState: {
            openaiResponses: {
              reasoningId: (item.id as string) || undefined,
              encryptedContent: readString(item.encrypted_content) || undefined,
            },
          },
        })
      }
    }
  }

  const totalInput = (usage.input_tokens as number) || 0
  const totalOutput = (usage.output_tokens as number) || 0
  const details = usage.input_tokens_details as Record<string, number> | undefined
  const cached = details?.cached_tokens ?? 0

  return {
    id: messageId,
    type: 'message',
    role: 'assistant',
    content,
    model: modelId,
    stop_reason: hadToolCalls ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: totalInput - cached,
      output_tokens: totalOutput,
      cache_read_input_tokens: cached,
      cache_creation_input_tokens: null,
    },
  }
}
