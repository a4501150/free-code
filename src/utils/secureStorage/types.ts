/**
 * Data blob stored on disk (plaintext fallback) or in the OS keychain.
 *
 * The concrete namespaces observed in the codebase are enumerated as
 * optional fields (oauthAccount, pluginSecrets, mcpOAuth, claudeAiOauth,
 * xaaIdp, …) but new callers may add arbitrary top-level keys; the
 * index signature keeps the shape open without collapsing to `any`.
 */
export type SecureStorageData = {
  /** OAuth account metadata (anonymized user id, etc.). */
  oauthAccount?: {
    accountUuid?: string
    emailAddress?: string
    organizationUuid?: string
    [key: string]: unknown
  }
  /** Claude.ai OAuth tokens. */
  claudeAiOauth?: {
    accessToken?: string
    refreshToken?: string
    expiresAt?: number
    scopes?: string[]
    [key: string]: unknown
  }
  /** Per-MCP-server OAuth token cache. Keyed by server identifier. */
  mcpOAuth?: Record<
    string,
    {
      serverName?: string
      serverUrl?: string
      accessToken?: string
      refreshToken?: string
      expiresAt?: number
      scope?: string
      tokenType?: string
      stepUpScope?: string
      clientId?: string
      clientSecret?: string
      idToken?: string
      discoveryState?: {
        authorizationServerUrl?: string
        resourceMetadataUrl?: string
        [key: string]: unknown
      }
      [key: string]: unknown
    }
  >
  /** Pre-configured MCP OAuth client credentials, keyed by server identifier. */
  mcpOAuthClientConfig?: Record<
    string,
    {
      clientId?: string
      clientSecret?: string
      [key: string]: unknown
    }
  >
  /** Cached XAA IdP id_tokens, keyed by issuer. */
  mcpXaaIdp?: Record<
    string,
    {
      idToken: string
      expiresAt: number
      [key: string]: unknown
    }
  >
  /** Pre-configured XAA IdP client secrets, keyed by issuer. */
  mcpXaaIdpConfig?: Record<
    string,
    {
      clientSecret?: string
      [key: string]: unknown
    }
  >
  /** Plugin-provided sensitive configuration values, keyed by plugin id. */
  pluginSecrets?: Record<string, Record<string, string>>
  [key: string]: unknown
}

/**
 * Storage back-end contract. Implementations include plainTextStorage,
 * macOsKeychainStorage, and fallbackStorage.
 */
export type SecureStorage = {
  /** Human-readable name — used in debug/error logs. */
  readonly name: string
  read(): SecureStorageData | null
  readAsync(): Promise<SecureStorageData | null>
  update(data: SecureStorageData): { success: boolean; warning?: string }
  delete(): boolean | void
}
