import { feature } from 'bun:bundle'
import type { QuerySource } from 'src/constants/querySource.js'
import type { SystemAPIErrorMessage } from 'src/types/message.js'
import { isAwsCredentialsProviderError } from 'src/utils/aws.js'
import { logForDebugging } from 'src/utils/debug.js'
import { createSystemAPIErrorMessage } from 'src/utils/messages.js'
import { getProviderRegistry } from 'src/utils/model/providerRegistry.js'
import {
  isClaudeAISubscriber,
  isEnterpriseSubscriber,
} from '../../utils/auth.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { errorMessage } from '../../utils/errors.js'
import {
  type CooldownReason,
  handleFastModeOverageRejection,
  handleFastModeRejectedByAPI,
  isFastModeCooldown,
  isFastModeEnabled,
  triggerFastModeCooldown,
} from '../../utils/fastMode.js'
import { disableKeepAlive } from '../../utils/proxy.js'
import { sleep } from '../../utils/sleep.js'
import type { ThinkingConfig } from '../../utils/thinking.js'
import { isMockRateLimitError } from '../rateLimits/mocking.js'
import { REPEATED_529_ERROR_MESSAGE } from './errors.js'
import { extractConnectionErrorDetails } from './errorUtils.js'
import {
  DomainTransportError,
  DomainConnectionError,
  DomainUserAbortError,
} from './domain-errors.js'

const abortError = () => new DomainUserAbortError()

const DEFAULT_MAX_RETRIES = 10
const MAX_529_RETRIES = 3
export const BASE_DELAY_MS = 500

// Foreground query sources where the user IS blocking on the result — these
// retry on 529. Everything else (summaries, titles, suggestions, classifiers)
// bails immediately: during a capacity cascade each retry is 3-10× gateway
// amplification, and the user never sees those fail anyway. New sources
// default to no-retry — add here only if the user is waiting on the result.
const FOREGROUND_529_RETRY_SOURCES = new Set<QuerySource>([
  'repl_main_thread',
  'sdk',
  'agent:custom',
  'agent:default',
  'agent:builtin',
  'compact',
  'hook_agent',
  'hook_prompt',
  'verification_agent',
  'side_question',
  // Security classifier — must complete for auto-mode correctness.
  // yoloClassifier.ts uses 'auto_mode' (not 'yolo_classifier' — that's type-only).
  'auto_mode',
])

function shouldRetry529(querySource: QuerySource | undefined): boolean {
  // undefined → retry (conservative for untagged call paths)
  return (
    querySource === undefined || FOREGROUND_529_RETRY_SOURCES.has(querySource)
  )
}

// CLAUDE_CODE_UNATTENDED_RETRY: for unattended sessions (ant-only). Retries 429/529
// indefinitely with higher backoff and periodic keep-alive yields so the host
// environment does not mark the session idle mid-wait.
// TODO(ANT-344): the keep-alive via SystemAPIErrorMessage yields is a stopgap
// until there's a dedicated keep-alive channel.
const PERSISTENT_MAX_BACKOFF_MS = 5 * 60 * 1000
const PERSISTENT_RESET_CAP_MS = 6 * 60 * 60 * 1000
const HEARTBEAT_INTERVAL_MS = 30_000

function isPersistentRetryEnabled(): boolean {
  return feature('UNATTENDED_RETRY')
    ? isEnvTruthy(process.env.CLAUDE_CODE_UNATTENDED_RETRY)
    : false
}

function isTransientCapacityError(error: unknown): boolean {
  if (error instanceof DomainTransportError) {
    const k = error.normalized.kind
    return k === 'rate_limit' || k === 'overloaded'
  }
  return false
}

function isStaleConnectionError(error: unknown): boolean {
  if (error instanceof DomainConnectionError) {
    const details = extractConnectionErrorDetails(error)
    return details?.code === 'ECONNRESET' || details?.code === 'EPIPE'
  }
  return false
}

export interface RetryContext {
  model: string
  thinkingConfig: ThinkingConfig
  fastMode?: boolean
}

interface RetryOptions {
  maxRetries?: number
  model: string
  thinkingConfig: ThinkingConfig
  fastMode?: boolean
  signal?: AbortSignal
  querySource?: QuerySource
  prepareRetry?: (error: unknown) => Promise<void> | void
  /**
   * Pre-seed the consecutive 529 counter. Used when this retry loop is a
   * non-streaming fallback after a streaming 529 — the streaming 529 should
   * count toward MAX_529_RETRIES so total 529s-before-fallback is consistent
   * regardless of which request mode hit the overload.
   */
  initialConsecutive529Errors?: number
}

export class CannotRetryError extends Error {
  constructor(
    public readonly originalError: unknown,
    public readonly retryContext: RetryContext,
  ) {
    const message = errorMessage(originalError)
    super(message)
    this.name = 'RetryError'

    // Preserve the original stack trace if available
    if (originalError instanceof Error && originalError.stack) {
      this.stack = originalError.stack
    }
  }
}

export async function* withRetry<T>(
  operation: (attempt: number, context: RetryContext) => Promise<T>,
  options: RetryOptions,
): AsyncGenerator<SystemAPIErrorMessage, T> {
  const maxRetries = getMaxRetries(options)
  const retryContext: RetryContext = {
    model: options.model,
    thinkingConfig: options.thinkingConfig,
    ...(isFastModeEnabled() && { fastMode: options.fastMode }),
  }
  let consecutive529Errors = options.initialConsecutive529Errors ?? 0
  let lastError: unknown
  let persistentAttempt = 0
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    if (options.signal?.aborted) {
      throw new DomainUserAbortError()
    }

    // Capture whether fast mode is active before this attempt
    // (fallback may change the state mid-loop)
    const wasFastModeActive = isFastModeEnabled()
      ? retryContext.fastMode && !isFastModeCooldown()
      : false

    try {
      if (isStaleConnectionError(lastError)) {
        logForDebugging(
          'Stale connection (ECONNRESET/EPIPE) — disabling keep-alive for retry',
        )
        disableKeepAlive()
      }

      if (lastError && options.prepareRetry) {
        await options.prepareRetry(lastError)
      }

      return await operation(attempt, retryContext)
    } catch (error) {
      // Domain abort errors propagate immediately — never retry
      if (error instanceof DomainUserAbortError) throw error

      lastError = error
      logForDebugging(
        `API error (attempt ${attempt}/${maxRetries + 1}): ${error instanceof DomainTransportError ? `${error.status ?? 'stream'} ${error.message}` : errorMessage(error)}`,
        { level: 'error' },
      )

      // Fast mode fallback: on 429/529, either wait and retry (short delays)
      // or fall back to standard speed (long delays) to avoid cache thrashing.
      // Skip in persistent mode: the short-retry path below loops with fast
      // mode still active, so its `continue` never reaches the attempt clamp
      // and the for-loop terminates. Persistent sessions want the chunked
      // keep-alive path instead of fast-mode cache-preservation anyway.
      if (
        wasFastModeActive &&
        !isPersistentRetryEnabled() &&
        isTransientCapacityError(error)
      ) {
        // If the 429 is specifically because extra usage (overage) is not
        // available, permanently disable fast mode with a specific message.
        const overageReason =
          error instanceof DomainTransportError
            ? error.headers?.[
                'anthropic-ratelimit-unified-overage-disabled-reason'
              ]
            : undefined
        if (overageReason !== null && overageReason !== undefined) {
          handleFastModeOverageRejection(overageReason)
          retryContext.fastMode = false
          continue
        }

        const retryAfterMs = getRetryAfterMs(error)
        if (retryAfterMs !== null && retryAfterMs < SHORT_RETRY_THRESHOLD_MS) {
          await sleep(retryAfterMs, options.signal, { abortError })
          continue
        }
        const cooldownMs = Math.max(
          retryAfterMs ?? DEFAULT_FAST_MODE_FALLBACK_HOLD_MS,
          MIN_COOLDOWN_MS,
        )
        const cooldownReason: CooldownReason = is529Error(error)
          ? 'overloaded'
          : 'rate_limit'
        triggerFastModeCooldown(Date.now() + cooldownMs, cooldownReason)
        if (isFastModeEnabled()) {
          retryContext.fastMode = false
        }
        continue
      }

      // Fast mode fallback: if the API rejects the fast mode parameter
      // (e.g., org doesn't have fast mode enabled), permanently disable fast
      // mode and retry at standard speed.
      if (wasFastModeActive && isFastModeNotEnabledError(error)) {
        handleFastModeRejectedByAPI()
        retryContext.fastMode = false
        continue
      }

      // Non-foreground sources bail immediately on 529 — no retry amplification
      // during capacity cascades. User never sees these fail.
      if (is529Error(error) && !shouldRetry529(options.querySource)) {
        throw new CannotRetryError(error, retryContext)
      }

      // Track consecutive 529 errors
      if (is529Error(error)) {
        consecutive529Errors++
        if (consecutive529Errors >= MAX_529_RETRIES) {
          if (!process.env.IS_SANDBOX && !isPersistentRetryEnabled()) {
            throw new CannotRetryError(
              new Error(REPEATED_529_ERROR_MESSAGE),
              retryContext,
            )
          }
        }
      }

      // Only retry if the error indicates we should
      const persistent =
        isPersistentRetryEnabled() && isTransientCapacityError(error)
      if (attempt > maxRetries && !persistent) {
        throw new CannotRetryError(error, retryContext)
      }

      // AWS/GCP credential errors aren't always domain errors, but can be retried.
      // The caller refreshes credentials through prepareRetry before the next attempt.
      const isCloudAuthError =
        isBedrockAuthError(error) || isVertexAuthError(error)
      if (!isCloudAuthError) {
        if (error instanceof DomainTransportError) {
          if (!shouldRetryDomainError(error)) {
            throw new CannotRetryError(error, retryContext)
          }
        } else {
          throw new CannotRetryError(error, retryContext)
        }
      }

      // For other errors, proceed with normal retry logic
      // Get retry-after header if available
      const retryAfter = getRetryAfter(error)
      let delayMs: number
      const is429 =
        error instanceof DomainTransportError && error.status === 429
      if (persistent && is429) {
        persistentAttempt++
        const resetDelay = getRateLimitResetDelayMs(error)
        delayMs =
          resetDelay ??
          Math.min(
            getRetryDelay(
              persistentAttempt,
              retryAfter,
              PERSISTENT_MAX_BACKOFF_MS,
            ),
            PERSISTENT_RESET_CAP_MS,
          )
      } else if (persistent) {
        persistentAttempt++
        // Retry-After is a server directive and bypasses maxDelayMs inside
        // getRetryDelay (intentional — honoring it is correct). Cap at the
        // 6hr reset-cap here so a pathological header can't wait unbounded.
        delayMs = Math.min(
          getRetryDelay(
            persistentAttempt,
            retryAfter,
            PERSISTENT_MAX_BACKOFF_MS,
          ),
          PERSISTENT_RESET_CAP_MS,
        )
      } else {
        delayMs = getRetryDelay(attempt, retryAfter)
      }

      // In persistent mode the for-loop `attempt` is clamped at maxRetries+1;
      // use persistentAttempt for telemetry/yields so they show the true count.
      const reportedAttempt = persistent ? persistentAttempt : attempt

      const errorForMessage =
        error instanceof DomainTransportError
          ? {
              status: error.status,
              message: error.message,
              requestID: error.requestID,
              headers: error.headers,
              cause: error.cause,
            }
          : null

      if (persistent) {
        let remaining = delayMs
        while (remaining > 0) {
          if (options.signal?.aborted) throw new DomainUserAbortError()
          if (errorForMessage) {
            yield createSystemAPIErrorMessage(
              errorForMessage,
              remaining,
              reportedAttempt,
              maxRetries,
            )
          }
          const chunk = Math.min(remaining, HEARTBEAT_INTERVAL_MS)
          await sleep(chunk, options.signal, { abortError })
          remaining -= chunk
        }
        if (attempt >= maxRetries) attempt = maxRetries
      } else {
        if (errorForMessage) {
          yield createSystemAPIErrorMessage(
            errorForMessage,
            delayMs,
            attempt,
            maxRetries,
          )
        }
        await sleep(delayMs, options.signal, { abortError })
      }
    }
  }

  throw new CannotRetryError(lastError, retryContext)
}

function getRetryAfter(error: unknown): string | null {
  if (error instanceof DomainTransportError) {
    return error.headers?.['retry-after'] ?? null
  }
  return null
}

export function getRetryDelay(
  attempt: number,
  retryAfterHeader?: string | null,
  maxDelayMs = 32000,
): number {
  if (retryAfterHeader) {
    const seconds = parseInt(retryAfterHeader, 10)
    if (!isNaN(seconds)) {
      return seconds * 1000
    }
  }

  const baseDelay = Math.min(
    BASE_DELAY_MS * Math.pow(2, attempt - 1),
    maxDelayMs,
  )
  const jitter = Math.random() * 0.25 * baseDelay
  return baseDelay + jitter
}

// TODO: Replace with a response header check once the API adds a dedicated
// header for fast-mode rejection (e.g., x-fast-mode-rejected). String-matching
// the error message is fragile and will break if the API wording changes.
function isFastModeNotEnabledError(error: unknown): boolean {
  if (error instanceof DomainTransportError) {
    return (
      error.status === 400 &&
      (error.message?.includes('Fast mode is not enabled') ?? false)
    )
  }
  return false
}

export function is529Error(error: unknown): boolean {
  if (error instanceof DomainTransportError) {
    return error.normalized.kind === 'overloaded'
  }
  return false
}

function isOAuthTokenRevokedError(error: unknown): boolean {
  if (error instanceof DomainTransportError) {
    return (
      error.status === 403 &&
      (error.message?.includes('OAuth token has been revoked') ?? false)
    )
  }
  return false
}

function isBedrockAuthError(error: unknown): boolean {
  if (getProviderRegistry().getCapabilities().credentialRefresh === 'aws') {
    if (isAwsCredentialsProviderError(error)) return true
    if (error instanceof DomainTransportError && error.status === 403)
      return true
  }
  return false
}

// google-auth-library throws plain Error (no typed name like AWS's
// CredentialsProviderError). Match common SDK-level credential-failure messages.
function isGoogleAuthLibraryCredentialError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const msg = error.message
  return (
    msg.includes('Could not load the default credentials') ||
    msg.includes('Could not refresh access token') ||
    msg.includes('invalid_grant')
  )
}

function isVertexAuthError(error: unknown): boolean {
  if (getProviderRegistry().getCapabilities().credentialRefresh === 'gcp') {
    if (isGoogleAuthLibraryCredentialError(error)) return true
    if (error instanceof DomainTransportError && error.status === 401)
      return true
  }
  return false
}

function shouldRetryDomainError(error: DomainTransportError): boolean {
  // Never retry mock errors - they're from /mock-limits command for testing
  if (isMockRateLimitError(error)) return false

  // Persistent mode: 429/529 always retryable, bypass subscriber gates and
  // x-should-retry header.
  if (isPersistentRetryEnabled() && isTransientCapacityError(error)) return true

  if (error instanceof DomainConnectionError) return true

  // Note this is not a standard header.
  const shouldRetryHeader = error.headers?.['x-should-retry']

  // If the server explicitly says whether or not to retry, obey.
  // For Max and Pro users, should-retry is true, but in several hours, so we shouldn't.
  // Enterprise users can retry because they typically use PAYG instead of rate limits.
  if (
    shouldRetryHeader === 'true' &&
    (!isClaudeAISubscriber() || isEnterpriseSubscriber())
  ) {
    return true
  }
  if (shouldRetryHeader === 'false') return false

  switch (error.normalized.kind) {
    case 'rate_limit':
      return !isClaudeAISubscriber() || isEnterpriseSubscriber()
    case 'overloaded':
    case 'transport':
    case 'server':
      return true
    case 'auth':
      if (error.status === 401) return true
      return isOAuthTokenRevokedError(error)
    case 'invalid_request':
    case 'context_overflow':
    case 'content_filter':
    case 'unknown':
      return false
  }
}

export function getDefaultMaxRetries(): number {
  if (process.env.CLAUDE_CODE_MAX_RETRIES) {
    return parseInt(process.env.CLAUDE_CODE_MAX_RETRIES, 10)
  }
  return DEFAULT_MAX_RETRIES
}
function getMaxRetries(options: RetryOptions): number {
  return options.maxRetries ?? getDefaultMaxRetries()
}

const DEFAULT_FAST_MODE_FALLBACK_HOLD_MS = 30 * 60 * 1000 // 30 minutes
const SHORT_RETRY_THRESHOLD_MS = 20 * 1000 // 20 seconds
const MIN_COOLDOWN_MS = 10 * 60 * 1000 // 10 minutes

function getRetryAfterMs(error: unknown): number | null {
  if (error instanceof DomainTransportError) {
    if (error.retryAfterMs !== undefined) return error.retryAfterMs
    const retryAfter = error.headers?.['retry-after']
    if (retryAfter) {
      const seconds = parseInt(retryAfter, 10)
      if (!isNaN(seconds)) return seconds * 1000
    }
    return error.normalized.retryAfterMs ?? null
  }
  return null
}

function getRateLimitResetDelayMs(error: unknown): number | null {
  let resetHeader: string | undefined | null
  if (error instanceof DomainTransportError) {
    resetHeader = error.headers?.['anthropic-ratelimit-unified-reset']
  }
  if (!resetHeader) return null
  const resetUnixSec = Number(resetHeader)
  if (!Number.isFinite(resetUnixSec)) return null
  const delayMs = resetUnixSec * 1000 - Date.now()
  if (delayMs <= 0) return null
  return Math.min(delayMs, PERSISTENT_RESET_CAP_MS)
}
