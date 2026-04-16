import type { PermissionMode } from '../permissions/PermissionMode.js'
import {
  getRuntimeMainLoopModel,
  getSmallFastModel,
  parseUserSpecifiedModel,
} from './model.js'
import { getProviderRegistry } from './providerRegistry.js'
import {
  parseModelStringFromRegistry,
  qualifyModel,
  stripProviderPrefix,
} from './parseModelString.js'
import { getPublicModelDisplayName } from './modelDisplay.js'

/**
 * Sentinel value for agent definitions that want the configured small/fast model.
 * Resolved at runtime by getAgentModel() via getSmallFastModel().
 */
export const SMALL_FAST_MODEL_SENTINEL = 'smallFast'

/**
 * Sentinel value for agent definitions that want a balanced-capability model.
 * Resolved at runtime by getAgentModel() via defaultBalancedModel config,
 * falling back to inherit (main model) if not configured.
 */
export const BALANCED_MODEL_SENTINEL = 'balanced'

/**
 * Get the default subagent model. Returns 'inherit' so subagents inherit
 * the model from the parent thread.
 */
export function getDefaultSubagentModel(): string {
  return 'inherit'
}

/**
 * Get the effective model string for an agent.
 *
 * For Bedrock, if the parent model uses a cross-region inference prefix (e.g., "eu.", "us."),
 * that prefix is inherited by subagents. This ensures subagents use the same region as the
 * parent, which is necessary when IAM permissions are scoped to specific cross-region
 * inference profiles.
 */
export function getAgentModel(
  agentModel: string | undefined,
  parentModel: string,
  toolSpecifiedModel?: string,
  permissionMode?: PermissionMode,
): string {
  // Priority: env var > freecode.json defaultSubagentModel
  const envSubagent = process.env.CLAUDE_CODE_SUBAGENT_MODEL
  const configSubagent = getProviderRegistry().getConfiguredDefaultSubagentModel()
  const subagentOverride = envSubagent || configSubagent
  if (subagentOverride) {
    return parseUserSpecifiedModel(subagentOverride)
  }

  const registry = getProviderRegistry()

  // Helper to propagate region prefix from parent model for Bedrock cross-region inference.
  // Operates on the bare model ID, then re-qualifies with the provider prefix.
  const applyParentRegionPrefix = (
    resolvedModel: string,
  ): string => {
    const parsed = parseModelStringFromRegistry(resolvedModel)
    const prefixed = registry.propagateModelPrefix(
      stripProviderPrefix(parentModel),
      parsed.modelId,
    )
    if (prefixed === parsed.modelId) return resolvedModel
    return qualifyModel(parsed.provider, prefixed)
  }

  // Prioritize tool-specified model if provided
  if (toolSpecifiedModel) {
    const model = parseUserSpecifiedModel(toolSpecifiedModel)
    return applyParentRegionPrefix(model)
  }

  const agentModelWithExp = agentModel ?? getDefaultSubagentModel()

  if (agentModelWithExp === 'inherit') {
    // Apply runtime model resolution for inherit to get the effective model
    return getRuntimeMainLoopModel({
      permissionMode: permissionMode ?? 'default',
      mainLoopModel: parentModel,
      exceeds200kTokens: false,
    })
  }

  // Resolve 'smallFast' sentinel to the configured small/fast model
  if (agentModelWithExp === SMALL_FAST_MODEL_SENTINEL) {
    return applyParentRegionPrefix(getSmallFastModel())
  }

  // Resolve 'balanced' sentinel to configured balanced model, falling back to inherit
  if (agentModelWithExp === BALANCED_MODEL_SENTINEL) {
    const balanced = registry.getConfiguredDefaultBalancedModel()
    if (balanced) {
      return applyParentRegionPrefix(parseUserSpecifiedModel(balanced))
    }
    // Fall back to inherit (main model)
    return getRuntimeMainLoopModel({
      permissionMode: permissionMode ?? 'default',
      mainLoopModel: parentModel,
      exceeds200kTokens: false,
    })
  }

  const model = parseUserSpecifiedModel(agentModelWithExp)
  return applyParentRegionPrefix(model)
}

export function getAgentModelDisplay(model: string | undefined): string {
  if (!model) return 'Inherit from parent (default)'
  if (model === 'inherit') return 'Inherit from parent'
  if (model === SMALL_FAST_MODEL_SENTINEL) {
    const resolved = getSmallFastModel()
    const displayName = getPublicModelDisplayName(resolved)
    return displayName ?? resolved
  }
  if (model === BALANCED_MODEL_SENTINEL) {
    const balanced = getProviderRegistry().getConfiguredDefaultBalancedModel()
    if (balanced) {
      const displayName = getPublicModelDisplayName(balanced)
      return displayName ?? balanced
    }
    return 'Inherit from parent'
  }
  // Try to get a display name from the registry
  const displayName = getPublicModelDisplayName(model)
  if (displayName) return displayName
  return model
}
