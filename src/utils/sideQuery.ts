import type {
  DomainAssistantContent,
  DomainContentBlock,
  DomainUserContentBlock,
  DomainUserTextBlock,
} from '../types/domain.js'
import type { ToolSchemaUnion } from './api.js'
import { setLastApiCompletionTimestamp } from '../bootstrap/state.js'
import { STRUCTURED_OUTPUTS_BETA_HEADER } from '../constants/betas.js'
import type { QuerySource } from '../constants/querySource.js'
import {
  getAttributionHeader,
  getCLISyspromptPrefix,
} from '../constants/system.js'

import { getAPIMetadata, prepareRetry } from '../services/api/claude.js'
import {
  getAdapterForModel,
  getProviderConfigForModel,
} from '../services/api/adapters/index.js'
import type { DomainMessageRequest } from '../services/api/domain-transport.js'
import { withRetry } from '../services/api/withRetry.js'
import { getModelBetas, modelSupportsStructuredOutputs } from './betas.js'
import { computeFingerprint } from './fingerprint.js'
import { returnValue } from './generators.js'
import { normalizeModelStringForAPI } from './model/model.js'
import { getProviderRegistry } from './model/providerRegistry.js'

type MessageParam = {
  role: 'user' | 'assistant'
  content: string | DomainUserContentBlock[] | DomainContentBlock[]
}
type TextBlockParam = DomainUserTextBlock
type Tool = ToolSchemaUnion
type ToolChoice = { type: string; name?: string; [key: string]: unknown }
type BetaJSONOutputFormat = Record<string, unknown>

export type SideQueryOptions = {
  /** Model to use for the query */
  model: string
  /**
   * System prompt - string or array of text blocks (will be prefixed with CLI attribution).
   *
   * The attribution header is always placed in its own TextBlockParam block to ensure
   * server-side parsing correctly extracts the cc_entrypoint value without including
   * system prompt content.
   */
  system?: string | TextBlockParam[]
  /** Messages to send (supports cache_control on content blocks) */
  messages: MessageParam[]
  /** Optional tools (supports both standard Tool[] and ToolSchemaUnion[] for custom tool types) */
  tools?: Tool[] | ToolSchemaUnion[]
  /** Optional tool choice (use { type: 'tool', name: 'x' } for forced output) */
  tool_choice?: ToolChoice
  /** Optional JSON output format for structured responses */
  output_format?: BetaJSONOutputFormat
  /** Max tokens (default: 1024) */
  max_tokens?: number
  /** Max retries (default: 2) */
  maxRetries?: number
  /** Abort signal */
  signal?: AbortSignal
  /** Skip CLI system prompt prefix (keeps attribution header for OAuth). For internal classifiers that provide their own prompt. */
  skipSystemPromptPrefix?: boolean
  /** Temperature override */
  temperature?: number
  /** Thinking budget (enables thinking), or `false` to send `{ type: 'disabled' }`. */
  thinking?: number | false
  /** Stop sequences — generation stops when any of these strings is emitted */
  stop_sequences?: string[]
  /** Attributes this call in tengu_api_success for COGS joining against reporting.sampling_calls. */
  querySource: QuerySource
}

/**
 * Extract text from first user message for fingerprint computation.
 */
function extractFirstUserMessageText(messages: MessageParam[]): string {
  const firstUserMessage = messages.find(m => m.role === 'user')
  if (!firstUserMessage) return ''

  const content = firstUserMessage.content
  if (typeof content === 'string') return content

  // Array of content blocks - find first text block
  const textBlock = content.find(block => block.type === 'text')
  return textBlock?.type === 'text' ? textBlock.text : ''
}

/**
 * Lightweight API wrapper for "side queries" outside the main conversation loop.
 *
 * Use this instead of direct client.beta.messages.create() calls to ensure
 * proper OAuth token validation with fingerprint attribution headers.
 *
 * This handles:
 * - Fingerprint computation for OAuth validation
 * - Attribution header injection
 * - CLI system prompt prefix
 * - Proper betas for the model
 * - API metadata
 * - Model string normalization (strips provider prefix for API)
 *
 * @example
 * // Permission explainer
 * await sideQuery({ querySource: 'permission_explainer', model, system: SYSTEM_PROMPT, messages, tools, tool_choice })
 *
 * @example
 * // Session search
 * await sideQuery({ querySource: 'session_search', model, system: SEARCH_PROMPT, messages })
 *
 * @example
 * // Model validation
 * await sideQuery({ querySource: 'model_validation', model, max_tokens: 1, messages: [{ role: 'user', content: 'Hi' }] })
 */
export async function sideQuery(
  opts: SideQueryOptions,
): Promise<DomainAssistantContent> {
  const {
    model,
    system,
    messages,
    tools,
    tool_choice,
    output_format,
    max_tokens = 1024,
    maxRetries = 2,
    signal,
    skipSystemPromptPrefix,
    temperature,
    thinking,
    stop_sequences,
  } = opts

  const betas = [...getModelBetas(model)]
  // Add structured-outputs beta if using output_format and provider supports it
  if (
    output_format &&
    modelSupportsStructuredOutputs(model) &&
    !betas.includes(STRUCTURED_OUTPUTS_BETA_HEADER)
  ) {
    betas.push(STRUCTURED_OUTPUTS_BETA_HEADER)
  }

  // Extract first user message text for fingerprint
  const messageText = extractFirstUserMessageText(messages)

  // Compute fingerprint for OAuth attribution
  const fingerprint = computeFingerprint(messageText, MACRO.VERSION)
  const attributionHeader = getProviderRegistry().isAnthropicType(model)
    ? getAttributionHeader(fingerprint)
    : ''

  // Build system as array to keep attribution header in its own block
  // (prevents server-side parsing from including system content in cc_entrypoint)
  const systemBlocks: TextBlockParam[] = [
    attributionHeader ? { type: 'text', text: attributionHeader } : null,
    // Skip CLI system prompt prefix for internal classifiers that provide their own prompt
    ...(skipSystemPromptPrefix
      ? []
      : [
          {
            type: 'text' as const,
            text: getCLISyspromptPrefix({
              isNonInteractive: false,
              hasAppendSystemPrompt: false,
              model,
            }),
          },
        ]),
    ...(Array.isArray(system)
      ? system
      : system
        ? [{ type: 'text' as const, text: system }]
        : []),
  ].filter((block): block is TextBlockParam => block !== null)

  let thinkingConfig: DomainMessageRequest['thinking'] | undefined
  if (thinking === false) {
    thinkingConfig = { type: 'disabled' }
  } else if (thinking !== undefined) {
    thinkingConfig = {
      type: 'enabled',
      budgetTokens: Math.min(thinking, max_tokens - 1),
    }
  }

  const adapter = getAdapterForModel(model)
  const providerConfig = getProviderConfigForModel(model)
  const request: DomainMessageRequest = {
    model: normalizeModelStringForAPI(model),
    maxTokens: max_tokens,
    system: systemBlocks as unknown as DomainMessageRequest['system'],
    messages: messages as unknown as DomainMessageRequest['messages'],
    ...(tools && { tools: tools as DomainMessageRequest['tools'] }),
    ...(tool_choice && {
      toolChoice: tool_choice as DomainMessageRequest['toolChoice'],
    }),
    ...(output_format && { outputConfig: { format: output_format } }),
    ...(temperature !== undefined && { temperature }),
    ...(stop_sequences && { stopSequences: stop_sequences }),
    ...(thinkingConfig && { thinking: thinkingConfig }),
    ...(betas.length > 0 && { betas }),
    ...(getProviderRegistry().isAnthropicType(model) && {
      metadata: getAPIMetadata(),
    }),
  }
  const requestSignal = signal ?? new AbortController().signal
  const response = await returnValue(
    withRetry(
      () => adapter.createMessage(providerConfig, request, requestSignal),
      {
        maxRetries,
        model,
        thinkingConfig: thinkingConfig ?? { type: 'disabled' },
        signal: requestSignal,
        querySource: opts.querySource,
        prepareRetry,
      },
    ),
  )

  setLastApiCompletionTimestamp(Date.now())

  return response.message
}
