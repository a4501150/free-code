/**
 * Provider-neutral domain model.
 *
 * These types are the internal source-of-truth for conversation state.
 * They are independent of any provider SDK. Conversion to/from provider
 * wire formats happens at adapter boundaries (see domainConversion.ts).
 *
 * Design invariant: provider-specific continuation data lives ONLY under
 * `providerState`, never as top-level fields on content blocks.
 */

// ── Provider State ─────────────────────────────────────────────────

export type AnthropicProviderState = {
  signature?: string
  blockKind?: 'thinking' | 'redacted_thinking'
  redactedData?: string
}

export type OpenAIResponsesProviderState = {
  reasoningId?: string
  encryptedContent?: string
}

export type OpenAIChatCompletionsProviderState = Record<string, unknown>

export type BedrockConverseProviderState = Record<string, unknown>

export type GeminiProviderState = Record<string, unknown>

export type ProviderState = {
  anthropic?: AnthropicProviderState
  openaiResponses?: OpenAIResponsesProviderState
  openaiChatCompletions?: OpenAIChatCompletionsProviderState
  bedrockConverse?: BedrockConverseProviderState
  gemini?: GeminiProviderState
}

// ── Content Blocks (assistant output) ──────────────────────────────

export type DomainTextBlock = {
  type: 'text'
  text: string
  citations?: unknown
}

export type DomainToolUseBlock = {
  type: 'tool_use'
  id: string
  name: string
  input: unknown
}

export type DomainReasoningBlock = {
  type: 'reasoning'
  text: string
  providerState?: ProviderState
}

export type DomainRedactedReasoningBlock = {
  type: 'redacted_reasoning'
  providerState?: ProviderState
}

export type DomainServerToolUseBlock = {
  type: 'server_tool_use'
  id: string
  name: string
  input: unknown
}

export type DomainServerToolResultBlock = {
  type: 'server_tool_result'
  tool_use_id: string
  content: unknown
}

/**
 * Union of all assistant output content blocks the domain model
 * explicitly models. Block types not listed here (code_execution,
 * web_search_tool_result, etc.) pass through as opaque records at
 * conversion boundaries; downstream code handles them via type
 * assertions on the discriminant.
 */
export type DomainContentBlock =
  | DomainTextBlock
  | DomainToolUseBlock
  | DomainReasoningBlock
  | DomainRedactedReasoningBlock
  | DomainServerToolUseBlock
  | DomainServerToolResultBlock

// ── Stop Reason ────────────────────────────────────────────────────

export type DomainStopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'stop_sequence'
  | 'tool_use'
  | 'pause_turn'
  | 'compaction'
  | 'refusal'
  | 'model_context_window_exceeded'

// ── Usage ──────────────────────────────────────────────────────────

export type DomainUsage = {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens?: number | null
  cache_read_input_tokens?: number | null
  cache_creation?: unknown
  server_tool_use?: unknown
  service_tier?: string | null
  speed?: string | null
  inference_geo?: string | null
  iterations?: unknown
}

// ── Assistant Message Envelope ─────────────────────────────────────

/**
 * Provider-neutral assistant message content. Replaces the Anthropic
 * SDK's BetaMessage as the internal representation.
 *
 * Field names intentionally match Anthropic's snake_case to minimize
 * churn at the ~500+ access sites. The TYPE is ours; the field shapes
 * are compatible.
 */
export type DomainAssistantContent = {
  id: string
  type: 'message'
  role: 'assistant'
  content: DomainContentBlock[]
  model: string
  stop_reason: DomainStopReason | null
  stop_sequence: string | null
  usage: DomainUsage
  container?: unknown
  context_management?: unknown
}
