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
 *   {@link DomainAssistantContent} directly.
 *
 * The legacy `createFetch(...)` method is retained for backwards
 * compatibility during migration and will be removed once all call sites
 * use the domain transport methods.
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
  DomainStreamingResponse,
} from './domain-transport.js'
import type { DomainAssistantContent } from '../../types/domain.js'

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
  name?: string
  description?: string
  input_schema?: Record<string, unknown>
  [key: string]: unknown
}

/**
 * Standard fetch signature. Adapters return a `FetchFn` from
 * `createFetch(...)` that the Anthropic SDK client uses as its `fetch`
 * override.
 *
 * @deprecated Use `createStream` / `createMessage` instead. Retained for
 * backwards compatibility during migration.
 */
export type FetchFn = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>

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
    authArgs: unknown,
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
    authArgs: unknown,
    request: DomainMessageRequest,
    signal: AbortSignal,
  ): Promise<DomainAssistantContent>

  // ── Legacy transport (deprecated) ──────────────────────────────

  /**
   * Returns the fetch override to pass into the Anthropic SDK client, or
   * `undefined` to indicate "no override — use the SDK's native fetch"
   * (Anthropic-native).
   *
   * Only implemented by adapters that still use the Anthropic SDK as their
   * transport layer (anthropic, vertex, foundry). Native-transport adapters
   * (openai-chat-completions, openai-responses, gemini, bedrock-converse)
   * do not implement this.
   *
   * @deprecated Use `createStream` / `createMessage` instead.
   */
  createFetch?(config: ProviderConfig, authArgs: unknown): FetchFn | undefined

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
