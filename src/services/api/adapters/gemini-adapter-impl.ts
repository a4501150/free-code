/**
 * Gemini (Vertex AI generateContent) adapter.
 *
 * Uses Gemini's native `:countTokens` REST endpoint. Anthropic messages are
 * translated to Gemini `contents` parts and POSTed alongside the tool
 * definitions. Same GCP auth flow as `createGeminiFetch`.
 *
 * If anything fails (auth, network, translation) we return null so the
 * rough estimator can take over.
 */
import type { ProviderAdapter, FetchFn, TokenBreakdown } from '../adapter.js'
import type { ProviderCapabilities, ProviderConfig, ProviderType } from '../../../utils/settings/types.js'
import {
  fromHttpStatus,
  type NormalizedApiError,
} from '../../../utils/normalizedError.js'
import { createGeminiFetch } from '../gemini-adapter.js'
import { logError } from '../../../utils/log.js'
import {
  getProviderRegistry,
  type ResolvedProvider,
} from '../../../utils/model/providerRegistry.js'
import { GoogleAuth } from 'google-auth-library'
import type { Anthropic } from '@anthropic-ai/sdk'

/**
 * Translate Anthropic messages into the Gemini `contents` array shape —
 * the minimum needed for `:countTokens` (which ignores tool schemas for the
 * most part but does count the messages + system prompt).
 */
function translateToGeminiContents(
  messages: Anthropic.Beta.Messages.BetaMessageParam[],
): Array<{ role: string; parts: Array<{ text: string }> }> {
  const out: Array<{ role: string; parts: Array<{ text: string }> }> = []
  for (const m of messages) {
    const role = m.role === 'assistant' ? 'model' : 'user'
    const parts: Array<{ text: string }> = []
    if (typeof m.content === 'string') {
      parts.push({ text: m.content })
    } else if (Array.isArray(m.content)) {
      for (const block of m.content) {
        if (block.type === 'text') {
          parts.push({ text: (block as { text: string }).text ?? '' })
        } else if (block.type === 'tool_use') {
          parts.push({
            text: `${(block as { name?: string }).name ?? ''}(${JSON.stringify(
              (block as { input?: unknown }).input ?? {},
            )})`,
          })
        } else if (block.type === 'tool_result') {
          const content = (block as { content?: unknown }).content
          if (typeof content === 'string') parts.push({ text: content })
          else if (Array.isArray(content)) {
            for (const c of content) {
              if (
                c &&
                typeof c === 'object' &&
                'text' in (c as Record<string, unknown>)
              ) {
                parts.push({
                  text: String((c as { text?: unknown }).text ?? ''),
                })
              }
            }
          }
        }
      }
    }
    if (parts.length > 0) out.push({ role, parts })
  }
  return out
}

async function getGcpAccessToken(
  config: ProviderConfig,
): Promise<{ token: string; projectId?: string } | null> {
  try {
    const hasProjectEnvVar =
      process.env['GCLOUD_PROJECT'] ||
      process.env['GOOGLE_CLOUD_PROJECT'] ||
      process.env['gcloud_project'] ||
      process.env['google_cloud_project']
    const hasKeyFile =
      process.env['GOOGLE_APPLICATION_CREDENTIALS'] ||
      process.env['google_application_credentials']

    const googleAuth = new GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
      ...(hasProjectEnvVar || hasKeyFile
        ? {}
        : { projectId: config.auth?.gcp?.projectId }),
    })
    const authClient = await googleAuth.getClient()
    const headers = (await authClient.getRequestHeaders()) as unknown as Record<
      string,
      string | undefined
    >
    const token = headers['Authorization']?.replace('Bearer ', '')
    if (!token) return null
    const projectId =
      headers['x-goog-user-project'] ||
      (await googleAuth.getProjectId()) ||
      undefined
    return { token, projectId: projectId ?? undefined }
  } catch (err) {
    logError(err)
    return null
  }
}

export const geminiAdapter: ProviderAdapter = {
  providerType: 'gemini',
  capabilities: {} as ProviderCapabilities,

  createFetch(config: ProviderConfig, authArgs: unknown): FetchFn {
    return createGeminiFetch(
      config,
      authArgs as Parameters<typeof createGeminiFetch>[1],
    )
  },

  async countTokens(
    messages: Anthropic.Beta.Messages.BetaMessageParam[],
    _tools: Anthropic.Beta.Messages.BetaToolUnion[],
    model: string,
    options?: { system?: string; betas?: string[] },
  ): Promise<TokenBreakdown | null> {
    try {
      const resolved = getProviderRegistry().getProviderForModel(model) as
        | ResolvedProvider
        | null
      if (!resolved || resolved.config.type !== 'gemini') return null

      const access = await getGcpAccessToken(resolved.config)
      if (!access) return null

      const region = resolved.config.auth?.gcp?.region || 'us-central1'
      const configProjectId =
        resolved.config.auth?.gcp?.projectId || access.projectId || ''
      const baseUrl =
        resolved.config.baseUrl ||
        `https://${region}-aiplatform.googleapis.com/v1`
      const url = `${baseUrl.replace(/\/$/, '')}/projects/${configProjectId}/locations/${region}/publishers/google/models/${model}:countTokens`

      const body: Record<string, unknown> = {
        contents: translateToGeminiContents(messages),
      }
      if (options?.system) {
        body.systemInstruction = {
          parts: [{ text: options.system }],
        }
      }

      const response = await globalThis.fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${access.token}`,
        },
        body: JSON.stringify(body),
      })

      if (!response.ok) return null
      const json = (await response.json()) as { totalTokens?: number }
      if (typeof json.totalTokens !== 'number') return null
      return { inputTokens: json.totalTokens, outputTokens: 0 }
    } catch (err) {
      logError(err)
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
      finishReason?: string
    }
    // SAFETY / RECITATION on a candidate is Google's content-filter signal.
    if (r.finishReason === 'SAFETY' || r.finishReason === 'RECITATION') {
      return {
        kind: 'content_filter',
        message: `Google ${r.finishReason}`,
        providerType,
        raw,
      }
    }

    // Google error shape: { error: { code, status, message } }
    let googleStatus: string | undefined
    let errMessage: string | undefined
    if (r.body) {
      try {
        const parsed =
          typeof r.body === 'string'
            ? (JSON.parse(r.body) as {
                error?: { code?: number; status?: string; message?: string }
              })
            : (r.body as {
                error?: { code?: number; status?: string; message?: string }
              })
        googleStatus = parsed?.error?.status
        errMessage = parsed?.error?.message
      } catch {
        // body is not JSON.
      }
    }

    const reclassifyByGoogleStatus = (
      base: NormalizedApiError,
    ): NormalizedApiError => {
      if (!googleStatus) return base
      if (googleStatus === 'RESOURCE_EXHAUSTED') {
        return { ...base, kind: 'rate_limit' }
      }
      if (
        googleStatus === 'PERMISSION_DENIED' ||
        googleStatus === 'UNAUTHENTICATED'
      ) {
        return { ...base, kind: 'auth' }
      }
      if (googleStatus === 'INVALID_ARGUMENT' || googleStatus === 'NOT_FOUND') {
        return { ...base, kind: 'invalid_request' }
      }
      if (googleStatus === 'UNAVAILABLE' || googleStatus === 'INTERNAL') {
        return { ...base, kind: 'server' }
      }
      return base
    }

    if (typeof r.status === 'number') {
      const base = fromHttpStatus(
        r.status,
        errMessage ?? (typeof r.body === 'string' ? r.body : `HTTP ${r.status}`),
        providerType,
        r.headers,
        raw,
      )
      return reclassifyByGoogleStatus(base)
    }

    const causeMsg =
      r.cause instanceof Error ? r.cause.message : String(r.cause ?? 'stream error')
    const base: NormalizedApiError = {
      kind: r.mid_stream ? 'unknown' : 'transport',
      message: errMessage ?? causeMsg,
      providerType,
      raw,
    }
    return reclassifyByGoogleStatus(base)
  },
}
