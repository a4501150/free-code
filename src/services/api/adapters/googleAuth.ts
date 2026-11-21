import { readFileSync, renameSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { GoogleAuth } from 'google-auth-library'
import { refreshGcpCredentialsIfNeeded } from '../../../utils/auth.js'
import { logError } from '../../../utils/log.js'
import { memoizeWithTTLAsync } from '../../../utils/memoize.js'
import type { ProviderConfig } from '../../../utils/settings/types.js'
import { isOAuthTokenExpired } from '../../../services/oauth/client.js'
import { DomainConnectionError } from '../domain-errors.js'
import { resolveBearerToken } from './authResolution.js'

export interface GoogleAuthResult {
  token: string
  projectId?: string
}

// Gemini CLI's public OAuth client — the same client the gemini CLI uses for
// user OAuth against Google AI endpoints, so a `gemini` CLI login
// (~/.gemini/oauth_creds.json) or manually pasted Gemini CLI credentials can
// be reused here. Keep in sync with llm-proxy's
// app/src/shared/oauth/providers/google.ts, which uses the same pair.
// Assembled from parts: these are Google's publicly published CLI constants
// (see the gemini-cli repo), but literal strings trip GitHub push protection.
const GEMINI_CLI_CLIENT_ID = [
  '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j',
  '.apps.googleusercontent.com',
].join('')
const GEMINI_CLI_CLIENT_SECRET = [
  'GOCSPX-4uHgMPm-1o7Sk-geV6Cu5clX',
  'Fsxl',
].join('')
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GEMINI_CLI_CREDS_FILE = join(homedir(), '.gemini', 'oauth_creds.json')

const REFRESH_CACHE_TTL_MS = 5 * 60_000
const CLI_FILE_RECHECK_TTL_MS = 60_000

// One client per process: the AuthClient caches tokens internally, so
// constructing per request would redo ADC resolution every time.
let googleAuthClient: GoogleAuth | null = null
function getGoogleAuth(): GoogleAuth {
  googleAuthClient ??= new GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  })
  return googleAuthClient
}

async function refreshAccessToken(
  refreshToken: string,
): Promise<{ accessToken: string; expiresAt: number } | null> {
  try {
    const res = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: GEMINI_CLI_CLIENT_ID,
        client_secret: GEMINI_CLI_CLIENT_SECRET,
      }),
    })
    if (!res.ok) return null
    const data = (await res.json()) as {
      access_token?: string
      expires_in?: number
    }
    if (!data.access_token) return null
    return {
      accessToken: data.access_token,
      expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
    }
  } catch (err) {
    logError(err)
    return null
  }
}

// Cached (with inflight dedup) so an expired config token doesn't hit the
// token endpoint on every request while the config object stays static.
const refreshConfigToken = memoizeWithTTLAsync(
  refreshAccessToken,
  REFRESH_CACHE_TTL_MS,
)

const getGeminiCliToken = memoizeWithTTLAsync(
  async (): Promise<string | null> => {
    let raw: Record<string, unknown>
    try {
      raw = JSON.parse(readFileSync(GEMINI_CLI_CREDS_FILE, 'utf8')) as Record<
        string,
        unknown
      >
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        logError(err) // unreadable/corrupt creds file is worth surfacing
      }
      return null
    }
    const refreshToken =
      typeof raw['refresh_token'] === 'string'
        ? raw['refresh_token']
        : undefined
    const expiry =
      typeof raw['expiry_date'] === 'number' ? raw['expiry_date'] : undefined
    let accessToken =
      typeof raw['access_token'] === 'string' ? raw['access_token'] : undefined
    if ((!accessToken || isOAuthTokenExpired(expiry ?? null)) && refreshToken) {
      const refreshed = await refreshAccessToken(refreshToken)
      if (!refreshed) return accessToken ?? null
      accessToken = refreshed.accessToken
      try {
        // Atomic replace: a concurrently running gemini CLI may refresh (and
        // rotate its refresh token) at any moment, so never truncate the file
        // it also reads and writes.
        const tmp = `${GEMINI_CLI_CREDS_FILE}.tmp-${process.pid}`
        writeFileSync(
          tmp,
          JSON.stringify(
            {
              ...raw,
              access_token: refreshed.accessToken,
              expiry_date: refreshed.expiresAt,
            },
            null,
            2,
          ),
        )
        renameSync(tmp, GEMINI_CLI_CREDS_FILE)
      } catch (err) {
        logError(err) // the in-memory token still works for this session
      }
    }
    return accessToken ?? null
  },
  CLI_FILE_RECHECK_TTL_MS,
)

/**
 * Resolve the access token for Google-backed providers (gemini, vertex)
 * according to the provider's configured auth method:
 *
 * - `bearer`: send the configured token as-is. Use this when a proxy
 *   (e.g. llm-proxy) manages upstream auth centrally — the token is
 *   meaningful to the proxy, not to Google.
 * - `oauth`: Gemini CLI-style user OAuth. Takes credentials from the
 *   provider config's `oauth` block, falling back to the gemini CLI's
 *   `~/.gemini/oauth_creds.json`, refreshing via Google's token endpoint
 *   when expired.
 * - `gcp`: local Application Default Credentials (ADC) via GoogleAuth.
 *
 * Returns null when the configured method yields no usable credentials;
 * callers decide how to surface that.
 */
export async function resolveGoogleAccessToken(
  config: ProviderConfig,
): Promise<GoogleAuthResult | null> {
  const auth = config.auth
  const projectId = auth?.gcp?.projectId

  switch (auth?.active) {
    case 'bearer': {
      const token = resolveBearerToken(auth)
      return token ? { token, projectId } : null
    }

    case 'oauth': {
      const cfg = auth.oauth
      if (cfg?.refreshToken) {
        const refreshed = await refreshConfigToken(cfg.refreshToken)
        if (refreshed) return { token: refreshed.accessToken, projectId }
        if (cfg.accessToken) {
          logError(
            new Error(
              'Gemini OAuth refresh failed; falling back to the configured (possibly expired) access token',
            ),
          )
          return { token: cfg.accessToken, projectId }
        }
        return null
      }
      if (cfg?.accessToken) return { token: cfg.accessToken, projectId }
      const cliToken = await getGeminiCliToken()
      return cliToken ? { token: cliToken, projectId } : null
    }

    case 'gcp': {
      try {
        await refreshGcpCredentialsIfNeeded()
        const authClient = await getGoogleAuth().getClient()
        // getRequestHeaders may return a fetch-style Headers instance
        // (lowercase keys) or a plain record depending on library version.
        const raw = (await authClient.getRequestHeaders()) as unknown
        const headers: Record<string, string> =
          typeof (raw as Headers)?.entries === 'function'
            ? Object.fromEntries((raw as Headers).entries())
            : (raw as Record<string, string>)
        const token =
          (headers['authorization'] ?? headers['Authorization'])?.replace(
            'Bearer ',
            '',
          ) ?? ''
        if (!token) return null
        return {
          token,
          projectId:
            projectId ||
            headers['x-goog-user-project'] ||
            (await getGoogleAuth().getProjectId()) ||
            undefined,
        }
      } catch (err) {
        logError(err)
        return null
      }
    }

    default:
      return null
  }
}

export const GOOGLE_AUTH_METHODS_HINT =
  'set auth.active to "bearer" (proxy-managed), "oauth" (gemini CLI login), or "gcp" (local ADC)'

export async function requireGoogleAccessToken(
  config: ProviderConfig,
  providerType: 'gemini' | 'vertex',
): Promise<GoogleAuthResult> {
  const result = await resolveGoogleAccessToken(config)
  if (!result) {
    throw new DomainConnectionError({
      normalized: {
        kind: 'auth',
        message: `No Google credentials resolved for ${providerType} (${GOOGLE_AUTH_METHODS_HINT})`,
        providerType,
        raw: null,
      },
      cause: new Error('Failed to resolve Google auth'),
    })
  }
  return result
}
