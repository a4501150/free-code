import { ANTHROPIC_API_VERSION } from 'src/constants/api.js'
import { getOrganizationUUID } from 'src/services/oauth/client.js'
import { getClaudeAIOAuthTokens } from './auth.js'

// Retry configuration for API requests
const RETRY_DELAYS = [2000, 4000, 8000, 16000] // 4 retries with exponential backoff
const MAX_RETRIES = RETRY_DELAYS.length

/**
 * Creates OAuth headers for API requests
 * @param accessToken The OAuth access token
 * @returns Headers object with Authorization, Content-Type, and anthropic-version
 */
export function getOAuthHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'anthropic-version': ANTHROPIC_API_VERSION,
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
