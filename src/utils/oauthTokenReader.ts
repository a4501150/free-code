/**
 * OAuth token reader — leaf module.
 *
 * Reads Claude AI OAuth tokens from env, file-descriptor, or secure storage.
 * Extracted from auth.ts so the provider registry can depend on it without
 * closing the providerRegistry ↔ auth cycle.
 */

import memoize from 'lodash-es/memoize.js'
import type { OAuthTokens } from '../services/oauth/types.js'
import { getOAuthTokenFromFileDescriptor } from './authFileDescriptor.js'
import { isBareMode } from './envUtils.js'
import { logError } from './log.js'
import { getSecureStorage } from './secureStorage/index.js'

export const getClaudeAIOAuthTokens = memoize((): OAuthTokens | null => {
  // --bare: API-key-only. No OAuth env tokens, no keychain, no credentials file.
  if (isBareMode()) return null

  // Check for force-set OAuth token from environment variable
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    // Return an inference-only token (unknown refresh and expiry)
    return {
      accessToken: process.env.CLAUDE_CODE_OAUTH_TOKEN,
      refreshToken: null,
      expiresAt: null,
      scopes: ['user:inference'],
      subscriptionType: null,
      rateLimitTier: null,
    }
  }

  // Check for OAuth token from file descriptor
  const oauthTokenFromFd = getOAuthTokenFromFileDescriptor()
  if (oauthTokenFromFd) {
    // Return an inference-only token (unknown refresh and expiry)
    return {
      accessToken: oauthTokenFromFd,
      refreshToken: null,
      expiresAt: null,
      scopes: ['user:inference'],
      subscriptionType: null,
      rateLimitTier: null,
    }
  }

  try {
    const secureStorage = getSecureStorage()
    const storageData = secureStorage.read()
    const oauthData = storageData?.claudeAiOauth

    if (!oauthData?.accessToken) {
      return null
    }

    return oauthData as import('../services/oauth/types.js').OAuthTokens
  } catch (error) {
    logError(error)
    return null
  }
})
