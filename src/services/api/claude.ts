import type {
  DomainAssistantContent,
  DomainContentBlock,
  DomainReasoningBlock,
  DomainStreamEvent,
  DomainUsage,
} from '../../types/domain.js'
import type {
  DomainMessageParam,
  DomainMessageRequest,
  DomainMessageResponse,
  DomainStreamingResponse,
  DomainSystemBlock,
  DomainToolChoice,
  DomainToolDefinition,
} from './domain-transport.js'
import {
  getAdapterForModel,
  getProviderConfigForModel,
} from './adapters/index.js'
import { randomUUID } from 'crypto'
import { getProviderRegistry } from 'src/utils/model/providerRegistry.js'
import { stripProviderPrefix } from 'src/utils/model/parseModelStringWithRegistry.js'
import {
  getAttributionHeader,
  getCLISyspromptPrefix,
} from '../../constants/system.js'
import {
  getEmptyToolPermissionContext,
  type QueryChainTracking,
  type ToolPermissionContext,
  type Tools,
} from '../../Tool.js'
import type { AgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js'
import {
  type ConnectorTextBlock,
  type ConnectorTextDelta,
  isConnectorTextBlock,
} from '../../types/connectorText.js'
import type {
  AssistantMessage,
  Message,
  StreamEvent,
  SystemAPIErrorMessage,
  UserMessage,
} from '../../types/message.js'
import { toolToAPISchema } from '../../utils/toolSchemas.js'
import { type CacheScope, splitSysPromptPrefix } from './systemPromptBlocks.js'
import {
  clearApiKeyHelperCache,
  clearAwsCredentialsCache,
  clearGcpCredentialsCache,
  getClaudeAIOAuthTokens,
  getOauthAccountInfo,
  handleOAuth401Error,
} from '../../utils/auth.js'
import {
  getBodyBetas,
  getMergedBetas,
  getModelBetas,
} from '../../utils/betas.js'
import { getOrCreateUserID } from '../../utils/config.js'
import { getModelMaxOutputTokens } from '../../utils/context.js'
import { resolveAppliedEffort } from '../../utils/effort.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { errorMessage } from '../../utils/errors.js'
import { computeFingerprintFromMessages } from '../../utils/fingerprint.js'
import { sleep } from '../../utils/sleep.js'
import { captureAPIRequest, logError } from '../../utils/log.js'
import {
  createAssistantAPIErrorMessage,
  createSystemAPIErrorMessage,
  createUserMessage,
  ensureToolResultPairing,
  normalizeContentFromAPI,
  normalizeMessagesForAPI,
  stripAdvisorBlocks,
  stripForeignReasoningBlocks,
} from '../../utils/messages.js'
import { getSmallFastModel } from '../../utils/model/model.js'
import {
  asSystemPrompt,
  type SystemPrompt,
} from '../../utils/systemPromptType.js'
import { tokenCountFromLastAPIResponse } from '../../utils/tokens.js'
import {
  currentLimits,
  extractQuotaStatusFromError,
  extractQuotaStatusFromHeaders,
} from '../claudeAiLimits.js'
import { getAPIContextManagement } from '../compact/apiMicrocompact.js'
import { isAutoModeActive } from '../../utils/permissions/autoModeState.js'

import { feature } from 'bun:bundle'
import {
  DomainTransportError,
  DomainConnectionError,
  DomainConnectionTimeoutError,
  DomainUserAbortError,
} from './domain-errors.js'
import {
  getAfkModeHeaderLatched,
  getFastModeHeaderLatched,
  getLastApiCompletionTimestamp,
  getSessionId,
  setAfkModeHeaderLatched,
  setFastModeHeaderLatched,
  setLastMainRequestId,
} from 'src/bootstrap/state.js'
import {
  AFK_MODE_BETA_HEADER,
  CONTEXT_MANAGEMENT_BETA_HEADER,
  EFFORT_BETA_HEADER,
  FAST_MODE_BETA_HEADER,
  PROMPT_CACHING_SCOPE_BETA_HEADER,
  STRUCTURED_OUTPUTS_BETA_HEADER,
  TASK_BUDGETS_BETA_HEADER,
} from 'src/constants/betas.js'
import {
  isAgenticQuerySource,
  type QuerySource,
} from 'src/constants/querySource.js'
import type { Notification } from 'src/context/notifications.js'
import { addToTotalSessionCost } from 'src/cost-tracker.js'
import { getInitialSettings } from 'src/utils/settings/settings.js'
import type { AgentId } from 'src/types/ids.js'
import { isAwsCredentialsProviderError } from 'src/utils/aws.js'
import {
  ADVISOR_TOOL_INSTRUCTIONS,
  getExperimentAdvisorModels,
  isAdvisorEnabled,
  isValidAdvisorModel,
  modelSupportsAdvisor,
} from 'src/utils/advisor.js'
import { getAgentContext } from 'src/utils/agentContext.js'
import { withAgenticSystemPromptInvariantsForQuery } from 'src/utils/agenticSystemPrompt.js'
import {
  modelSupportsStructuredOutputs,
  shouldIncludeFirstPartyOnlyBetas,
  shouldUseGlobalCacheScope,
} from 'src/utils/betas.js'
import { getMaxThinkingTokensForModel } from 'src/utils/context.js'
import { logForDebugging } from 'src/utils/debug.js'
import { logForDiagnosticsNoPII } from 'src/utils/diagLogs.js'
import {
  type EffortLevel,
  type EffortValue,
  modelSupportsEffort,
} from 'src/utils/effort.js'
import {
  isFastModeAvailable,
  isFastModeCooldown,
  isFastModeEnabled,
  isFastModeSupportedByModel,
} from 'src/utils/fastMode.js'
import { returnValue } from 'src/utils/generators.js'
import { headlessProfilerCheckpoint } from 'src/utils/headlessProfiler.js'
import { calculateUSDCost } from 'src/utils/modelCost.js'
import { endQueryProfile, queryCheckpoint } from 'src/utils/queryProfiler.js'
import {
  modelSupportsAdaptiveThinking,
  modelSupportsThinking,
  type ThinkingConfig,
} from 'src/utils/thinking.js'
import { API_MAX_MEDIA_PER_REQUEST } from '../../constants/apiLimits.js'
import { ADVISOR_BETA_HEADER } from '../../constants/betas.js'
import { safeParseJSON } from '../../utils/json.js'
import {
  normalizeModelStringForAPI,
  parseUserSpecifiedModel,
} from '../../utils/model/model.js'
import { getInferenceProfileBackingModel } from '../../utils/model/bedrock.js'
import {
  startSessionActivity,
  stopSessionActivity,
} from '../../utils/sessionActivity.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import {
  isBetaTracingEnabled,
  type LLMRequestNewContext,
  startLLMRequestSpan,
} from '../../utils/telemetry/sessionTracing.js'
import { withStreamingVCR, withVCR } from '../vcr.js'
import {
  API_ERROR_MESSAGE_PREFIX,
  getAssistantMessageFromError,
  getErrorMessageIfRefusal,
} from './errors.js'
import {
  EMPTY_USAGE,
  type GlobalCacheStrategy,
  logAPIError,
  logAPIQuery,
  logAPISuccessAndDuration,
  type NonNullableUsage,
} from './logging.js'
import {
  checkResponseForCacheBreak,
  recordPromptState,
} from './promptCacheBreakDetection.js'
import {
  CannotRetryError,
  getRetryDelay,
  is529Error,
  type RetryContext,
  withRetry,
} from './withRetry.js'

// Define a type that represents valid JSON values
type JsonValue = string | number | boolean | null | JsonObject | JsonArray
type JsonObject = { [key: string]: JsonValue }
type JsonArray = JsonValue[]

type OutputConfig = Record<string, unknown> & {
  effort?: string
  format?: Record<string, unknown>
}

/**
 * Assemble the extra body parameters for the API request, based on the
 * CLAUDE_CODE_EXTRA_BODY environment variable if present and on any beta
 * headers (primarily for Bedrock requests).
 *
 * @param betaHeaders - An array of beta headers to include in the request.
 * @returns A JSON object representing the extra body parameters.
 */
export function getExtraBodyParams(betaHeaders?: string[]): JsonObject {
  // Parse user's extra body parameters first
  const extraBodyStr = process.env.CLAUDE_CODE_EXTRA_BODY
  let result: JsonObject = {}

  if (extraBodyStr) {
    try {
      // Parse as JSON, which can be null, boolean, number, string, array or object
      const parsed = safeParseJSON(extraBodyStr)
      // We expect an object with key-value pairs to spread into API parameters
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        // Shallow clone — safeParseJSON is LRU-cached and returns the same
        // object reference for the same string. Mutating `result` below
        // would poison the cache, causing stale values to persist.
        result = { ...(parsed as JsonObject) }
      } else {
        logForDebugging(
          `CLAUDE_CODE_EXTRA_BODY env var must be a JSON object, but was given ${extraBodyStr}`,
          { level: 'error' },
        )
      }
    } catch (error) {
      logForDebugging(
        `Error parsing CLAUDE_CODE_EXTRA_BODY: ${errorMessage(error)}`,
        { level: 'error' },
      )
    }
  }

  // Handle beta headers if provided
  if (betaHeaders && betaHeaders.length > 0) {
    if (result.anthropic_beta && Array.isArray(result.anthropic_beta)) {
      // Add to existing array, avoiding duplicates
      const existingHeaders = result.anthropic_beta as string[]
      const newHeaders = betaHeaders.filter(
        header => !existingHeaders.includes(header),
      )
      result.anthropic_beta = [...existingHeaders, ...newHeaders]
    } else {
      // Create new array with the beta headers
      result.anthropic_beta = betaHeaders
    }
  }

  return result
}

export function getPromptCachingEnabled(model: string): boolean {
  // Global disable takes precedence
  if (isEnvTruthy(process.env.DISABLE_PROMPT_CACHING)) return false

  // Per-provider caching: if the provider's cache type is 'none' or
  // 'automatic-prefix', disable explicit cache_control markers.
  // Only 'explicit-breakpoint' providers use our cache markers.
  const cacheType = getProviderRegistry().getProviderCacheType(model)
  if (cacheType === 'none' || cacheType === 'automatic-prefix') return false

  // Check if we should disable for small/fast model
  if (isEnvTruthy(process.env.DISABLE_PROMPT_CACHING_HAIKU)) {
    const smallFastModel = getSmallFastModel()
    if (model === smallFastModel) return false
  }

  const bareModel = stripProviderPrefix(model).toLowerCase()

  // Check if we should disable for Sonnet models
  if (isEnvTruthy(process.env.DISABLE_PROMPT_CACHING_SONNET)) {
    if (bareModel.includes('sonnet')) return false
  }

  // Check if we should disable for Opus models
  if (isEnvTruthy(process.env.DISABLE_PROMPT_CACHING_OPUS)) {
    if (bareModel.includes('opus')) return false
  }

  return true
}

import { getCacheControl } from '../../utils/cacheControl.js'
export { getCacheControl }

/**
 * Configure effort parameters for API request.
 *
 */
function configureEffortParams(
  effortValue: EffortValue | undefined,
  outputConfig: OutputConfig,
  extraBodyParams: Record<string, unknown>,
  betas: string[],
  model: string,
): void {
  if (!modelSupportsEffort(model) || 'effort' in outputConfig) {
    return
  }

  if (effortValue === undefined) {
    betas.push(EFFORT_BETA_HEADER)
  } else if (typeof effortValue === 'string') {
    // Send string effort level as is (SDK accepts low|medium|high|max; xhigh
    // tier is ant-internal and never reaches this path in OSS builds).
    outputConfig.effort = effortValue as 'low' | 'medium' | 'high' | 'max'
    betas.push(EFFORT_BETA_HEADER)
  }
}

// output_config.task_budget — API-side token budget awareness for the model.
// Define the wire shape locally because task_budget remains a beta API field.
// The API validates on receipt; see
// api/api/schemas/messages/request/output_config.py:12-39 in the monorepo.
// Beta: task-budgets-2026-03-13 (EAP, claude-strudel-eap only as of Mar 2026).
type TaskBudgetParam = {
  type: 'tokens'
  total: number
  remaining?: number
}

export function configureTaskBudgetParams(
  taskBudget: Options['taskBudget'],
  outputConfig: OutputConfig & { task_budget?: TaskBudgetParam },
  betas: string[],
): void {
  if (
    !taskBudget ||
    'task_budget' in outputConfig ||
    !shouldIncludeFirstPartyOnlyBetas()
  ) {
    return
  }
  outputConfig.task_budget = {
    type: 'tokens',
    total: taskBudget.total,
    ...(taskBudget.remaining !== undefined && {
      remaining: taskBudget.remaining,
    }),
  }
  if (!betas.includes(TASK_BUDGETS_BETA_HEADER)) {
    betas.push(TASK_BUDGETS_BETA_HEADER)
  }
}

export function getAPIMetadata() {
  // https://docs.google.com/document/d/1dURO9ycXXQCBS0V4Vhl4poDBRgkelFc5t2BNPoEgH5Q/edit?tab=t.0#heading=h.5g7nec5b09w5
  let extra: JsonObject = {}
  const extraStr = process.env.CLAUDE_CODE_EXTRA_METADATA
  if (extraStr) {
    const parsed = safeParseJSON(extraStr, false)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      extra = parsed as JsonObject
    } else {
      logForDebugging(
        `CLAUDE_CODE_EXTRA_METADATA env var must be a JSON object, but was given ${extraStr}`,
        { level: 'error' },
      )
    }
  }

  return {
    user_id: jsonStringify({
      ...extra,
      device_id: getOrCreateUserID(),
      // Only include OAuth account UUID when actively using OAuth authentication
      account_uuid: getOauthAccountInfo()?.accountUuid ?? '',
      session_id: getSessionId(),
    }),
  }
}

function isOAuthTokenRevokedError(error: unknown): boolean {
  return (
    error instanceof DomainTransportError &&
    error.status === 403 &&
    error.message.includes('OAuth token has been revoked')
  )
}

function isGoogleAuthLibraryCredentialError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return (
    error.message.includes('Could not load the default credentials') ||
    error.message.includes('Could not refresh access token') ||
    error.message.includes('invalid_grant')
  )
}

export async function prepareRetry(error: unknown): Promise<void> {
  if (error instanceof DomainTransportError && error.status === 401) {
    clearApiKeyHelperCache()
  }

  if (
    error instanceof DomainTransportError &&
    (error.status === 401 || isOAuthTokenRevokedError(error))
  ) {
    const failedAccessToken = getClaudeAIOAuthTokens()?.accessToken
    if (failedAccessToken) {
      await handleOAuth401Error(failedAccessToken)
    }
  }

  const credentialRefresh =
    getProviderRegistry().getCapabilities().credentialRefresh
  if (
    credentialRefresh === 'aws' &&
    (isAwsCredentialsProviderError(error) ||
      (error instanceof DomainTransportError && error.status === 403))
  ) {
    clearAwsCredentialsCache()
  }
  if (
    credentialRefresh === 'gcp' &&
    (isGoogleAuthLibraryCredentialError(error) ||
      (error instanceof DomainTransportError && error.status === 401))
  ) {
    clearGcpCredentialsCache()
  }
}

function extractQuotaStatusFromRetryError(error: unknown): void {
  if (error instanceof DomainTransportError) {
    extractQuotaStatusFromError(error)
  }
}

function getRetryErrorRequestId(error: unknown): string | undefined {
  return error instanceof DomainTransportError ? error.requestID : undefined
}

export async function verifyApiKey(
  apiKey: string,
  isNonInteractiveSession: boolean,
): Promise<boolean> {
  // Skip API verification if running in print mode (isNonInteractiveSession)
  if (isNonInteractiveSession) {
    return true
  }

  try {
    // WARNING: if you change this to use a non-Haiku model, this request will fail in 1P unless it uses getCLISyspromptPrefix.
    const model = getSmallFastModel()
    const betas = getModelBetas(model)
    return await returnValue(
      withRetry(
        async () => {
          const adapter = getAdapterForModel(model)
          const baseConfig = getProviderConfigForModel(model)
          const verifyConfig = {
            ...baseConfig,
            auth: {
              ...baseConfig.auth,
              active: 'apiKey' as const,
              apiKey: { key: apiKey },
            },
          }

          const request: DomainMessageRequest = {
            model,
            messages: [
              {
                role: 'user' as const,
                content: [{ type: 'text' as const, text: 'test' }],
              },
            ],
            maxTokens: 1,
            temperature: 1,
            ...(betas.length > 0 && { betas }),
            metadata: getAPIMetadata(),
            ...getExtraBodyParams(),
          }

          await adapter.createMessage(
            verifyConfig,
            request,
            AbortSignal.timeout(30_000),
          )
          return true
        },
        {
          maxRetries: 2,
          model,
          thinkingConfig: { type: 'disabled' },
          prepareRetry,
        },
      ),
    )
  } catch (errorFromRetry) {
    let error = errorFromRetry
    if (errorFromRetry instanceof CannotRetryError) {
      error = errorFromRetry.originalError
    }
    logError(error)
    // Check for authentication error
    if (
      (error instanceof DomainTransportError &&
        error.normalized.kind === 'auth') ||
      (error instanceof Error &&
        error.message.includes(
          '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
        ))
    ) {
      return false
    }
    throw error
  }
}

export function userMessageToMessageParam(
  message: UserMessage,
  addCache = false,
  enablePromptCaching: boolean,
  querySource?: QuerySource,
): DomainMessageParam {
  if (addCache) {
    if (typeof message.message.content === 'string') {
      return {
        role: 'user',
        content: [
          {
            type: 'text',
            text: message.message.content,
            ...(enablePromptCaching && {
              cache_control: getCacheControl({ querySource }),
            }),
          },
        ],
      }
    } else {
      return {
        role: 'user',
        content: message.message.content.map((block, i) => ({
          ...block,
          ...(i === message.message.content.length - 1
            ? enablePromptCaching
              ? { cache_control: getCacheControl({ querySource }) }
              : {}
            : {}),
        })),
      }
    }
  }
  // Clone array content to prevent in-place mutations (e.g., insertCacheEditsBlock's
  // splice) from contaminating the original message. Without cloning, multiple calls
  // to addCacheBreakpoints share the same array and each splices in duplicate cache_edits.
  return {
    role: 'user',
    content: Array.isArray(message.message.content)
      ? message.message.content.map(block => block)
      : [{ type: 'text', text: message.message.content }],
  }
}

export function assistantMessageToMessageParam(
  message: AssistantMessage,
  addCache = false,
  enablePromptCaching: boolean,
  querySource?: QuerySource,
): DomainMessageParam {
  if (addCache) {
    if (typeof message.message.content === 'string') {
      return {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: message.message.content,
            ...(enablePromptCaching && {
              cache_control: getCacheControl({ querySource }),
            }),
          },
        ],
      }
    } else {
      return {
        role: 'assistant',
        content: message.message.content.map((block, i) => ({
          ...block,
          ...(i === message.message.content.length - 1 &&
          block.type !== 'reasoning' &&
          block.type !== 'redacted_reasoning' &&
          (feature('CONNECTOR_TEXT') ? !isConnectorTextBlock(block) : true)
            ? enablePromptCaching
              ? { cache_control: getCacheControl({ querySource }) }
              : {}
            : {}),
        })),
      }
    }
  }
  return {
    role: 'assistant',
    content: message.message.content.map(block => block),
  }
}

export type Options = {
  getToolPermissionContext: () => Promise<ToolPermissionContext>
  model: string
  toolChoice?: DomainToolChoice
  isNonInteractiveSession: boolean
  extraToolSchemas?: DomainToolDefinition[]
  maxOutputTokensOverride?: number
  onStreamingFallback?: () => void
  onStreamingRecovery?: (
    messages: AssistantMessage[],
    error: DomainTransportError,
  ) => boolean
  querySource: QuerySource
  agents: AgentDefinition[]
  allowedAgentTypes?: string[]
  hasAppendSystemPrompt: boolean
  fetchOverride?: typeof globalThis.fetch
  enablePromptCaching?: boolean
  skipCacheWrite?: boolean
  temperatureOverride?: number
  effortValue?: EffortValue
  mcpTools: Tools
  hasPendingMcpServers?: boolean
  queryTracking?: QueryChainTracking
  agentId?: AgentId // Only set for subagents
  outputFormat?: Record<string, unknown>
  fastMode?: boolean
  advisorModel?: string
  addNotification?: (notif: Notification) => void
  // API-side task budget (output_config.task_budget). Sent to the API
  // so the model can pace itself. `remaining` is computed by the caller
  // (query.ts decrements across the agentic loop).
  taskBudget?: { total: number; remaining?: number }
}

export async function queryModelWithoutStreaming({
  messages,
  systemPrompt,
  thinkingConfig,
  tools,
  signal,
  options,
}: {
  messages: Message[]
  systemPrompt: SystemPrompt
  thinkingConfig: ThinkingConfig
  tools: Tools
  signal: AbortSignal
  options: Options
}): Promise<AssistantMessage> {
  // Store the assistant message but continue consuming the generator to ensure
  // logAPISuccessAndDuration gets called (which happens after all yields)
  let assistantMessage: AssistantMessage | undefined
  for await (const message of withStreamingVCR(messages, async function* () {
    yield* queryModel(
      messages,
      systemPrompt,
      thinkingConfig,
      tools,
      signal,
      options,
    )
  })) {
    if (message.type === 'assistant') {
      assistantMessage = message
    }
  }
  if (!assistantMessage) {
    // If the signal was aborted, throw the provider-neutral abort error instead
    // of a generic error so callers can handle cancellation gracefully.
    if (signal.aborted) {
      throw new DomainUserAbortError()
    }
    throw new Error('No assistant message found')
  }
  return assistantMessage
}

export async function* queryModelWithStreaming({
  messages,
  systemPrompt,
  thinkingConfig,
  tools,
  signal,
  options,
}: {
  messages: Message[]
  systemPrompt: SystemPrompt
  thinkingConfig: ThinkingConfig
  tools: Tools
  signal: AbortSignal
  options: Options
}): AsyncGenerator<
  StreamEvent | AssistantMessage | SystemAPIErrorMessage,
  void
> {
  return yield* withStreamingVCR(messages, async function* () {
    yield* queryModel(
      messages,
      systemPrompt,
      thinkingConfig,
      tools,
      signal,
      options,
    )
  })
}

/**
 * Per-attempt timeout for non-streaming fallback requests, in milliseconds.
 * Reads API_TIMEOUT_MS when set so slow backends and the streaming path
 * share the same ceiling.
 *
 * Remote sessions default to 120s to stay under CCR's container idle-kill
 * (~5min) so a hung fallback to a wedged backend surfaces a clean
 * DomainConnectionTimeoutError instead of stalling past SIGKILL.
 *
 * Otherwise defaults to 300s — long enough for slow backends without
 * approaching the API's 10-minute non-streaming boundary.
 */
function getNonstreamingFallbackTimeoutMs(): number {
  const override = parseInt(process.env.API_TIMEOUT_MS || '', 10)
  if (override) return override
  return 300_000
}

const MIDSTREAM_MAX_RETRIES = 5
const STREAM_FIRST_EVENT_WARNING_MS = 60_000
const STREAM_FIRST_EVENT_TIMEOUT_MS = 300_000
const STREAM_BETWEEN_EVENTS_WARNING_MS = 15_000
const STREAM_BETWEEN_EVENTS_TIMEOUT_MS = 30_000
const STREAM_IDLE_TIMEOUT_ERROR = 'Stream idle timeout - no chunks received'

function isStreamIdleTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.message === STREAM_IDLE_TIMEOUT_ERROR
}

// Provider-agnostic: a stream that ended mid-response is flagged by the adapter
// via `stream_truncated` on the normalized error's raw payload. Recovery is
// further gated on provider-confirmed output, so providers that emit neither
// signal simply fall through to the generic mid-stream retry below.
export function isStreamTruncationError(
  error: unknown,
): error is DomainTransportError {
  return (
    error instanceof DomainTransportError &&
    error.normalized.kind === 'transport' &&
    typeof error.normalized.raw === 'object' &&
    error.normalized.raw !== null &&
    (error.normalized.raw as { stream_truncated?: boolean })
      .stream_truncated === true
  )
}

// Generic domain-event idle watchdog. Opt-in only: the Codex adapter performs
// its own raw-stream idle detection (`readUpstream`), so enabling this for
// openai-responses would run a second, racing timer that reclassifies
// truncations as `mid_stream` and defeats recovery. Providers without an
// adapter-level watchdog can turn this on via CLAUDE_ENABLE_STREAM_WATCHDOG.
function shouldEnableStreamWatchdog(): boolean {
  return isEnvTruthy(process.env.CLAUDE_ENABLE_STREAM_WATCHDOG)
}

function getStreamFirstEventTimeoutMs(): number {
  return (
    parseInt(process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS || '', 10) ||
    STREAM_FIRST_EVENT_TIMEOUT_MS
  )
}

function getStreamBetweenEventsTimeoutMs(): number {
  return (
    parseInt(process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS || '', 10) ||
    STREAM_BETWEEN_EVENTS_TIMEOUT_MS
  )
}

/**
 * Unified mid-stream retry predicate. Retries transport, server, overloaded,
 * and rate_limit errors for ALL providers — not just Codex. Also retries
 * stream idle timeout errors (watchdog fired) regardless of provider.
 */
function isRetryableMidStreamError(error: unknown): boolean {
  if (isStreamIdleTimeoutError(error)) return true

  if (error instanceof DomainConnectionError) return true
  if (!(error instanceof DomainTransportError)) return false
  switch (error.normalized.kind) {
    case 'transport':
    case 'server':
    case 'overloaded':
    case 'rate_limit':
      return true
    default:
      return false
  }
}

/**
 * Helper generator for non-streaming API requests.
 * Encapsulates the common pattern of creating a withRetry generator,
 * iterating to yield system messages, and returning the final domain response.
 */
export async function* executeNonStreamingRequest(
  clientOptions: { model: string; source: string },
  retryOptions: {
    model: string
    thinkingConfig: ThinkingConfig
    fastMode?: boolean
    signal: AbortSignal
    initialConsecutive529Errors?: number
    querySource?: QuerySource
  },
  paramsFromContext: (context: RetryContext) => DomainMessageRequest,
  onAttempt: (attempt: number, start: number, maxOutputTokens: number) => void,
  captureRequest: (request: DomainMessageRequest) => void,
  /**
   * Request ID of the failed streaming attempt this fallback is recovering
   * from. Emitted in tengu_nonstreaming_fallback_error for funnel correlation.
   */
  originatingRequestId?: string | null,
  fetchOverride?: typeof globalThis.fetch,
): AsyncGenerator<SystemAPIErrorMessage, DomainMessageResponse> {
  const fallbackTimeoutMs = getNonstreamingFallbackTimeoutMs()
  const generator = withRetry(
    async (attempt, context) => {
      const start = Date.now()
      const domainRequest = paramsFromContext(context)
      captureRequest(domainRequest)
      onAttempt(attempt, start, domainRequest.maxTokens)

      const adjustedRequest = adjustDomainRequestForNonStreaming(
        domainRequest,
        MAX_NON_STREAMING_TOKENS,
      )
      const adapter = getAdapterForModel(clientOptions.model)
      const providerConfig = getProviderConfigForModel(clientOptions.model)
      const timeoutController = new AbortController()
      const timeoutId = setTimeout(
        () => timeoutController.abort(),
        fallbackTimeoutMs,
      )
      const userAbortHandler = () => timeoutController.abort()
      if (retryOptions.signal.aborted) {
        timeoutController.abort()
      } else {
        retryOptions.signal.addEventListener('abort', userAbortHandler)
      }

      try {
        return await adapter.createMessage(
          providerConfig,
          adjustedRequest,
          timeoutController.signal,
          fetchOverride,
        )
      } catch (error) {
        // User aborts are not errors — re-throw immediately without logging.
        if (
          error instanceof DomainUserAbortError &&
          retryOptions.signal.aborted
        ) {
          throw error
        }

        // Instrumentation: record when the non-streaming request errors (including
        // timeouts). Lets us distinguish "fallback hung past container kill"
        // (no event) from "fallback hit the bounded timeout" (this event).
        logForDiagnosticsNoPII('error', 'cli_nonstreaming_fallback_error')
        if (
          error instanceof DomainUserAbortError &&
          timeoutController.signal.aborted
        ) {
          throw new DomainConnectionTimeoutError({
            normalized: {
              kind: 'transport',
              message: 'Request timed out',
              providerType: adapter.providerType,
              raw: error,
            },
            cause: error,
            raw: error,
          })
        }
        throw error
      } finally {
        clearTimeout(timeoutId)
        retryOptions.signal.removeEventListener('abort', userAbortHandler)
      }
    },
    {
      model: retryOptions.model,
      thinkingConfig: retryOptions.thinkingConfig,
      ...(isFastModeEnabled() && { fastMode: retryOptions.fastMode }),
      signal: retryOptions.signal,
      initialConsecutive529Errors: retryOptions.initialConsecutive529Errors,
      querySource: retryOptions.querySource,
      prepareRetry,
    },
  )

  let e
  do {
    e = await generator.next()
    if (!e.done && e.value.type === 'system') {
      yield e.value
    }
  } while (!e.done)

  return e.value as DomainMessageResponse
}

/**
 * Extracts the request ID from the most recent assistant message in the
 * conversation. Used to link consecutive API requests in analytics so we can
 * join them for cache-hit-rate analysis and incremental token tracking.
 *
 * Deriving this from the message array (rather than global state) ensures each
 * query chain (main thread, subagent, teammate) tracks its own request chain
 * independently, and rollback/undo naturally updates the value.
 */
function getPreviousRequestIdFromMessages(
  messages: Message[],
): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!
    if (msg.type === 'assistant' && msg.requestId) {
      return msg.requestId
    }
  }
  return undefined
}

function isMedia(block: unknown): boolean {
  return (
    !!block &&
    typeof block === 'object' &&
    ((block as { type?: string }).type === 'image' ||
      (block as { type?: string }).type === 'document')
  )
}

function isToolResult(
  block: unknown,
): block is { type: 'tool_result'; content?: unknown[] } {
  return (
    !!block &&
    typeof block === 'object' &&
    (block as { type?: string }).type === 'tool_result'
  )
}

/**
 * Ensures messages contain at most `limit` media items (images + documents).
 * Strips oldest media first to preserve the most recent.
 */
export function stripExcessMediaItems(
  messages: (UserMessage | AssistantMessage)[],
  limit: number,
): (UserMessage | AssistantMessage)[] {
  let toRemove = 0
  for (const msg of messages) {
    if (!Array.isArray(msg.message.content)) continue
    for (const block of msg.message.content) {
      if (isMedia(block)) toRemove++
      if (isToolResult(block) && Array.isArray(block.content)) {
        for (const nested of block.content) {
          if (isMedia(nested)) toRemove++
        }
      }
    }
  }
  toRemove -= limit
  if (toRemove <= 0) return messages

  return messages.map(msg => {
    if (toRemove <= 0) return msg
    const content = msg.message.content
    if (!Array.isArray(content)) return msg

    const before = toRemove
    const stripped = content
      .map(block => {
        if (
          toRemove <= 0 ||
          !isToolResult(block) ||
          !Array.isArray(block.content)
        )
          return block
        const filtered = block.content.filter(n => {
          if (toRemove > 0 && isMedia(n)) {
            toRemove--
            return false
          }
          return true
        })
        return filtered.length === block.content.length
          ? block
          : { ...block, content: filtered }
      })
      .filter(block => {
        if (toRemove > 0 && isMedia(block)) {
          toRemove--
          return false
        }
        return true
      })

    return before === toRemove
      ? msg
      : {
          ...msg,
          message: { ...msg.message, content: stripped },
        }
  }) as (UserMessage | AssistantMessage)[]
}

async function* queryModel(
  messages: Message[],
  systemPrompt: SystemPrompt,
  thinkingConfig: ThinkingConfig,
  tools: Tools,
  signal: AbortSignal,
  options: Options,
): AsyncGenerator<
  StreamEvent | AssistantMessage | SystemAPIErrorMessage,
  void
> {
  // Derive previous request ID from the last assistant message in this query chain.
  // This is scoped per message array (main thread, subagent, teammate each have their own),
  // so concurrent agents don't clobber each other's request chain tracking.
  // Also naturally handles rollback/undo since removed messages won't be in the array.
  const previousRequestId = getPreviousRequestIdFromMessages(messages)

  const registry = getProviderRegistry()
  const resolvedModel =
    registry.getProviderType(options.model) === 'bedrock-converse' &&
    options.model.includes('application-inference-profile')
      ? ((await getInferenceProfileBackingModel(options.model)) ??
        options.model)
      : options.model
  queryCheckpoint('query_tool_schema_build_start')
  const isAgenticQuery = isAgenticQuerySource(options.querySource)
  const betas = getMergedBetas(options.model, { isAgenticQuery })

  // Always send the advisor beta header when advisor is enabled, so
  // non-agentic queries (compact, side_question, extract_memories, etc.)
  // can parse advisor server_tool_use blocks already in the conversation history.
  if (isAdvisorEnabled()) {
    betas.push(ADVISOR_BETA_HEADER)
  }

  let advisorModel: string | undefined
  if (isAgenticQuery && isAdvisorEnabled()) {
    let advisorOption = options.advisorModel

    const advisorExperiment = getExperimentAdvisorModels()
    if (advisorExperiment !== undefined) {
      if (
        normalizeModelStringForAPI(advisorExperiment.baseModel) ===
        normalizeModelStringForAPI(options.model)
      ) {
        // Override the advisor model if the base model matches. We
        // should only have experiment models if the user cannot
        // configure it themselves.
        advisorOption = advisorExperiment.advisorModel
      }
    }

    if (advisorOption) {
      const normalizedAdvisorModel = normalizeModelStringForAPI(
        parseUserSpecifiedModel(advisorOption),
      )
      if (!modelSupportsAdvisor(options.model)) {
        logForDebugging(
          `[AdvisorTool] Skipping advisor - base model ${options.model} does not support advisor`,
        )
      } else if (!isValidAdvisorModel(normalizedAdvisorModel)) {
        logForDebugging(
          `[AdvisorTool] Skipping advisor - ${normalizedAdvisorModel} is not a valid advisor model`,
        )
      } else {
        advisorModel = normalizedAdvisorModel
        logForDebugging(
          `[AdvisorTool] Server-side tool enabled with ${advisorModel} as the advisor model`,
        )
      }
    }
  }

  const filteredTools: Tools = tools

  const useGlobalCacheFeature = shouldUseGlobalCacheScope(options.model)
  // MCP tools are per-user → dynamic tool section → can't globally cache.
  const needsToolBasedCacheMarker =
    useGlobalCacheFeature && filteredTools.some(t => t.isMcp === true)

  // Ensure prompt_caching_scope beta header is present when global cache is enabled.
  if (
    useGlobalCacheFeature &&
    !betas.includes(PROMPT_CACHING_SCOPE_BETA_HEADER)
  ) {
    betas.push(PROMPT_CACHING_SCOPE_BETA_HEADER)
  }

  // Determine global cache strategy for logging
  const globalCacheStrategy: GlobalCacheStrategy = useGlobalCacheFeature
    ? needsToolBasedCacheMarker
      ? 'none'
      : 'system_prompt'
    : 'none'

  const toolSchemas = await Promise.all(
    filteredTools.map(tool =>
      toolToAPISchema(tool, {
        getToolPermissionContext: options.getToolPermissionContext,
        tools: filteredTools,
        agents: options.agents,
        allowedAgentTypes: options.allowedAgentTypes,
        model: options.model,
      }),
    ),
  )

  queryCheckpoint('query_tool_schema_build_end')

  // Normalize messages before building system prompt (needed for fingerprinting)
  // Instrumentation: Track message count before normalization

  queryCheckpoint('query_message_normalization_start')
  let messagesForAPI = normalizeMessagesForAPI(messages, filteredTools)
  queryCheckpoint('query_message_normalization_end')

  // Strip reasoning blocks that don't belong to the target provider.
  // Each provider only accepts its own opaque continuation data: Anthropic-wire
  // providers (including Vertex and Foundry) need signed thinking blocks,
  // OpenAI Responses needs encrypted reasoning with a reasoningId, Bedrock and
  // Gemini need their own signatures, and OpenAI-compatible endpoints need to
  // have told us which reasoning field they use.
  messagesForAPI = stripForeignReasoningBlocks(
    messagesForAPI,
    registry.getProviderType(options.model),
    registry.getCapability(options.model, 'preservesReasoningAcrossTurns'),
  )

  // Repair tool_use/tool_result pairing mismatches that can occur when resuming
  // remote/teleport sessions. Inserts synthetic error tool_results for orphaned
  // tool_uses and strips orphaned tool_results referencing non-existent tool_uses.
  messagesForAPI = ensureToolResultPairing(messagesForAPI)

  // Strip advisor blocks — the API rejects them without the beta header.
  if (!betas.includes(ADVISOR_BETA_HEADER)) {
    messagesForAPI = stripAdvisorBlocks(messagesForAPI)
  }

  // Strip excess media items before making the API call.
  // The API rejects requests with >100 media items but returns a confusing error.
  // Rather than erroring (which is hard to recover from in Cowork/CCD), we
  // silently drop the oldest media items to stay within the limit.
  messagesForAPI = stripExcessMediaItems(
    messagesForAPI,
    API_MAX_MEDIA_PER_REQUEST,
  )

  // Instrumentation: Track message count after normalization

  // Compute fingerprint from first user message for attribution.
  // Must run before injecting synthetic messages so the fingerprint reflects
  // the actual user input.
  const fingerprint = computeFingerprintFromMessages(messagesForAPI)

  systemPrompt = withAgenticSystemPromptInvariantsForQuery(
    systemPrompt,
    options.querySource,
  )

  systemPrompt = asSystemPrompt(
    [
      registry.isAnthropicType(options.model)
        ? getAttributionHeader(fingerprint)
        : '',
      getCLISyspromptPrefix(),
      ...systemPrompt,
      ...(advisorModel ? [ADVISOR_TOOL_INSTRUCTIONS] : []),
    ].filter(Boolean),
  )

  const enablePromptCaching =
    options.enablePromptCaching ?? getPromptCachingEnabled(options.model)
  const system = buildSystemPromptBlocks(systemPrompt, enablePromptCaching, {
    skipGlobalCacheForSystemPrompt: needsToolBasedCacheMarker,
    querySource: options.querySource,
    model: options.model,
  })
  const useBetas = betas.length > 0

  // Build minimal context for detailed tracing (when beta tracing is enabled)
  // Note: The actual new_context message extraction is done in sessionTracing.ts using
  // hash-based tracking per querySource (agent) from the messagesForAPI array
  const extraToolSchemas = [...(options.extraToolSchemas ?? [])]
  if (advisorModel) {
    // Server tools must be in the tools array by API contract. Appended after
    // toolSchemas (which carries the cache_control marker) so toggling /advisor
    // only churns the small suffix, not the cached prefix.
    extraToolSchemas.push({
      type: 'advisor_20260301',
      name: 'advisor',
      model: advisorModel,
    })
  }
  const allTools: DomainToolDefinition[] = [...toolSchemas, ...extraToolSchemas]

  const isFastMode =
    isFastModeEnabled() &&
    isFastModeAvailable() &&
    !isFastModeCooldown() &&
    isFastModeSupportedByModel(options.model) &&
    !!options.fastMode

  // Sticky-on latches for dynamic beta headers. Each header, once first
  // sent, keeps being sent for the rest of the session so mid-session
  // toggles don't change the server-side cache key and bust ~50-70K tokens.
  // Latches are cleared on /clear and /compact via clearBetaHeaderLatches().
  // Per-call gates (isAgenticQuery, querySource===repl_main_thread) stay
  // per-call so non-agentic queries keep their own stable header set.

  let afkHeaderLatched = getAfkModeHeaderLatched() === true
  if (
    !afkHeaderLatched &&
    isAgenticQuery &&
    shouldIncludeFirstPartyOnlyBetas() &&
    isAutoModeActive()
  ) {
    afkHeaderLatched = true
    setAfkModeHeaderLatched(true)
  }

  let fastModeHeaderLatched = getFastModeHeaderLatched() === true
  if (!fastModeHeaderLatched && isFastMode) {
    fastModeHeaderLatched = true
    setFastModeHeaderLatched(true)
  }

  const effort = resolveAppliedEffort(options.model, options.effortValue)

  if (feature('PROMPT_CACHE_BREAK_DETECTION')) {
    // Capture everything that could affect the server-side cache key.
    // Pass latched header values (not live state) so break detection
    // reflects what we actually send, not what the user toggled.
    recordPromptState({
      system,
      toolSchemas: allTools,
      querySource: options.querySource,
      model: options.model,
      agentId: options.agentId,
      fastMode: fastModeHeaderLatched,
      globalCacheStrategy,
      betas,
      autoModeActive: afkHeaderLatched,
      isUsingOverage: currentLimits.isUsingOverage ?? false,
      effortValue: effort,
      extraBodyParams: getExtraBodyParams(),
    })
  }

  const newContext: LLMRequestNewContext | undefined = isBetaTracingEnabled()
    ? {
        systemPrompt: systemPrompt.join('\n\n'),
        querySource: options.querySource,
        tools: jsonStringify(allTools),
      }
    : undefined

  // Capture the span so we can pass it to endLLMRequestSpan later
  // This ensures responses are matched to the correct request when multiple requests run in parallel
  const llmSpan = startLLMRequestSpan(
    options.model,
    newContext,
    messagesForAPI,
    isFastMode,
  )

  const startIncludingRetries = Date.now()
  let start = Date.now()
  let attemptNumber = 0
  const attemptStartTimes: number[] = []
  let domainStreamResponse: DomainStreamingResponse | undefined = undefined
  let streamRequestId: string | null | undefined = undefined
  let clientRequestId: string | undefined = undefined

  function releaseStreamResources(): void {
    if (domainStreamResponse) {
      domainStreamResponse.release()
      domainStreamResponse = undefined
    }
  }

  // Capture the betas sent in the last API request, including the ones that
  // were dynamically added, so we can log and send it to telemetry.
  let lastRequestBetas: string[] | undefined

  const domainParamsFromContext = (
    retryContext: RetryContext,
  ): DomainMessageRequest => {
    const betasParams = [...betas]

    const bedrockBetas = registry.getCapability(
      retryContext.model,
      'betasInBody',
    )
      ? getBodyBetas(retryContext.model)
      : []
    const extraBodyParams = getExtraBodyParams(bedrockBetas)

    const outputConfig: OutputConfig = {
      ...((extraBodyParams.output_config as OutputConfig) ?? {}),
    }

    configureEffortParams(
      effort,
      outputConfig,
      extraBodyParams,
      betasParams,
      options.model,
    )

    configureTaskBudgetParams(
      options.taskBudget,
      outputConfig as OutputConfig & { task_budget?: TaskBudgetParam },
      betasParams,
    )

    if (options.outputFormat && !('format' in outputConfig)) {
      outputConfig.format = options.outputFormat as Record<string, unknown>
      if (
        modelSupportsStructuredOutputs(options.model) &&
        !betasParams.includes(STRUCTURED_OUTPUTS_BETA_HEADER)
      ) {
        betasParams.push(STRUCTURED_OUTPUTS_BETA_HEADER)
      }
    }

    const maxOutputTokens =
      options.maxOutputTokensOverride || getModelMaxOutputTokens(options.model)

    const hasThinking =
      thinkingConfig.type !== 'disabled' &&
      !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_THINKING)
    let thinking: DomainMessageRequest['thinking'] | undefined = undefined

    // IMPORTANT: Do not change the adaptive-vs-budget thinking selection below
    // without notifying the model launch DRI and research. This is a sensitive
    // setting that can greatly affect model quality and bashing.
    if (hasThinking && modelSupportsThinking(options.model)) {
      if (
        !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING) &&
        modelSupportsAdaptiveThinking(options.model)
      ) {
        thinking = { type: 'adaptive' }
      } else {
        let thinkingBudget = getMaxThinkingTokensForModel(options.model)
        if (
          thinkingConfig.type === 'enabled' &&
          thinkingConfig.budgetTokens !== undefined
        ) {
          thinkingBudget = thinkingConfig.budgetTokens
        }
        thinkingBudget = Math.min(maxOutputTokens - 1, thinkingBudget)
        thinking = { type: 'enabled', budgetTokens: thinkingBudget }
      }
    }

    const contextManagement = getAPIContextManagement({
      hasThinking,
    })

    const enablePromptCaching =
      options.enablePromptCaching ?? getPromptCachingEnabled(retryContext.model)

    let speed: string | undefined
    const isFastModeForRetry =
      isFastModeEnabled() &&
      isFastModeAvailable() &&
      !isFastModeCooldown() &&
      isFastModeSupportedByModel(options.model) &&
      !!retryContext.fastMode
    if (isFastModeForRetry) {
      speed = 'fast'
    }
    if (fastModeHeaderLatched && !betasParams.includes(FAST_MODE_BETA_HEADER)) {
      betasParams.push(FAST_MODE_BETA_HEADER)
    }

    const supportsAfk = registry.resolveFirstPartyCapability(
      undefined,
      'supportsAfkMode',
    )
    if (
      afkHeaderLatched &&
      supportsAfk &&
      shouldIncludeFirstPartyOnlyBetas() &&
      isAgenticQuery &&
      !betasParams.includes(AFK_MODE_BETA_HEADER)
    ) {
      betasParams.push(AFK_MODE_BETA_HEADER)
    }

    const temperature = !hasThinking
      ? (options.temperatureOverride ?? 1)
      : undefined

    lastRequestBetas = betasParams

    // Build extra body params (excluding output_config which we handle separately)
    const { output_config: _oc, ...restExtraBody } = extraBodyParams

    const domainRequest: DomainMessageRequest = {
      model: normalizeModelStringForAPI(options.model),
      messages: addCacheBreakpoints(
        messagesForAPI,
        enablePromptCaching,
        options.querySource,
        options.skipCacheWrite,
      ),
      system,
      tools: allTools,
      toolChoice: options.toolChoice,
      maxTokens: maxOutputTokens,
      ...(useBetas && { betas: betasParams }),
      ...(registry.isAnthropicType(retryContext.model) && {
        metadata: getAPIMetadata(),
      }),
      ...(thinking && { thinking }),
      ...(temperature !== undefined && { temperature }),
      ...(contextManagement &&
        useBetas &&
        betasParams.includes(CONTEXT_MANAGEMENT_BETA_HEADER) && {
          contextManagement,
        }),
      ...(Object.keys(restExtraBody).length > 0 && {
        extraBody: restExtraBody,
      }),
      ...(Object.keys(outputConfig).length > 0 && {
        outputConfig,
      }),
      ...(speed !== undefined && { speed }),
      ...(previousRequestId && { previousRequestId }),
      ...(advisorModel && { advisorModel }),
    }

    return domainRequest
  }

  // Compute log scalars synchronously so the fire-and-forget .then() closure
  // captures only primitives instead of domainParamsFromContext's full closure
  // scope (messagesForAPI, system, allTools, betas — the entire request-building
  // context), which would otherwise be pinned until the promise resolves.
  {
    const queryParams = domainParamsFromContext({
      model: options.model,
      thinkingConfig,
    })
    const logMessagesLength = queryParams.messages.length
    const logBetas = useBetas ? (queryParams.betas ?? []) : []
    const logThinkingType = queryParams.thinking?.type ?? 'disabled'
    const logEffortValue = queryParams.outputConfig?.effort as
      | EffortLevel
      | undefined
    void options.getToolPermissionContext().then(permissionContext => {
      logAPIQuery({
        model: options.model,
        messagesLength: logMessagesLength,
        temperature: options.temperatureOverride ?? 1,
        betas: logBetas,
        permissionMode: permissionContext.mode,
        querySource: options.querySource,
        queryTracking: options.queryTracking,
        thinkingType: logThinkingType,
        effortValue: logEffortValue,
        fastMode: isFastMode,
        previousRequestId,
      })
    })
  }

  const newMessages: AssistantMessage[] = []
  const providerConfirmedMessages: AssistantMessage[] = []
  let ttftMs = 0
  let partialMessage: DomainAssistantContent | undefined = undefined
  const contentBlocks: (ConnectorTextBlock | DomainContentBlock)[] = []
  let usage: NonNullableUsage = EMPTY_USAGE
  let costUSD = 0
  let stopReason: DomainAssistantContent['stop_reason'] = null
  let didFallBackToNonStreaming = false
  let fallbackMessage: AssistantMessage | undefined
  let maxOutputTokens = 0
  let responseHeaders: globalThis.Headers | undefined = undefined

  let isFastModeRequest = isFastMode // Keep separate state as it may change if falling back
  let isAdvisorInProgress = false

  startSessionActivity('api_call')
  try {
    for (let midstreamRetryAttempt = 0; ; midstreamRetryAttempt++) {
      const generator = withRetry(
        async (attempt, context) => {
          attemptNumber = attempt
          isFastModeRequest = context.fastMode ?? false
          start = Date.now()
          attemptStartTimes.push(start)

          clientRequestId = registry.getCapability(
            context.model,
            'clientRequestId',
          )
            ? randomUUID()
            : undefined

          const domainRequest = {
            ...domainParamsFromContext(context),
            ...(clientRequestId && { clientRequestId }),
          }
          captureAPIRequest(domainRequest, options.querySource) // Capture for bug reports

          maxOutputTokens = domainRequest.maxTokens

          queryCheckpoint('query_api_request_sent')
          if (!options.agentId) {
            headlessProfilerCheckpoint('api_request_sent')
          }

          // Route through the provider adapter's createStream
          const adapter = getAdapterForModel(options.model)
          const providerConfig = getProviderConfigForModel(options.model)
          // biome-ignore lint/plugin: main conversation loop handles attribution separately
          const adapterResponse = await adapter.createStream(
            providerConfig,
            domainRequest,
            signal,
            options.fetchOverride,
          )
          queryCheckpoint('query_response_headers_received')
          domainStreamResponse = adapterResponse
          streamRequestId = adapterResponse.requestId ?? null
          return adapterResponse
        },
        {
          model: options.model,
          thinkingConfig,
          ...(isFastModeEnabled() ? { fastMode: isFastMode } : false),
          signal,
          querySource: options.querySource,
          prepareRetry,
        },
      )

      let e
      do {
        e = await generator.next()

        // yield API error messages (DomainStreamingResponse has 'stream' property, error messages don't)
        if (!('stream' in e.value)) {
          yield e.value
        }
      } while (!e.done)
      const streamingResponse = e.value as DomainStreamingResponse

      // reset state
      newMessages.length = 0
      providerConfirmedMessages.length = 0
      ttftMs = 0
      partialMessage = undefined
      contentBlocks.length = 0
      usage = EMPTY_USAGE
      stopReason = null
      isAdvisorInProgress = false

      // Streaming idle timeout watchdog: use a conservative first-event guard,
      // then a tighter post-first-event guard for stale streams.
      const streamWatchdogEnabled = shouldEnableStreamWatchdog()
      const streamFirstEventTimeoutMs = getStreamFirstEventTimeoutMs()
      const streamBetweenEventsTimeoutMs = getStreamBetweenEventsTimeoutMs()
      let hasReceivedStreamEvent = false
      let streamIdleAborted = false
      // performance.now() snapshot when watchdog fires, for measuring abort propagation delay
      let streamWatchdogFiredAt: number | null = null
      let streamIdleWarningTimer: ReturnType<typeof setTimeout> | null = null
      let streamIdleTimer: ReturnType<typeof setTimeout> | null = null
      function clearStreamIdleTimers(): void {
        if (streamIdleWarningTimer !== null) {
          clearTimeout(streamIdleWarningTimer)
          streamIdleWarningTimer = null
        }
        if (streamIdleTimer !== null) {
          clearTimeout(streamIdleTimer)
          streamIdleTimer = null
        }
      }
      function resetStreamIdleTimer(): void {
        clearStreamIdleTimers()
        if (!streamWatchdogEnabled) {
          return
        }
        const warningMs = hasReceivedStreamEvent
          ? STREAM_BETWEEN_EVENTS_WARNING_MS
          : STREAM_FIRST_EVENT_WARNING_MS
        const timeoutMs = hasReceivedStreamEvent
          ? streamBetweenEventsTimeoutMs
          : streamFirstEventTimeoutMs
        const phase = hasReceivedStreamEvent
          ? 'between stream events'
          : 'before first stream event'
        if (warningMs < timeoutMs) {
          streamIdleWarningTimer = setTimeout(
            warnMs => {
              logForDebugging(
                `Streaming idle warning: no chunks received for ${warnMs / 1000}s ${phase}`,
                { level: 'warn' },
              )
              logForDiagnosticsNoPII('warn', 'cli_streaming_idle_warning')
            },
            warningMs,
            warningMs,
          )
        }
        streamIdleTimer = setTimeout(() => {
          streamIdleAborted = true
          streamWatchdogFiredAt = performance.now()
          logForDebugging(
            `Streaming idle timeout: no chunks received for ${timeoutMs / 1000}s ${phase}, aborting stream`,
            { level: 'error' },
          )
          logForDiagnosticsNoPII('error', 'cli_streaming_idle_timeout')
          releaseStreamResources()
        }, timeoutMs)
      }
      resetStreamIdleTimer()

      try {
        // stream in and accumulate state
        let isFirstChunk = true
        let lastEventTime: number | null = null // Set after first chunk to avoid measuring TTFB as a stall
        const STALL_THRESHOLD_MS = 30_000 // 30 seconds
        let totalStallTime = 0
        let stallCount = 0

        for await (const part of streamingResponse.stream) {
          clearStreamIdleTimers()
          hasReceivedStreamEvent = true
          const now = Date.now()

          // Detect and log streaming stalls (only after first event to avoid counting TTFB)
          if (lastEventTime !== null) {
            const timeSinceLastEvent = now - lastEventTime
            if (timeSinceLastEvent > STALL_THRESHOLD_MS) {
              stallCount++
              totalStallTime += timeSinceLastEvent
              logForDebugging(
                `Streaming stall detected: ${(timeSinceLastEvent / 1000).toFixed(1)}s gap between events (stall #${stallCount})`,
                { level: 'warn' },
              )
            }
          }
          lastEventTime = now

          if (isFirstChunk) {
            logForDebugging('Stream started - received first chunk')
            queryCheckpoint('query_first_chunk_received')
            if (!options.agentId) {
              headlessProfilerCheckpoint('first_chunk')
            }
            endQueryProfile()
            isFirstChunk = false
          }

          switch (part.type) {
            case 'message_start': {
              partialMessage = part.message
              ttftMs = Date.now() - start
              usage = updateUsage(usage, part.message?.usage)
              break
            }
            case 'content_block_start': {
              const cb = part.content_block as DomainContentBlock
              switch (cb.type) {
                case 'tool_use':
                  contentBlocks[part.index] = {
                    ...cb,
                    input: '',
                  } as (typeof contentBlocks)[number]
                  break
                case 'server_tool_use':
                  contentBlocks[part.index] = {
                    ...cb,
                    input: '' as unknown as { [key: string]: unknown },
                  } as (typeof contentBlocks)[number]
                  if ((cb as { name?: string }).name === 'advisor') {
                    isAdvisorInProgress = true
                    logForDebugging(`[AdvisorTool] Advisor tool called`)
                  }
                  break
                case 'text':
                  contentBlocks[part.index] = {
                    ...cb,
                    text: '',
                  } as (typeof contentBlocks)[number]
                  break
                case 'reasoning': {
                  contentBlocks[part.index] = {
                    type: 'reasoning',
                    text: '',
                    ...((cb as DomainReasoningBlock).providerState && {
                      providerState: (cb as DomainReasoningBlock).providerState,
                    }),
                  } as (typeof contentBlocks)[number]
                  break
                }
                case 'redacted_reasoning': {
                  contentBlocks[part.index] = {
                    ...cb,
                  } as (typeof contentBlocks)[number]
                  break
                }
                default:
                  contentBlocks[part.index] = {
                    ...cb,
                  } as (typeof contentBlocks)[number]
                  if ((cb.type as string) === 'advisor_tool_result') {
                    isAdvisorInProgress = false
                    logForDebugging(
                      `[AdvisorTool] Advisor tool result received`,
                    )
                  }
                  break
              }
              break
            }
            case 'content_block_delta': {
              const contentBlock = contentBlocks[part.index]
              const delta = part.delta as Record<string, unknown> & {
                type: string
              }
              if (!contentBlock) {
                throw new RangeError('Content block not found')
              }
              if (
                feature('CONNECTOR_TEXT') &&
                delta.type === 'connector_text_delta'
              ) {
                if (contentBlock.type !== 'connector_text') {
                  throw new Error('Content block is not a connector_text block')
                }
                contentBlock.connector_text += delta.connector_text as string
              } else {
                switch (delta.type) {
                  case 'citations_delta':
                    // TODO: handle citations
                    break
                  case 'input_json_delta':
                    if (
                      contentBlock.type !== 'tool_use' &&
                      contentBlock.type !== 'server_tool_use'
                    ) {
                      throw new Error('Content block is not a input_json block')
                    }
                    if (typeof contentBlock.input !== 'string') {
                      throw new Error('Content block input is not a string')
                    }
                    contentBlock.input += delta.partial_json as string
                    break
                  case 'text_delta':
                    if (contentBlock.type !== 'text') {
                      throw new Error('Content block is not a text block')
                    }
                    contentBlock.text += delta.text as string
                    break
                  case 'thinking_delta':
                    if (contentBlock.type !== 'reasoning') {
                      throw new Error('Content block is not a reasoning block')
                    }
                    ;(contentBlock as DomainReasoningBlock).text +=
                      delta.thinking as string
                    break
                }
              }
              break
            }
            case 'content_block_stop': {
              const contentBlock = contentBlocks[part.index]
              if (!contentBlock) {
                throw new RangeError('Content block not found')
              }
              if (part.providerState) {
                const blockWithProviderState =
                  contentBlock as typeof contentBlock & {
                    providerState?: Record<string, unknown>
                  }
                blockWithProviderState.providerState = {
                  ...(blockWithProviderState.providerState ?? {}),
                  ...part.providerState,
                }
              }
              if (!partialMessage) {
                throw new Error('Message not found')
              }
              const m: AssistantMessage = {
                message: {
                  ...partialMessage,
                  content: normalizeContentFromAPI(
                    [contentBlock] as unknown as DomainContentBlock[],
                    tools,
                    options.agentId,
                  ),
                },
                requestId: streamRequestId ?? undefined,
                type: 'assistant',
                uuid: randomUUID(),
                timestamp: new Date().toISOString(),
                ...(advisorModel && { advisorModel }),
              }
              newMessages.push(m)
              if (part.providerConfirmed) {
                providerConfirmedMessages.push(m)
              }
              yield m
              break
            }
            case 'message_delta': {
              usage = updateUsage(usage, part.usage)

              // Write final usage and stop_reason back to the last yielded
              // message. Messages are created at content_block_stop from
              // partialMessage, which was set at message_start before any tokens
              // were generated (output_tokens: 0, stop_reason: null).
              // message_delta arrives after content_block_stop with the real
              // values.
              //
              // IMPORTANT: Use direct property mutation, not object replacement.
              // The transcript write queue holds a reference to message.message
              // and serializes it lazily (100ms flush interval). Object
              // replacement ({ ...lastMsg.message, usage }) would disconnect
              // the queued reference; direct mutation ensures the transcript
              // captures the final values.
              stopReason = part.delta.stop_reason ?? null

              const lastMsg = newMessages.at(-1)
              if (lastMsg) {
                lastMsg.message.usage = usage
                lastMsg.message.stop_reason = stopReason
              }

              // Update cost
              const costUSDForPart = calculateUSDCost(resolvedModel, usage)
              costUSD += addToTotalSessionCost(
                costUSDForPart,
                usage,
                options.model,
              )

              const refusalMessage = getErrorMessageIfRefusal(
                stopReason,
                options.model,
              )
              if (refusalMessage) {
                yield refusalMessage
              }

              // Note: `max_tokens` and `model_context_window_exceeded` used
              // to emit synthetic "API Error: ..." assistant messages here,
              // which fed an auto-retry + multi-turn recovery loop. That was
              // wrong — the harness was compensating for its own silent 8k
              // clobber of the user's configured max_tokens. Now we respect
              // the user's `maxOutputTokens` setting and pass these stop
              // reasons through on the real assistant message's
              // `message.stop_reason`. UI + subagent finalize read it from
              // there; no synthetic error, no auto-retry.
              break
            }
            case 'message_stop':
              break
          }

          resetStreamIdleTimer()
          yield {
            type: 'stream_event',
            event: part,
            ...(part.type === 'message_start' ? { ttftMs } : undefined),
          }
        }
        // Clear the idle timeout watchdog now that the stream loop has exited
        clearStreamIdleTimers()

        // If the stream was aborted by our idle timeout watchdog, fall back to
        // non-streaming retry rather than treating it as a completed stream.
        if (streamIdleAborted) {
          // Instrumentation: proves the for-await exited after the watchdog fired
          // (vs. hung forever). exit_delay_ms measures abort propagation latency:
          // 0-10ms = abort worked; >>1000ms = something else woke the loop.
          const exitDelayMs =
            streamWatchdogFiredAt !== null
              ? Math.round(performance.now() - streamWatchdogFiredAt)
              : -1
          logForDiagnosticsNoPII(
            'info',
            'cli_stream_loop_exited_after_watchdog_clean',
          )
          // Prevent double-emit: this throw lands in the catch block below,
          // whose exit_path='error' probe guards on streamWatchdogFiredAt.
          streamWatchdogFiredAt = null
          throw new Error(STREAM_IDLE_TIMEOUT_ERROR)
        }

        // Detect when the stream completed without producing any assistant messages.
        // This covers two proxy failure modes:
        // 1. No events at all (!partialMessage): proxy returned 200 with non-SSE body
        // 2. Partial events (partialMessage set but no content blocks completed AND
        //    no stop_reason received): proxy returned message_start but stream ended
        //    before content_block_stop and before message_delta with stop_reason
        // BetaMessageStream had the first check in _endRequest() but the raw Stream
        // does not - without it the generator silently returns no assistant messages,
        // causing "Execution error" in -p mode.
        // Note: We must check stopReason to avoid false positives. For example, with
        // structured output (--json-schema), the model calls a StructuredOutput tool
        // on turn 1, then on turn 2 responds with end_turn and no content blocks.
        // That's a legitimate empty response, not an incomplete stream.
        if (!partialMessage || (newMessages.length === 0 && !stopReason)) {
          logForDebugging(
            !partialMessage
              ? 'Stream completed without receiving message_start event - triggering non-streaming fallback'
              : 'Stream completed with message_start but no content blocks completed - triggering non-streaming fallback',
            { level: 'error' },
          )
          throw new Error('Stream ended without receiving any events')
        }

        // Log summary if any stalls occurred during streaming
        if (stallCount > 0) {
          logForDebugging(
            `Streaming completed with ${stallCount} stall(s), total stall time: ${(totalStallTime / 1000).toFixed(1)}s`,
            { level: 'warn' },
          )
        }

        // Check if the cache actually broke based on response tokens
        if (feature('PROMPT_CACHE_BREAK_DETECTION')) {
          void checkResponseForCacheBreak(
            options.querySource,
            usage.cache_read_input_tokens,
            usage.cache_creation_input_tokens,
            messages,
            options.agentId,
            streamRequestId,
          )
        }

        // Process headers from the domain streaming response
        const dsr = domainStreamResponse as DomainStreamingResponse | undefined
        if (dsr?.responseHeaders) {
          const headersObj = new Headers(dsr.responseHeaders)
          extractQuotaStatusFromHeaders(headersObj)
          responseHeaders = headersObj
        }
      } catch (streamingError) {
        // Clear the idle timeout watchdog on error path too
        clearStreamIdleTimers()

        // Instrumentation: if the watchdog had already fired and the for-await
        // threw (rather than exiting cleanly), record that the loop DID exit and
        // how long after the watchdog. Distinguishes true hangs from error exits.
        if (streamIdleAborted && streamWatchdogFiredAt !== null) {
          const exitDelayMs = Math.round(
            performance.now() - streamWatchdogFiredAt,
          )
          logForDiagnosticsNoPII(
            'info',
            'cli_stream_loop_exited_after_watchdog_error',
          )
        }

        if (streamingError instanceof DomainUserAbortError) {
          if (signal.aborted) {
            logForDebugging(
              `Streaming aborted by user: ${errorMessage(streamingError)}`,
            )
            throw streamingError
          }

          logForDebugging(`Streaming timeout: ${streamingError.message}`, {
            level: 'error',
          })
          throw new DomainConnectionTimeoutError({
            normalized: {
              kind: 'transport',
              message: 'Request timed out',
              providerType:
                registry.getProviderType(options.model) ?? 'anthropic',
              raw: streamingError,
            },
            cause: streamingError,
            raw: streamingError,
          })
        }

        if (
          isStreamTruncationError(streamingError) &&
          providerConfirmedMessages.length > 0 &&
          options.onStreamingRecovery?.(
            providerConfirmedMessages,
            streamingError,
          )
        ) {
          logForDebugging(
            `Recovering from truncated stream with ${providerConfirmedMessages.length} provider-confirmed message(s)`,
            { level: 'warn' },
          )
          releaseStreamResources()
          return
        }

        if (
          isRetryableMidStreamError(streamingError) &&
          midstreamRetryAttempt < MIDSTREAM_MAX_RETRIES &&
          !signal.aborted
        ) {
          const retryAttempt = midstreamRetryAttempt + 1
          const serverRetryAfterMs =
            streamingError instanceof DomainTransportError
              ? streamingError.normalized.retryAfterMs
              : undefined
          const delayMs = serverRetryAfterMs ?? getRetryDelay(retryAttempt)
          const retryError =
            streamingError instanceof DomainTransportError
              ? streamingError
              : new DomainTransportError({
                  normalized: {
                    kind: 'transport',
                    message: errorMessage(streamingError),
                    providerType:
                      registry.getProviderType(options.model) ?? 'anthropic',
                    raw: streamingError,
                  },
                  cause: streamingError,
                  raw: streamingError,
                })
          logForDebugging(
            `Retryable mid-stream error; retrying stream attempt ${retryAttempt}/${MIDSTREAM_MAX_RETRIES}: ${errorMessage(streamingError)}`,
            { level: 'warn' },
          )
          options.onStreamingFallback?.()
          releaseStreamResources()
          yield createSystemAPIErrorMessage(
            retryError,
            delayMs,
            retryAttempt,
            MIDSTREAM_MAX_RETRIES,
          )
          await sleep(delayMs, signal, {
            abortError: () => new DomainUserAbortError(),
          })
          continue
        }

        logForDebugging(
          `Error streaming (non-retryable): ${errorMessage(streamingError)}`,
          { level: 'error' },
        )
        throw streamingError
      } finally {
        clearStreamIdleTimers()
      }
      break
    }
  } catch (errorFromRetry) {
    // Check if this is a 404 error during stream creation that should trigger
    // non-streaming fallback. This handles gateways that return 404 for streaming
    // endpoints but work fine with non-streaming. Before v2.1.8, BetaMessageStream
    // threw 404s during iteration (caught by inner catch with fallback), but now
    // with raw streams, 404s are thrown during creation (caught here).
    const is404StreamCreationError =
      !didFallBackToNonStreaming &&
      errorFromRetry instanceof CannotRetryError &&
      errorFromRetry.originalError instanceof DomainTransportError &&
      errorFromRetry.originalError.status === 404

    if (is404StreamCreationError) {
      // 404 is thrown at .withResponse() before streamRequestId is assigned,
      // and CannotRetryError means every retry failed — so grab the failed
      // request's ID from the error header instead.
      const failedRequestId =
        errorFromRetry.originalError.requestID ?? 'unknown'
      logForDebugging(
        'Streaming endpoint returned 404, falling back to non-streaming mode',
        { level: 'warn' },
      )
      didFallBackToNonStreaming = true
      if (options.onStreamingFallback) {
        options.onStreamingFallback()
      }

      try {
        // Fall back to non-streaming mode
        const result = yield* executeNonStreamingRequest(
          { model: options.model, source: options.querySource },
          {
            model: options.model,
            thinkingConfig,
            ...(isFastModeEnabled() && { fastMode: isFastMode }),
            signal,
          },
          domainParamsFromContext,
          (attempt, _startTime, tokens) => {
            attemptNumber = attempt
            maxOutputTokens = tokens
          },
          request => captureAPIRequest(request, options.querySource),
          failedRequestId,
          options.fetchOverride,
        )

        if (result.responseHeaders) {
          const headersObj = new Headers(result.responseHeaders)
          extractQuotaStatusFromHeaders(headersObj)
          responseHeaders = headersObj
        }
        streamRequestId = result.requestId ?? streamRequestId
        const domainContent = normalizeContentFromAPI(
          result.message.content,
          tools,
          options.agentId,
        )
        const m: AssistantMessage = {
          message: {
            ...result.message,
            content: domainContent,
          },
          requestId: streamRequestId ?? undefined,
          type: 'assistant',
          uuid: randomUUID(),
          timestamp: new Date().toISOString(),
          ...(advisorModel && { advisorModel }),
        }
        newMessages.push(m)
        fallbackMessage = m
        yield m

        // Continue to success logging below
      } catch (fallbackError) {
        // Fallback also failed, handle as normal error
        logForDebugging(
          `Non-streaming fallback also failed: ${errorMessage(fallbackError)}`,
          { level: 'error' },
        )

        let error = fallbackError
        let errorModel = options.model
        if (fallbackError instanceof CannotRetryError) {
          error = fallbackError.originalError
          errorModel = fallbackError.retryContext.model
        }

        extractQuotaStatusFromRetryError(error)

        const requestId = streamRequestId || getRetryErrorRequestId(error)

        logAPIError({
          error,
          model: errorModel,
          messageCount: messagesForAPI.length,
          messageTokens: tokenCountFromLastAPIResponse(messagesForAPI),
          durationMs: Date.now() - start,
          durationMsIncludingRetries: Date.now() - startIncludingRetries,
          attempt: attemptNumber,
          requestId,
          clientRequestId,
          didFallBackToNonStreaming,
          queryTracking: options.queryTracking,
          querySource: options.querySource,
          llmSpan,
          fastMode: isFastModeRequest,
          previousRequestId,
        })

        if (error instanceof DomainUserAbortError) {
          releaseStreamResources()
          return
        }

        yield getAssistantMessageFromError(error, errorModel, {
          messages,
          messagesForAPI,
        })
        releaseStreamResources()
        return
      }
    } else {
      // Original error handling for non-404 errors
      logForDebugging(`Error in API request: ${errorMessage(errorFromRetry)}`, {
        level: 'error',
      })

      let error = errorFromRetry
      let errorModel = options.model
      if (errorFromRetry instanceof CannotRetryError) {
        error = errorFromRetry.originalError
        errorModel = errorFromRetry.retryContext.model
      }

      // Extract quota status from error headers if it's a rate limit error
      extractQuotaStatusFromRetryError(error)

      // Extract requestId from stream, error header, or error body
      const requestId = streamRequestId || getRetryErrorRequestId(error)

      logAPIError({
        error,
        model: errorModel,
        messageCount: messagesForAPI.length,
        messageTokens: tokenCountFromLastAPIResponse(messagesForAPI),
        durationMs: Date.now() - start,
        durationMsIncludingRetries: Date.now() - startIncludingRetries,
        attempt: attemptNumber,
        requestId,
        clientRequestId,
        didFallBackToNonStreaming,
        queryTracking: options.queryTracking,
        querySource: options.querySource,
        llmSpan,
        fastMode: isFastModeRequest,
        previousRequestId,
      })

      // Don't yield an assistant error message for user aborts
      // The interruption message is handled in query.ts
      if (error instanceof DomainUserAbortError) {
        releaseStreamResources()
        return
      }

      yield getAssistantMessageFromError(error, errorModel, {
        messages,
        messagesForAPI,
      })
      releaseStreamResources()
      return
    }
  } finally {
    stopSessionActivity('api_call')
    // Must be in the finally block: if the generator is terminated early
    // via .return() (e.g. consumer breaks out of for-await-of, or query.ts
    // encounters an abort), code after the try/finally never executes.
    // Without this, the Response object's native TLS/socket buffers leak
    // until the generator itself is GC'd (see GH #32920).
    releaseStreamResources()

    // Non-streaming fallback cost: the streaming path tracks cost in the
    // message_delta handler before any yield. Fallback pushes to newMessages
    // then yields, so tracking must be here to survive .return() at the yield.
    if (fallbackMessage) {
      const fallbackUsage = fallbackMessage.message.usage
      usage = updateUsage(EMPTY_USAGE, fallbackUsage)
      stopReason = fallbackMessage.message.stop_reason
      const fallbackCost = calculateUSDCost(resolvedModel, fallbackUsage)
      costUSD += addToTotalSessionCost(
        fallbackCost,
        fallbackUsage,
        options.model,
      )
    }
  }

  // Track the last requestId for the main conversation chain so shutdown
  // can send a cache eviction hint to inference. Exclude backgrounded
  // sessions (Ctrl+B) which share the repl_main_thread querySource but
  // run inside an agent context — they are independent conversation chains
  // whose cache should not be evicted when the foreground session clears.
  if (
    streamRequestId &&
    !getAgentContext() &&
    (options.querySource.startsWith('repl_main_thread') ||
      options.querySource === 'sdk')
  ) {
    setLastMainRequestId(streamRequestId)
  }

  // Precompute scalars so the fire-and-forget .then() closure doesn't pin the
  // full messagesForAPI array (the entire conversation up to the context window
  // limit) until getToolPermissionContext() resolves.
  const logMessageCount = messagesForAPI.length
  const logMessageTokens = tokenCountFromLastAPIResponse(messagesForAPI)
  void options.getToolPermissionContext().then(permissionContext => {
    logAPISuccessAndDuration({
      model:
        newMessages[0]?.message.model ?? partialMessage?.model ?? options.model,
      preNormalizedModel: options.model,
      usage,
      start,
      startIncludingRetries,
      attempt: attemptNumber,
      messageCount: logMessageCount,
      messageTokens: logMessageTokens,
      requestId: streamRequestId ?? null,
      stopReason,
      ttftMs,
      didFallBackToNonStreaming,
      querySource: options.querySource,
      headers: responseHeaders,
      costUSD,
      queryTracking: options.queryTracking,
      permissionMode: permissionContext.mode,
      // Pass newMessages for beta tracing - extraction happens in logging.ts
      // only when beta tracing is enabled
      newMessages,
      llmSpan,
      globalCacheStrategy,
      requestSetupMs: start - startIncludingRetries,
      attemptStartTimes,
      fastMode: isFastModeRequest,
      previousRequestId,
      betas: lastRequestBetas,
    })
  })

  // Defensive: also release on normal completion (no-op if finally already ran).
  releaseStreamResources()
}

/**
 * Updates usage statistics with new values from streaming API events.
 * Note: Anthropic's streaming API provides cumulative usage totals, not incremental deltas.
 * Each event contains the complete usage up to that point in the stream.
 *
 * Input-related tokens (input_tokens, cache_creation_input_tokens, cache_read_input_tokens)
 * are typically set in message_start and remain constant. message_delta events may send
 * explicit 0 values for these fields, which should not overwrite the values from message_start.
 * We only update these fields if they have a non-null, non-zero value.
 */
export function updateUsage(
  usage: Readonly<NonNullableUsage>,
  partUsage: DomainUsage | undefined,
): NonNullableUsage {
  if (!partUsage) {
    return { ...usage }
  }
  const serverToolUse = partUsage.server_tool_use as
    | { web_search_requests?: number; web_fetch_requests?: number }
    | undefined
  const cacheCreation = partUsage.cache_creation as
    | {
        ephemeral_1h_input_tokens?: number
        ephemeral_5m_input_tokens?: number
      }
    | undefined
  return {
    input_tokens:
      typeof partUsage.input_tokens === 'number' && partUsage.input_tokens > 0
        ? partUsage.input_tokens
        : usage.input_tokens,
    cache_creation_input_tokens:
      typeof partUsage.cache_creation_input_tokens === 'number' &&
      partUsage.cache_creation_input_tokens > 0
        ? partUsage.cache_creation_input_tokens
        : usage.cache_creation_input_tokens,
    cache_read_input_tokens:
      typeof partUsage.cache_read_input_tokens === 'number' &&
      partUsage.cache_read_input_tokens > 0
        ? partUsage.cache_read_input_tokens
        : usage.cache_read_input_tokens,
    output_tokens: partUsage.output_tokens ?? usage.output_tokens,
    server_tool_use: {
      web_search_requests:
        serverToolUse?.web_search_requests ??
        usage.server_tool_use.web_search_requests,
      web_fetch_requests:
        serverToolUse?.web_fetch_requests ??
        usage.server_tool_use.web_fetch_requests,
    },
    service_tier: usage.service_tier,
    cache_creation: {
      ephemeral_1h_input_tokens:
        cacheCreation?.ephemeral_1h_input_tokens ??
        usage.cache_creation.ephemeral_1h_input_tokens,
      ephemeral_5m_input_tokens:
        cacheCreation?.ephemeral_5m_input_tokens ??
        usage.cache_creation.ephemeral_5m_input_tokens,
    },
    inference_geo: usage.inference_geo,
    iterations:
      (partUsage.iterations as NonNullableUsage['iterations'] | undefined) ??
      usage.iterations,
    speed:
      (partUsage.speed as NonNullableUsage['speed'] | undefined) ?? usage.speed,
  }
}

/**
 * Accumulates usage from one message into a total usage object.
 * Used to track cumulative usage across multiple assistant turns.
 */
export function accumulateUsage(
  totalUsage: Readonly<NonNullableUsage>,
  messageUsage: Readonly<NonNullableUsage>,
): NonNullableUsage {
  return {
    input_tokens: totalUsage.input_tokens + messageUsage.input_tokens,
    cache_creation_input_tokens:
      totalUsage.cache_creation_input_tokens +
      messageUsage.cache_creation_input_tokens,
    cache_read_input_tokens:
      totalUsage.cache_read_input_tokens + messageUsage.cache_read_input_tokens,
    output_tokens: totalUsage.output_tokens + messageUsage.output_tokens,
    server_tool_use: {
      web_search_requests:
        totalUsage.server_tool_use.web_search_requests +
        messageUsage.server_tool_use.web_search_requests,
      web_fetch_requests:
        totalUsage.server_tool_use.web_fetch_requests +
        messageUsage.server_tool_use.web_fetch_requests,
    },
    service_tier: messageUsage.service_tier, // Use the most recent service tier
    cache_creation: {
      ephemeral_1h_input_tokens:
        totalUsage.cache_creation.ephemeral_1h_input_tokens +
        messageUsage.cache_creation.ephemeral_1h_input_tokens,
      ephemeral_5m_input_tokens:
        totalUsage.cache_creation.ephemeral_5m_input_tokens +
        messageUsage.cache_creation.ephemeral_5m_input_tokens,
    },
    inference_geo: messageUsage.inference_geo, // Use the most recent
    iterations: messageUsage.iterations, // Use the most recent
    speed: messageUsage.speed, // Use the most recent
  }
}

// Exported for testing cache breakpoint placement
export function addCacheBreakpoints(
  messages: (UserMessage | AssistantMessage)[],
  enablePromptCaching: boolean,
  querySource?: QuerySource,
  skipCacheWrite = false,
): DomainMessageParam[] {
  // Exactly one message-level cache_control marker per request. Mycro's
  // turn-to-turn eviction (page_manager/index.rs: Index::insert) frees
  // local-attention KV pages at any cached prefix position NOT in
  // cache_store_int_token_boundaries. With two markers the second-to-last
  // position is protected and its locals survive an extra turn even though
  // nothing will ever resume from there — with one marker they're freed
  // immediately. For fire-and-forget forks (skipCacheWrite) we shift the
  // marker to the second-to-last message: that's the last shared-prefix
  // point, so the write is a no-op merge on mycro (entry already exists)
  // and the fork doesn't leave its own tail in the KVCC. Dense pages are
  // refcounted and survive via the new hash either way.
  const markerIndex = skipCacheWrite ? messages.length - 2 : messages.length - 1
  const result = messages.map((msg, index) => {
    const addCache = index === markerIndex
    if (msg.type === 'user') {
      return userMessageToMessageParam(
        msg,
        addCache,
        enablePromptCaching,
        querySource,
      )
    }
    return assistantMessageToMessageParam(
      msg,
      addCache,
      enablePromptCaching,
      querySource,
    )
  })

  return result
}

export function buildSystemPromptBlocks(
  systemPrompt: SystemPrompt,
  enablePromptCaching: boolean,
  options?: {
    skipGlobalCacheForSystemPrompt?: boolean
    querySource?: QuerySource
    model?: string
  },
): DomainSystemBlock[] {
  // IMPORTANT: Do not add any more blocks for caching or you will get a 400
  return splitSysPromptPrefix(systemPrompt, {
    skipGlobalCacheForSystemPrompt: options?.skipGlobalCacheForSystemPrompt,
    model: options?.model,
  }).map(block => {
    return {
      type: 'text' as const,
      text: block.text,
      ...(enablePromptCaching &&
        block.cacheScope !== null && {
          cache_control: getCacheControl({
            scope: block.cacheScope,
            querySource: options?.querySource,
          }),
        }),
    }
  })
}

type HaikuOptions = Omit<Options, 'model' | 'getToolPermissionContext'>

export async function queryHaiku({
  systemPrompt = asSystemPrompt([]),
  userPrompt,
  outputFormat,
  signal,
  options,
}: {
  systemPrompt: SystemPrompt
  userPrompt: string
  outputFormat?: Record<string, unknown>
  signal: AbortSignal
  options: HaikuOptions
}): Promise<AssistantMessage> {
  const result = await withVCR(
    [
      createUserMessage({
        content: systemPrompt.map(text => ({ type: 'text', text })),
      }),
      createUserMessage({
        content: userPrompt,
      }),
    ],
    async () => {
      const messages = [
        createUserMessage({
          content: userPrompt,
        }),
      ]

      const result = await queryModelWithoutStreaming({
        messages,
        systemPrompt,
        thinkingConfig: { type: 'disabled' },
        tools: [],
        signal,
        options: {
          ...options,
          model: getSmallFastModel(),
          enablePromptCaching: options.enablePromptCaching ?? false,
          outputFormat,
          async getToolPermissionContext() {
            return getEmptyToolPermissionContext()
          },
        },
      })
      return [result]
    },
  )
  // We don't use streaming for Haiku so this is safe
  return result[0]! as AssistantMessage
}

type QueryWithModelOptions = Omit<Options, 'getToolPermissionContext'>

/**
 * Query a specific model through the Claude Code infrastructure.
 * This goes through the full query pipeline including proper authentication,
 * betas, and headers - unlike direct API calls.
 */
export async function queryWithModel({
  systemPrompt = asSystemPrompt([]),
  userPrompt,
  outputFormat,
  signal,
  options,
}: {
  systemPrompt: SystemPrompt
  userPrompt: string
  outputFormat?: Record<string, unknown>
  signal: AbortSignal
  options: QueryWithModelOptions
}): Promise<AssistantMessage> {
  const result = await withVCR(
    [
      createUserMessage({
        content: systemPrompt.map(text => ({ type: 'text', text })),
      }),
      createUserMessage({
        content: userPrompt,
      }),
    ],
    async () => {
      const messages = [
        createUserMessage({
          content: userPrompt,
        }),
      ]

      const result = await queryModelWithoutStreaming({
        messages,
        systemPrompt,
        thinkingConfig: { type: 'disabled' },
        tools: [],
        signal,
        options: {
          ...options,
          enablePromptCaching: options.enablePromptCaching ?? false,
          outputFormat,
          async getToolPermissionContext() {
            return getEmptyToolPermissionContext()
          },
        },
      })
      return [result]
    },
  )
  return result[0]! as AssistantMessage
}

// Non-streaming requests have a 10min max per the docs:
// https://platform.claude.com/docs/en/api/errors#long-requests
// The SDK's 21333-token cap is derived from 10min × 128k tokens/hour, but we
// bypass it by setting a client-level timeout, so we can cap higher.
export const MAX_NON_STREAMING_TOKENS = 64_000

/**
 * Adjusts thinking budget when max_tokens is capped for non-streaming fallback.
 * Ensures the API constraint: max_tokens > thinking.budget_tokens
 *
 * @param params - The parameters that will be sent to the API
 * @param maxTokensCap - The maximum allowed tokens (MAX_NON_STREAMING_TOKENS)
 * @returns Adjusted parameters with thinking budget capped if needed
 */
export function adjustDomainRequestForNonStreaming(
  request: DomainMessageRequest,
  maxTokensCap: number,
): DomainMessageRequest {
  const cappedMaxTokens = Math.min(request.maxTokens, maxTokensCap)

  // Adjust thinking budget if it would exceed capped maxTokens
  // to maintain the constraint: maxTokens > thinking.budgetTokens.
  const adjustedRequest = { ...request }
  if (adjustedRequest.thinking?.type === 'enabled') {
    adjustedRequest.thinking = {
      ...adjustedRequest.thinking,
      budgetTokens: Math.min(
        adjustedRequest.thinking.budgetTokens,
        cappedMaxTokens - 1, // Must be at least 1 less than maxTokens
      ),
    }
  }

  return {
    ...adjustedRequest,
    maxTokens: cappedMaxTokens,
  }
}
