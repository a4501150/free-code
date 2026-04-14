/**
 * Shared API constants.
 *
 * Centralizes the Anthropic API version string and base URL resolution
 * so every call site uses the same override chain.
 */

/** Anthropic Messages API version used across all non-SDK HTTP requests. */
export const ANTHROPIC_API_VERSION = '2023-06-01'

/**
 * Returns the Anthropic API base URL, respecting environment overrides.
 *
 * Priority:
 * 1. ANTHROPIC_BASE_URL (standard override for proxies)
 * 2. CLAUDE_CODE_API_BASE_URL (alternate override)
 * 3. https://api.anthropic.com (production default)
 */
export function getApiBaseUrl(): string {
  return (
    process.env.ANTHROPIC_BASE_URL ||
    process.env.CLAUDE_CODE_API_BASE_URL ||
    'https://api.anthropic.com'
  )
}
