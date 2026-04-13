/**
 * Shared utilities for provider fetch adapters.
 */

/**
 * Map an HTTP status code to an Anthropic API error type string.
 * Used by all non-Anthropic adapters to construct error responses
 * that the Anthropic SDK can properly classify.
 */
export function mapStatusToErrorType(status: number): string {
  if (status === 429) return 'rate_limit_error'
  if (status === 529) return 'overloaded_error'
  if (status === 401 || status === 403) return 'authentication_error'
  if (status === 400) return 'invalid_request_error'
  if (status === 404) return 'not_found_error'
  return 'api_error'
}
