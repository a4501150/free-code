/**
 * OpenAI Chat Completions adapter.
 *
 * Token counting uses the `gpt-tokenizer` npm package locally so `/context`
 * and statusline pre-flight counting do not require a live round-trip.
 * `gpt-tokenizer` ships `cl100k_base` (GPT-3.5 / GPT-4 family) and
 * `o200k_base` (GPT-4o / o-series) encodings. We pick based on a small
 * model-family allow-list; unknown models default to `o200k_base`, the
 * encoding for all recently-released OpenAI models.
 *
 * Dynamic import of `gpt-tokenizer` keeps the ~120KB gzipped encoding data
 * out of builds that do not configure an OpenAI provider.
 */
import type { ProviderAdapter, FetchFn, TokenBreakdown } from '../adapter.js'
import type {
  ProviderCapabilities,
  ProviderConfig,
  ProviderType,
} from '../../../utils/settings/types.js'
import {
  fromHttpStatus,
  type NormalizedApiError,
} from '../../../utils/normalizedError.js'
import { createChatCompletionsFetch } from '../openai-chat-completions-adapter.js'
import type { Anthropic } from '@anthropic-ai/sdk'

type GptTokenizerModule = {
  encode: (text: string) => number[]
}

async function loadTokenizerForModel(
  model: string,
): Promise<GptTokenizerModule> {
  // Models whose encoding is cl100k_base. Everything else uses o200k_base —
  // this is deliberately permissive because o200k_base is the current
  // default for any new OpenAI-shape model (including o1 / o3 / gpt-4o).
  const isCl100k =
    /^gpt-4(?:-|$)/i.test(model) ||
    /^gpt-3\.5-/i.test(model) ||
    /^text-embedding-/i.test(model)
  if (isCl100k) {
    // Dynamic import keeps the bundle lean for non-OpenAI users.
    return (await import('gpt-tokenizer/encoding/cl100k_base')) as unknown as GptTokenizerModule
  }
  return (await import('gpt-tokenizer/encoding/o200k_base')) as unknown as GptTokenizerModule
}

/**
 * Serialize an Anthropic-shape message array into the plain-text form the
 * OpenAI tokenizer sees. This is intentionally a superset — we prefix each
 * message with a role tag so role overhead is included in the count. It is
 * an estimate, not a byte-exact reproduction of the OpenAI-side prompt.
 */
function serializeForTokenization(
  messages: Anthropic.Beta.Messages.BetaMessageParam[],
  tools: Anthropic.Beta.Messages.BetaToolUnion[],
  system?: string,
): string {
  const parts: string[] = []
  if (system) parts.push(`system:\n${system}`)
  for (const t of tools) {
    // name + description + input_schema (JSON) — matches what the wire
    // payload would send to the model-side tool registry. Some tool unions
    // (MCP toolsets) have no `name` field; skip those.
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
      if (block.type === 'text') {
        parts.push((block as { text: string }).text ?? '')
      } else if (block.type === 'tool_use') {
        parts.push(
          `${(block as { name?: string }).name ?? ''}(${JSON.stringify(
            (block as { input?: unknown }).input ?? {},
          )})`,
        )
      } else if (block.type === 'tool_result') {
        const content = (block as { content?: unknown }).content
        if (typeof content === 'string') parts.push(content)
        else if (Array.isArray(content)) {
          for (const c of content) {
            if (
              c &&
              typeof c === 'object' &&
              'text' in (c as Record<string, unknown>)
            ) {
              parts.push(String((c as { text?: unknown }).text ?? ''))
            }
          }
        }
      } else if (block.type === 'thinking') {
        parts.push((block as { thinking?: string }).thinking ?? '')
      }
      // image / document blocks are not text-countable with gpt-tokenizer;
      // the roughTokenCountEstimation fallback covers them for /context.
    }
  }
  return parts.join('\n')
}

export const openaiChatCompletionsAdapter: ProviderAdapter = {
  providerType: 'openai-chat-completions',
  capabilities: {} as ProviderCapabilities,

  createFetch(config: ProviderConfig, authArgs: unknown): FetchFn {
    return createChatCompletionsFetch(
      config,
      authArgs as Parameters<typeof createChatCompletionsFetch>[1],
    )
  },

  async countTokens(
    messages: Anthropic.Beta.Messages.BetaMessageParam[],
    tools: Anthropic.Beta.Messages.BetaToolUnion[],
    model: string,
    options?: { system?: string; betas?: string[] },
  ): Promise<TokenBreakdown | null> {
    try {
      const enc = await loadTokenizerForModel(model)
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
    }
    // Parse OpenAI error shape: { error: { code, type, message } }
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
      if (code === 'content_filter') return { ...base, kind: 'content_filter' }
      if (code === 'rate_limit_exceeded' || code === 'insufficient_quota') {
        return { ...base, kind: 'rate_limit' }
      }
      if (code === 'invalid_api_key') return { ...base, kind: 'auth' }
      // Context-window overflow + any explicit invalid_request_error from
      // upstream become `invalid_request` so the UI surfaces a precise
      // error type and `withRetry` doesn't burn budget retrying it.
      if (
        code === 'context_length_exceeded' ||
        code === 'invalid_request_error' ||
        apiErrorType === 'invalid_request_error'
      ) {
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
      kind: r.mid_stream ? 'unknown' : 'transport',
      message: errMessage ?? causeMsg,
      providerType,
      raw,
    }
    return reclassifyByCode(base)
  },
}
