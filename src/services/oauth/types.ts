/**
 * OAuth-related types for the Claude.ai OAuth flow. Field names mirror
 * the wire response shapes used in src/services/oauth/client.ts and
 * stored back into SecureStorageData.claudeAiOauth via
 * src/utils/auth.ts:saveOAuthTokensIfNeeded.
 */

/** Server-issued subscription plan. `null` = unknown / API-only user. */
export type SubscriptionType = 'pro' | 'max' | 'team' | 'enterprise'

/** Rate-limit tier assigned by the server. */
export type RateLimitTier =
  | 'default_claude_max_5x'
  | 'default_claude_max_20x'
  | string

/** Billing backend. */
export type BillingType =
  | 'stripe_subscription'
  | 'stripe_subscription_contracted'
  | 'apple_subscription'
  | 'google_play_subscription'
  | string

/** Raw response from `/api/oauth/profile` and `/api/claude_cli_profile`. */
export type OAuthProfileResponse = {
  account: {
    uuid: string
    email: string
    display_name?: string | null
    created_at?: string
    has_claude_max?: boolean
    has_claude_pro?: boolean
  }
  organization: {
    uuid: string
    organization_type?:
      | 'claude_max'
      | 'claude_pro'
      | 'claude_team'
      | 'claude_enterprise'
      | string
    has_extra_usage_enabled?: boolean | null
    billing_type?: BillingType | null
    rate_limit_tier?: RateLimitTier | null
    subscription_created_at?: string | null
  }
}

/** Payload returned by the server on `/oauth/token` (authorization_code / refresh_token). */
export type OAuthTokenExchangeResponse = {
  access_token: string
  refresh_token?: string
  expires_in: number
  scope?: string
  token_type?: string
  account?: {
    uuid: string
    email_address: string
  }
  organization?: {
    uuid: string
  }
}

/** Response from `/api/oauth/profile/roles`. */
export type UserRolesResponse = {
  organization_role?: string
  workspace_role?: string
  organization_name?: string
}

/**
 * The OAuth token blob we persist locally.
 *
 * `refreshToken` / `expiresAt` are nullable to accommodate
 * "inference-only" tokens sourced from CLAUDE_CODE_OAUTH_TOKEN or file
 * descriptor — those have no refresh path and never expire locally.
 */
export type OAuthTokens = {
  accessToken: string
  refreshToken: string | null
  expiresAt: number | null
  scopes: string[]
  subscriptionType: SubscriptionType | null
  rateLimitTier: RateLimitTier | null
  /** Populated on the fresh login path so installOAuthTokens can skip a refetch. */
  profile?: OAuthProfileResponse
  /** Fallback account metadata taken from the token-exchange response. */
  tokenAccount?: {
    uuid: string
    emailAddress: string
    organizationUuid?: string
  }
}
