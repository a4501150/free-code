/**
 * Provider adapter interface.
 *
 * Each adapter owns its provider's wire format end-to-end: request
 * construction, HTTP transport, SSE/EventStream parsing, and domain event
 * emission. The main loop ({@link claude.ts}) consumes only
 * {@link DomainStreamEvent} and {@link DomainTransportError}.
 *
 * Adapters implement two transport methods:
 *
 * - `createStream(...)` — streaming requests, returns a
 *   {@link DomainStreamingResponse} whose `.stream` yields
 *   {@link DomainStreamEvent}s following the lifecycle contract below.
 *
 * - `createMessage(...)` — non-streaming requests, returns a
 *   {@link DomainMessageResponse} directly.
 *
 * Stream lifecycle contract:
 *
 * 1. Every successful stream starts with exactly one `message_start`.
 * 2. Content blocks follow `content_block_start` → N × `content_block_delta`
 *    → `content_block_stop`.
 * 3. After all blocks: `message_delta` (usage + stop_reason) → `message_stop`.
 * 4. An `error` event is terminal — no events may follow it.
 * 5. Fatal errors before `message_start` throw `DomainTransportError`.
 * 6. Fatal errors after streaming started yield `{ type: 'error' }` then return.
 *
 * Reasoning blocks:
 *
 * Adapters MAY emit synthetic unsigned `reasoning` blocks (empty signature)
 * for UI visibility. Correctness is enforced on OUTBOUND:
 * `stripForeignReasoningBlocks` removes non-round-trippable blocks before
 * each API call.
 *
 * Provider-specific continuation data lives under `providerState` on
 * domain blocks, never as top-level fields.
 */
import type {
  ProviderCapabilities,
  ProviderConfig,
  ProviderType,
} from '../../utils/settings/types.js'
import type { NormalizedApiError } from '../../utils/normalizedError.js'
import type {
  DomainMessageRequest,
  DomainMessageResponse,
  DomainStreamingResponse,
} from './domain-transport.js'

/**
 * Minimal message param type for token counting.
 * Compatible with both Anthropic SDK types and domain types.
 */
export type TokenCountMessageParam = {
  role: 'user' | 'assistant'
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  content: string | Array<{ type: string; [key: string]: any }>
}

/**
 * Minimal tool definition type for token counting.
 * Compatible with both Anthropic SDK types and domain types.
 */
export type TokenCountToolParam = {
  name?: string | null
  description?: string | null
  input_schema?: Record<string, unknown>
  [key: string]: unknown
}

/**
 * Pre-flight token breakdown. `outputTokens` is 0 for pre-request estimates;
 * it exists for symmetry with {@link NormalizedUsage} (some providers have
 * mechanisms that return both numbers).
 */
export interface TokenBreakdown {
  inputTokens: number
  outputTokens: number
  reasoningTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

// Shared token-counting constants for Anthropic-shaped adapters.
// API constraint: max_tokens must be greater than thinking.budget_tokens.
export const TOKEN_COUNT_THINKING_BUDGET = 1024
export const TOKEN_COUNT_MAX_TOKENS = 2048

export function hasThinkingBlocks(
  messages: readonly TokenCountMessageParam[],
): boolean {
  for (const message of messages) {
    if (message.role === 'assistant' && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (
          typeof block === 'object' &&
          block !== null &&
          'type' in block &&
          (block.type === 'thinking' || block.type === 'redacted_thinking')
        ) {
          return true
        }
      }
    }
  }
  return false
}

export interface ProviderAdapter {
  readonly providerType: ProviderType
  readonly capabilities: Readonly<ProviderCapabilities>

  // ── Domain transport methods (new) ──────────────────────────────

  /**
   * Create a streaming request that produces domain events directly.
   *
   * The returned {@link DomainStreamingResponse} owns all underlying
   * resources (sockets, streams, timers). The caller MUST call `.release()`
   * when done, even on error paths.
   *
   * Errors during stream creation throw {@link DomainTransportError}.
   * Errors during streaming yield `{ type: 'error' }` then end the iterable.
   */
  createStream(
    config: ProviderConfig,
    request: DomainMessageRequest,
    signal: AbortSignal,
  ): Promise<DomainStreamingResponse>

  /**
   * Create a non-streaming request that returns the complete response.
   *
   * Errors throw {@link DomainTransportError}.
   */
  createMessage(
    config: ProviderConfig,
    request: DomainMessageRequest,
    signal: AbortSignal,
  ): Promise<DomainMessageResponse>

  // ── Token counting ─────────────────────────────────────────────

  /**
   * Pre-flight token count.
   *
   * Implementations:
   *   - Anthropic / Vertex / Foundry: `/v1/messages/count_tokens`.
   *   - OpenAI / Codex: `gpt-tokenizer` local count.
   *   - Gemini: native `:countTokens` endpoint.
   *   - Bedrock: `CountTokensCommand`.
   *
   * Return `null` only when the underlying mechanism is unavailable; callers
   * fall back to rough estimation.
   */
  countTokens(
    messages: TokenCountMessageParam[],
    tools: TokenCountToolParam[],
    model: string,
    options?: { system?: string; betas?: string[] },
  ): Promise<TokenBreakdown | null>

  // ── Error normalization ────────────────────────────────────────

  /**
   * Normalize a provider-native error into {@link NormalizedApiError}.
   *
   * The `raw` argument carries one of two shapes depending on where in the
   * pipeline the error surfaced:
   *
   * - HTTP error: `{ status: number, body: string, headers?: Headers }`.
   * - Mid-stream error: `{ mid_stream: true, cause: unknown, ... }`.
   */
  normalizeError(raw: unknown, providerType: ProviderType): NormalizedApiError
}
