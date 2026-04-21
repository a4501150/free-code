/**
 * Provider adapter interface.
 *
 * Formalizes the implicit contract every adapter under `src/services/api/`
 * already satisfies. The interface is declaration-only in this file — actual
 * implementations live under `src/services/api/adapters/` and are wired up
 * by later rollout steps.
 *
 * Implicit invariants that the interface documents (enforced by convention,
 * not types):
 *
 * 1. `createFetch` MUST produce responses whose body is valid Anthropic SSE,
 *    including the `message_start` / `content_block_start` /
 *    `content_block_delta` / `message_delta` / `message_stop` sequence.
 *    Errors must be formatted as Anthropic-style JSON:
 *        { "type":"error", "error":{"type":"api_error","message":"..." } }
 *    The streaming loop at `claude.ts` relies on this contract and does not
 *    need to know which adapter produced the stream.
 *
 * 2. Adapters MAY emit synthetic unsigned `thinking` blocks (signature="")
 *    for UI visibility when their provider streams reasoning text. The
 *    correctness guarantee is enforced on OUTBOUND — each adapter's
 *    outbound translate-messages pass drops thinking blocks on the way
 *    back to its provider (they never reach the wire as input), and
 *    `stripUnsignedThinkingBlocks` performs the same role for the
 *    Anthropic target. This lets users see reasoning live without
 *    triggering the "strip-on-next-turn" bug.
 *
 * 3. Adapters MAY attach provider-native, opaque side-channel payloads to
 *    thinking blocks (for example the Codex adapter stores
 *    `codexReasoningId` / `codexEncryptedContent` on the in-memory block).
 *    These fields are only read/written by the emitting adapter; they
 *    ride along with the Anthropic-shape representation and are ignored
 *    by every other adapter. This pattern enables provider-specific
 *    reasoning round-trip without changing the shared source-of-truth
 *    shape.
 */
import type { Anthropic } from '@anthropic-ai/sdk'
import type {
  ProviderCapabilities,
  ProviderConfig,
  ProviderType,
} from '../../utils/settings/types.js'
import type { NormalizedApiError } from '../../utils/normalizedError.js'

/**
 * Standard fetch signature. Adapters return a `FetchFn` from
 * `createFetch(...)` that the Anthropic SDK client uses as its `fetch`
 * override.
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

  /**
   * Returns the fetch override to pass into the Anthropic SDK client, or
   * `undefined` to indicate "no override — use the SDK's native fetch"
   * (Anthropic-native).
   *
   * `authArgs` is opaque to the interface — each adapter knows what its
   * auth pipeline produces (AWS credentials, GCP tokens, API keys, etc.).
   * The impure shell in `client.ts` constructs `authArgs` per provider
   * type and passes it through; adapter-impls cast it to the shape their
   * legacy fetch factory expects.
   */
  createFetch(config: ProviderConfig, authArgs: unknown): FetchFn | undefined

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
    messages: Anthropic.Beta.Messages.BetaMessageParam[],
    tools: Anthropic.Beta.Messages.BetaToolUnion[],
    model: string,
    options?: { system?: string; betas?: string[] },
  ): Promise<TokenBreakdown | null>

  /**
   * Normalize a provider-native error into {@link NormalizedApiError}.
   *
   * The `raw` argument carries one of two shapes depending on where in the
   * pipeline the error surfaced:
   *
   * - HTTP error: `{ status: number, body: string, headers?: Headers }`.
   *   Adapters should forward to `fromHttpStatus` unless they need to
   *   reclassify based on provider-specific error codes in the body
   *   (e.g. OpenAI `error.code === 'content_filter'`, Google
   *   `error.status === 'RESOURCE_EXHAUSTED'`).
   *
   * - Mid-stream error: `{ mid_stream: true, cause: unknown,
   *   status?: number, ...providerContext }`. Status is usually undefined;
   *   adapters classify from `cause` and any provider-specific context
   *   (Bedrock's EventStream exception frame, OpenAI SSE `error` JSON,
   *   Gemini finishReason).
   */
  normalizeError(raw: unknown, providerType: ProviderType): NormalizedApiError
}
