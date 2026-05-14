import axios from 'axios'
import { getOauthConfig } from 'src/constants/oauth.js'
import type { OAuthProfileResponse } from 'src/services/oauth/types.js'
import { logError } from 'src/utils/log.js'

/**
 * Gets OAuth profile information using an API key for authentication.
 * @returns OAuth profile response or undefined if not available
 */
export async function getOauthProfileFromApiKey(): Promise<
  OAuthProfileResponse | undefined
> {
  return undefined
}

/**
 * Gets OAuth profile information using an OAuth access token.
 * @param accessToken - The OAuth access token for authentication
 * @returns OAuth profile response or undefined if request fails
 */
export async function getOauthProfileFromOauthToken(
  accessToken: string,
): Promise<OAuthProfileResponse | undefined> {
  const endpoint = `${getOauthConfig().BASE_API_URL}/api/oauth/profile`
  try {
    const response = await axios.get<OAuthProfileResponse>(endpoint, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      timeout: 10000,
    })
    return response.data
  } catch (error) {
    logError(error as Error)
  }
}
