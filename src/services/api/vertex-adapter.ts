/**
 * Vertex AI Native Adapter
 *
 * Replaces @anthropic-ai/vertex-sdk with a native fetch adapter that:
 * 1. Rewrites URLs: /v1/messages → /projects/{p}/locations/{r}/publishers/anthropic/models/{m}:streamRawPredict
 * 2. Mutates body: removes model, adds anthropic_version
 * 3. Injects GCP OAuth bearer token
 * 4. Response is standard SSE (no conversion needed)
 *
 * Reference: @anthropic-ai/vertex-sdk/src/client.ts
 */

import type { ProviderConfig } from '../../utils/settings/types.js'
import { vertexAnthropicAdapter } from './adapters/vertex-adapter-impl.js'
import { toAnthropicErrorType } from '../../utils/normalizedError.js'

/**
 * Creates a fetch function that intercepts Anthropic SDK calls and routes
 * them to Vertex AI.
 *
 * @param config Provider config with auth.gcp containing region and projectId
 * @param getAccessToken Function that returns a GCP OAuth2 access token
 */
export function createVertexFetch(
  config: ProviderConfig,
  getAccessToken: () => Promise<{ token: string; projectId?: string }>,
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  const region = config.auth?.gcp?.region || 'us-east5'
  const configProjectId = config.auth?.gcp?.projectId
  const baseUrl =
    config.baseUrl ||
    (region === 'global'
      ? 'https://aiplatform.googleapis.com/v1'
      : `https://${region}-aiplatform.googleapis.com/v1`)

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

    // Extract model and prepare Vertex body
    const model = anthropicBody.model as string
    const isStreaming = anthropicBody.stream !== false

    // Build Vertex-specific body: remove model, add anthropic_version
    const vertexBody = { ...anthropicBody }
    delete vertexBody.model
    vertexBody.anthropic_version = 'vertex-2023-10-16'

    // Convert anthropic-beta header to body field
    const initHeaders = init?.headers as Record<string, string> | undefined
    const betaHeader = initHeaders?.['anthropic-beta']
    if (betaHeader) {
      vertexBody.anthropic_beta = betaHeader
        .split(',')
        .map((s: string) => s.trim())
    }

    // Get GCP access token and project ID
    // All env vars (ANTHROPIC_VERTEX_PROJECT_ID) must be resolved into
    // config.auth.gcp.projectId by the caller (legacyProviderMigration.ts).
    const authResult = await getAccessToken()
    const projectId = configProjectId || authResult.projectId || ''

    // Build Vertex URL
    const action = isStreaming ? 'streamRawPredict' : 'rawPredict'
    const vertexUrl = `${baseUrl.replace(/\/$/, '')}/projects/${projectId}/locations/${region}/publishers/anthropic/models/${model}:${action}`

    const bodyStr = JSON.stringify(vertexBody)

    // Build headers
    const requestHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${authResult.token}`,
    }

    // Copy through relevant headers
    if (initHeaders) {
      for (const key of [
        'x-app',
        'User-Agent',
        'X-Claude-Code-Session-Id',
      ]) {
        if (initHeaders[key]) {
          requestHeaders[key] = initHeaders[key]
        }
      }
    }

    // Make the request
    const response = await globalThis.fetch(vertexUrl, {
      method: 'POST',
      headers: requestHeaders,
      body: bodyStr,
    })

    if (!response.ok) {
      const errorText = await response.text()
      const normalized = vertexAnthropicAdapter.normalizeError(
        {
          status: response.status,
          body: errorText,
          headers: response.headers,
        },
        'vertex',
      )
      const errorBody = {
        type: 'error',
        error: {
          type: toAnthropicErrorType(normalized.kind),
          message: `Vertex AI error (${response.status}): ${normalized.message}`,
          normalized,
        },
      }
      const outHeaders = new Headers(response.headers)
      outHeaders.set('Content-Type', 'application/json')
      return new Response(JSON.stringify(errorBody), {
        status: response.status,
        headers: outHeaders,
      })
    }

    // Response is standard SSE — pass through directly
    return response
  }
}
