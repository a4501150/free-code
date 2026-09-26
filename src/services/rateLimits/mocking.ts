import { DomainTransportError } from '../api/domain-errors.js'
import { applyMockHeaders, shouldProcessMockLimits } from './mockScenarios.js'

/**
 * Process headers, applying mocks if /mock-limits command is active
 */
export function processRateLimitHeaders(
  headers: globalThis.Headers,
): globalThis.Headers {
  // Only apply mocks for Ant employees using /mock-limits command
  if (shouldProcessMockLimits()) {
    return applyMockHeaders(headers)
  }
  return headers
}

/**
 * Check if we should process rate limits (either real subscriber or /mock-limits command)
 */
export function shouldProcessRateLimits(isSubscriber: boolean): boolean {
  return isSubscriber || shouldProcessMockLimits()
}

function createMockRateLimitError(
  message: string,
  headers?: Record<string, string>,
): DomainTransportError {
  const raw = { error: { type: 'rate_limit_error', message } }
  return new DomainTransportError({
    normalized: {
      kind: 'rate_limit',
      message,
      status: 429,
      providerType: 'anthropic',
      raw,
    },
    status: 429,
    headers,
    raw,
  })
}

/**
 * Check if this is a mock 429 error that shouldn't be retried
 */
export function isMockRateLimitError(error: { status?: number }): boolean {
  return shouldProcessMockLimits() && error.status === 429
}

/**
 * Check if /mock-limits command is currently active (for UI purposes)
 */
export { shouldProcessMockLimits }
