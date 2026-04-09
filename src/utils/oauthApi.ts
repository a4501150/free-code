import axios, { type AxiosRequestConfig, type AxiosResponse } from 'axios'
import { getOrganizationUUID } from 'src/services/oauth/client.js'
import { getClaudeAIOAuthTokens } from './auth.js'
import { logForDebugging } from './debug.js'
import { errorMessage } from './errors.js'
import { sleep } from './sleep.js'

// Retry configuration for API requests
const RETRY_DELAYS = [2000, 4000, 8000, 16000] // 4 retries with exponential backoff
const MAX_RETRIES = RETRY_DELAYS.length

/**
 * Checks if an axios error is a transient network error that should be retried
 */
export function isTransientNetworkError(error: unknown): boolean {
  if (!axios.isAxiosError(error)) {
    return false
  }

  // Retry on network errors (no response received)
  if (!error.response) {
    return true
  }

  // Retry on server errors (5xx)
  if (error.response.status >= 500) {
    return true
  }

  // Don't retry on client errors (4xx) - they're not transient
  return false
}

/**
 * Makes an axios GET request with automatic retry for transient network errors
 * Uses exponential backoff: 2s, 4s, 8s, 16s (4 retries = 5 total attempts)
 */
export async function axiosGetWithRetry<T>(
  url: string,
  config?: AxiosRequestConfig,
): Promise<AxiosResponse<T>> {
  let lastError: unknown

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await axios.get<T>(url, config)
    } catch (error) {
      lastError = error

      // Don't retry if this isn't a transient error
      if (!isTransientNetworkError(error)) {
        throw error
      }

      // Don't retry if we've exhausted all retries
      if (attempt >= MAX_RETRIES) {
        logForDebugging(
          `API request failed after ${attempt + 1} attempts: ${errorMessage(error)}`,
        )
        throw error
      }

      const delay = RETRY_DELAYS[attempt] ?? 2000
      logForDebugging(
        `API request failed (attempt ${attempt + 1}/${MAX_RETRIES + 1}), retrying in ${delay}ms: ${errorMessage(error)}`,
      )
      await sleep(delay)
    }
  }

  throw lastError
}

/**
 * Creates OAuth headers for API requests
 * @param accessToken The OAuth access token
 * @returns Headers object with Authorization, Content-Type, and anthropic-version
 */
export function getOAuthHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
  }
}

/**
 * Validates and prepares for API requests
 * @returns Object containing access token and organization UUID
 */
export async function prepareApiRequest(): Promise<{
  accessToken: string
  orgUUID: string
}> {
  const accessToken = getClaudeAIOAuthTokens()?.accessToken
  if (accessToken === undefined) {
    throw new Error(
      'Claude Code web sessions require authentication with a Claude.ai account. API key authentication is not sufficient. Please run /login to authenticate, or check your authentication status with /status.',
    )
  }

  const orgUUID = await getOrganizationUUID()
  if (!orgUUID) {
    throw new Error('Unable to get organization UUID')
  }

  return { accessToken, orgUUID }
}

/**
 * Content for a remote session message.
 * Accepts a plain string or an array of content blocks (text, image, etc.)
 * following the Anthropic API messages spec.
 */
export type RemoteMessageContent =
  | string
  | Array<{ type: string; [key: string]: unknown }>
