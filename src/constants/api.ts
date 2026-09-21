/**
 * Shared API constants.
 *
 * Centralizes the Anthropic API version string and base URL resolution
 * so every call site uses the correct override chain.
 */

/** Anthropic Messages API version used across all non-SDK HTTP requests. */
export const ANTHROPIC_API_VERSION = '2023-06-01'

/** Header name for client-generated request IDs used by the Anthropic adapter. */
export const CLIENT_REQUEST_ID_HEADER = 'x-client-request-id'

import { getInitialSettings } from '../utils/settings/settings.js'

const ANTHROPIC_DEFAULT_URL = 'https://api.anthropic.com'

/**
 * Base URL for Anthropic control-plane endpoints (telemetry, MCP registry,
 * feedback, domain info, metrics opt-out). These are internal service
 * endpoints that should always reach the Anthropic API, not a LiteLLM or
 * Messages API proxy.
 */
export function getAnthropicControlPlaneUrl(): string {
  return getInitialSettings().controlPlaneBaseUrl ?? ANTHROPIC_DEFAULT_URL
}

/**
 * Base URL for Anthropic public API endpoints that are not the Messages API
 * (currently: /v1/files). Follows the control-plane override since these
 * are real Anthropic API calls.
 */
export function getAnthropicFilesApiUrl(): string {
  return getAnthropicControlPlaneUrl()
}
