// Request-feature assembly for Anthropic-wire adapters (anthropic, vertex,
// foundry, bedrock-converse). The core (src/services/api/claude.ts) carries
// provider-neutral intent on the domain request; beta header strings, the
// header-vs-body split, and the fast-mode/AFK sticky latches are Anthropic
// wire details and are owned here.
//
// Sticky latches: each dynamic beta, once first sent, keeps being sent for
// the rest of the session so mid-session toggles don't change the server-side
// cache key. Cleared on /clear and /compact via clearBetaHeaderLatches().
import {
  AFK_MODE_BETA_HEADER,
  BODY_ONLY_BETAS,
  EFFORT_BETA_HEADER,
  FAST_MODE_BETA_HEADER,
  STRUCTURED_OUTPUTS_BETA_HEADER,
  TASK_BUDGETS_BETA_HEADER,
} from 'src/constants/betas.js'
import {
  getBodyBetas,
  getMergedBetas,
  modelSupportsStructuredOutputs,
  shouldIncludeFirstPartyOnlyBetas,
} from 'src/utils/betas.js'
import {
  isFastModeAvailable,
  isFastModeCooldown,
  isFastModeEnabled,
  isFastModeSupportedByModel,
} from 'src/utils/fastMode.js'
import { modelSupportsEffort } from 'src/utils/effort.js'
import { getProviderRegistry } from 'src/utils/model/providerRegistry.js'
import type { DomainMessageRequest } from '../domain-transport.js'

/** Provider-neutral intent the core passes for one request. */
export type RequestFeatureIntent = {
  isAgenticQuery: boolean
  /** Auto (AFK) mode is active and the user is away from the prompt. */
  afkModeActive: boolean
  /** The user asked for fast mode on this request. */
  fastModeWanted: boolean
  /** The caller requested a structured output format. */
  hasOutputFormat: boolean
  /** The caller passed a task budget. */
  hasTaskBudget: boolean
}

let fastModeHeaderLatched = false
let afkModeHeaderLatched = false

export function clearBetaHeaderLatches(): void {
  fastModeHeaderLatched = false
  afkModeHeaderLatched = false
}

/**
 * Fast mode is effectively on for a request only when the feature is on,
 * the provider supports it, and no cooldown is pending.
 */
export function effectiveFastMode(
  model: string,
  userRequested: boolean,
): boolean {
  return (
    isFastModeEnabled() &&
    isFastModeAvailable() &&
    !isFastModeCooldown() &&
    isFastModeSupportedByModel(model) &&
    userRequested
  )
}

/**
 * Compute the beta set this request would carry, honoring (and updating) the
 * sticky latches. `mutateLatches=false` is the read-only path used by cache
 * break detection before the request is committed.
 */
function computeFeatureBetas(
  request: Pick<DomainMessageRequest, 'outputConfig' | 'speed'>,
  model: string,
  intent: RequestFeatureIntent,
  mutateLatches: boolean,
): string[] {
  const betas = getMergedBetas(model, {
    isAgenticQuery: intent.isAgenticQuery,
  })

  // Effort: the beta accompanies any request built for an effort-capable
  // model (explicit tier in output_config or server-default tier request).
  if (modelSupportsEffort(model) && !betas.includes(EFFORT_BETA_HEADER)) {
    betas.push(EFFORT_BETA_HEADER)
  }

  if (
    request.outputConfig &&
    'task_budget' in request.outputConfig &&
    shouldIncludeFirstPartyOnlyBetas(model) &&
    !betas.includes(TASK_BUDGETS_BETA_HEADER)
  ) {
    betas.push(TASK_BUDGETS_BETA_HEADER)
  }

  if (
    request.outputConfig &&
    'format' in request.outputConfig &&
    modelSupportsStructuredOutputs(model) &&
    !betas.includes(STRUCTURED_OUTPUTS_BETA_HEADER)
  ) {
    betas.push(STRUCTURED_OUTPUTS_BETA_HEADER)
  }

  if (mutateLatches && request.speed === 'fast') {
    fastModeHeaderLatched = true
  }
  if (fastModeHeaderLatched && !betas.includes(FAST_MODE_BETA_HEADER)) {
    betas.push(FAST_MODE_BETA_HEADER)
  }

  const afkGate =
    intent.isAgenticQuery && shouldIncludeFirstPartyOnlyBetas(model)
  if (mutateLatches && afkGate && intent.afkModeActive) {
    afkModeHeaderLatched = true
  }
  if (
    afkModeHeaderLatched &&
    afkGate &&
    getProviderRegistry().resolveFirstPartyCapability(
      undefined,
      'supportsAfkMode',
    ) &&
    !betas.includes(AFK_MODE_BETA_HEADER)
  ) {
    betas.push(AFK_MODE_BETA_HEADER)
  }

  return betas
}

/**
 * Mutate the domain request with the Anthropic wire features it implies:
 * the `anthropic-beta` set as a header, or folded into
 * `extraBody.anthropic_beta` for providers that take betas in the body.
 */
export function applyAnthropicRequestFeatures(
  request: DomainMessageRequest,
  model: string,
  intent: RequestFeatureIntent,
): void {
  const betas = computeFeatureBetas(request, model, intent, true)
  const registry = getProviderRegistry()

  if (registry.getCapability(model, 'betasInBody')) {
    // Bedrock Converse rejects beta HTTP headers; the accepted ones travel
    // in additionalModelRequestFields.anthropic_beta. Body-only betas are
    // already stripped from `betas` by getModelBetas, so union them back in.
    const existing = Array.isArray(request.extraBody?.anthropic_beta)
      ? (request.extraBody!.anthropic_beta as string[])
      : []
    const union = [...new Set([...getBodyBetas(model), ...betas, ...existing])]
    if (union.length > 0) {
      request.extraBody = {
        ...(request.extraBody ?? {}),
        anthropic_beta: union,
      }
    }
    delete request.betas
  } else if (betas.length > 0) {
    request.betas = betas
  }
}

/**
 * Cache-relevant request-shape descriptor for prompt-cache break detection.
 * Automatic-prefix adapters return nothing at all (they strip every field
 * this reports), so break attribution stays provider-correct by construction.
 */
export function describeAnthropicCacheFeatures(
  model: string,
  intent: RequestFeatureIntent,
  requestPreview: Pick<DomainMessageRequest, 'outputConfig' | 'speed'> = {},
): Record<string, string> {
  const features: Record<string, string> = {}
  const betas = computeFeatureBetas(requestPreview, model, intent, false)
  if (betas.length > 0) features['anthropic-beta'] = betas.join(',')
  features['fast-mode-latched'] = String(fastModeHeaderLatched)
  features['afk-mode-latched'] = String(afkModeHeaderLatched)
  return features
}

export { BODY_ONLY_BETAS }
