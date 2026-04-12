/**
 * Foundry (Azure) Native Adapter
 *
 * Replaces @anthropic-ai/foundry-sdk with a native fetch adapter.
 * Foundry is the simplest adapter — it speaks standard Anthropic Messages
 * API at a different base URL with Azure AD authentication.
 *
 * URL: https://{resource}.services.ai.azure.com/anthropic/v1/messages
 * Auth: either x-api-key header or Azure AD bearer token
 * Body: standard Anthropic format (no transformation needed)
 * Response: standard SSE (no transformation needed)
 *
 * Reference: @anthropic-ai/foundry-sdk/src/client.ts
 */

import type { ProviderConfig } from '../../utils/settings/types.js'

/**
 * Creates a fetch function that intercepts Anthropic SDK calls and routes
 * them to Azure Foundry.
 *
 * @param config Provider config
 * @param getToken Function that returns an Azure AD bearer token (or null if using API key)
 */
export function createFoundryFetch(
  config: ProviderConfig,
  getToken: () => Promise<string | null>,
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  const resource = process.env.ANTHROPIC_FOUNDRY_RESOURCE
  const baseUrl =
    config.baseUrl ||
    process.env.ANTHROPIC_FOUNDRY_BASE_URL ||
    (resource
      ? `https://${resource}.services.ai.azure.com/anthropic`
      : '')

  const apiKey = process.env.ANTHROPIC_FOUNDRY_API_KEY

  return async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input)

    // Only intercept Anthropic API message calls
    if (!url.includes('/v1/messages')) {
      return globalThis.fetch(input, init)
    }

    // Build Foundry URL: replace the base URL portion
    const foundryUrl = `${baseUrl.replace(/\/$/, '')}/v1/messages`

    // Build headers
    const initHeaders = init?.headers as Record<string, string> | undefined
    const requestHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
    }

    // Auth: API key or Azure AD token
    if (apiKey) {
      requestHeaders['x-api-key'] = apiKey
    } else {
      const token = await getToken()
      if (token) {
        requestHeaders['Authorization'] = `Bearer ${token}`
      }
    }

    // Copy through relevant headers
    if (initHeaders) {
      for (const key of [
        'anthropic-version',
        'anthropic-beta',
        'x-app',
        'User-Agent',
        'X-Claude-Code-Session-Id',
        'Accept',
      ]) {
        if (initHeaders[key]) {
          requestHeaders[key] = initHeaders[key]
        }
      }
    }

    // Make the request — body passes through unchanged
    const response = await globalThis.fetch(foundryUrl, {
      method: 'POST',
      headers: requestHeaders,
      body: init?.body,
    })

    if (!response.ok) {
      const errorText = await response.text()
      const errorBody = {
        type: 'error',
        error: {
          type: 'api_error',
          message: `Foundry API error (${response.status}): ${errorText}`,
        },
      }
      return new Response(JSON.stringify(errorBody), {
        status: response.status,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // Response is standard SSE — pass through directly
    return response
  }
}
