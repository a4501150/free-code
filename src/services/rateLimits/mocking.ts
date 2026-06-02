/**
 * Facade for rate limit header processing
 * This isolates mock logic from production code
 */

import { stripProviderPrefix } from '../../utils/model/parseModelStringWithRegistry.js'
import { DomainTransportError } from '../api/domain-errors.js'
import {
  applyMockHeaders,
  checkMockFastModeRateLimit,
  getMockHeaderless429Message,
  getMockHeaders,
  isMockFastModeRateLimitScenario,
  shouldProcessMockLimits,
} from './mockScenarios.js'

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
 * Check if mock rate limits should throw a 429 error
 * Returns the error to throw, or null if no error should be thrown
 * @param currentModel The model being used for the current request
 * @param isFastModeActive Whether fast mode is currently active (for fast-mode-only mocks)
 */
export function checkMockRateLimitError(
  currentModel: string,
  isFastModeActive?: boolean,
): DomainTransportError | null {
  if (!shouldProcessMockLimits()) {
    return null
  }

  const headerlessMessage = getMockHeaderless429Message()
  if (headerlessMessage) {
    return createMockRateLimitError(headerlessMessage)
  }

  const mockHeaders = getMockHeaders()
  if (!mockHeaders) {
    return null
  }

  // Check if we should throw a 429 error
  // Only throw if:
  // 1. Status is rejected AND
  // 2. Either no overage headers OR overage is also rejected
  // 3. For Opus-specific limits, only throw if actually using an Opus model
  const status = mockHeaders['anthropic-ratelimit-unified-status']
  const overageStatus =
    mockHeaders['anthropic-ratelimit-unified-overage-status']
  const rateLimitType =
    mockHeaders['anthropic-ratelimit-unified-representative-claim']

  // Check if this is an Opus-specific rate limit
  const isOpusLimit = rateLimitType === 'seven_day_opus'

  // Check if current model is an Opus model after stripping any provider prefix.
  const isUsingOpus = stripProviderPrefix(currentModel)
    .toLowerCase()
    .includes('opus')

  // For Opus limits, only throw 429 if actually using Opus.
  // This simulates the real API behavior where fallback to a non-rate-limited
  // model succeeds.
  if (isOpusLimit && !isUsingOpus) {
    return null
  }

  // Check for mock fast mode rate limits (handles expiry, countdown, etc.)
  if (isMockFastModeRateLimitScenario()) {
    const fastModeHeaders = checkMockFastModeRateLimit(isFastModeActive)
    if (fastModeHeaders === null) {
      return null
    }
    // Create a mock 429 error with the fast mode headers
    const error = createMockRateLimitError(
      'Rate limit exceeded',
      Object.fromEntries(
        Object.entries(fastModeHeaders).filter(([_, v]) => v !== undefined),
      ) as Record<string, string>,
    )
    return error
  }

  const shouldThrow429 =
    status === 'rejected' && (!overageStatus || overageStatus === 'rejected')

  if (shouldThrow429) {
    // Create a mock 429 error with the appropriate headers
    const error = createMockRateLimitError(
      'Rate limit exceeded',
      Object.fromEntries(
        Object.entries(mockHeaders).filter(([_, v]) => v !== undefined),
      ) as Record<string, string>,
    )
    return error
  }

  return null
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
