/**
 * Codex (OpenAI Responses API) adapter.
 *
 * Same tokenizer path as OpenAI Chat Completions — Codex uses the o-series
 * encoding (`o200k_base`). `gpt-tokenizer` is dynamic-imported so bundles
 * without a Codex provider don't pay the cost.
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
import { createCodexFetch } from '../codex-fetch-adapter.js'
import type { Anthropic } from '@anthropic-ai/sdk'

type GptTokenizerModule = {
  encode: (text: string) => number[]
}

function serializeForTokenization(
  messages: Anthropic.Beta.Messages.BetaMessageParam[],
  tools: Anthropic.Beta.Messages.BetaToolUnion[],
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
        parts.push((block as { text: string }).text ?? '')
      else if (block.type === 'tool_use')
        parts.push(
          `${(block as { name?: string }).name ?? ''}(${JSON.stringify(
            (block as { input?: unknown }).input ?? {},
          )})`,
        )
      else if (block.type === 'tool_result') {
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
    }
  }
  return parts.join('\n')
}

export const codexAdapter: ProviderAdapter = {
  providerType: 'openai-responses',
  capabilities: {} as ProviderCapabilities,

  createFetch(_config: ProviderConfig, authArgs: unknown): FetchFn {
    // Codex's factory is single-arg (CodexFetchOptions carries baseUrl);
    // config is not consulted.
    return createCodexFetch(authArgs as Parameters<typeof createCodexFetch>[0])
  },

  async countTokens(
    messages: Anthropic.Beta.Messages.BetaMessageParam[],
    tools: Anthropic.Beta.Messages.BetaToolUnion[],
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
    // Parse OpenAI Responses error shape: { error: { code, type, message } }
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
      // Context-window overflow + any explicit invalid_request_error from
      // upstream become `invalid_request` so the UI surfaces a precise
      // error type and `withRetry` doesn't burn budget retrying it.
      if (
        code === 'context_length_exceeded' ||
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
      kind: r.refusal
        ? 'content_filter'
        : r.stream_truncated
          ? 'transport'
          : r.mid_stream
            ? 'unknown'
            : 'transport',
      message: errMessage ?? causeMsg,
      providerType,
      raw,
    }
    return reclassifyByCode(base)
  },
}
