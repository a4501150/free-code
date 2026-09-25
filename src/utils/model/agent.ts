import type { PermissionMode } from '../permissions/PermissionMode.js'
import {
  getRuntimeMainLoopModel,
  getUtilityModel,
  parseUserSpecifiedModel,
} from './model.js'
import { getProviderRegistry } from './providerRegistry.js'
import { qualifyModel, stripContextSuffix } from './parseModelString.js'
import {
  parseModelStringFromRegistry,
  stripProviderPrefix,
} from './parseModelStringWithRegistry.js'
import { getPublicModelDisplayName } from './modelDisplay.js'

/**
 * Sentinel value for agent definitions that want the configured utility model
 * (the background-call model: hooks, summaries, quota checks).
 * Resolved at runtime by getAgentModel() via getUtilityModel(), which falls
 * back to defaultModel if utilityModel is not configured.
 *
 * NOTE: still subject to the defaultSubagentModel blunt override — if the user
 * sets defaultSubagentModel, it wins over this sentinel.
 */
export const UTILITY_MODEL_SENTINEL = 'utility'

/**
 * Keywords the skill/slash-command frontmatter `model` field accepts as an
 * explicit "run on the parent's model" (instead of a model ID). Checked
 * BEFORE any registry lookup so these never look like unknown models.
 */
export function isModelInheritKeyword(model: string): boolean {
  return /^(inherit|default|parent)$/i.test(model.trim())
}

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
  options?: {
    /** Model override from skill/slash-command frontmatter (user-decided;
     * the Agent tool has no model param — the LLM cannot pick a subagent model). */
    commandModel?: string
    permissionMode?: PermissionMode
  },
): string {
  // Priority: modelSettings.json defaultSubagentModel > model defaults
  const configSubagent =
    getProviderRegistry().getConfiguredDefaultSubagentModel()
  const subagentOverride = configSubagent
  if (subagentOverride) {
    return parseUserSpecifiedModel(subagentOverride)
  }

  const registry = getProviderRegistry()
  const permissionMode = options?.permissionMode ?? 'default'
  const commandModel = options?.commandModel

  // Helper to propagate region prefix from parent model for Bedrock cross-region inference.
  // Operates on the bare model ID, then re-qualifies with the provider prefix.
  const applyParentRegionPrefix = (resolvedModel: string): string => {
    const parsed = parseModelStringFromRegistry(resolvedModel)
    const prefixed = registry.propagateModelPrefix(
      stripProviderPrefix(parentModel),
      parsed.modelId,
    )
    if (prefixed === parsed.modelId) return resolvedModel
    return qualifyModel(parsed.provider, prefixed)
  }

  // Keyword aliases for an explicit "no override" from frontmatter:
  // resolve like the agent-definition 'inherit' sentinel — i.e. the parent's
  // runtime model, overriding even a model set in the agent definition.
  if (commandModel && isModelInheritKeyword(commandModel)) {
    return getRuntimeMainLoopModel({
      permissionMode,
      mainLoopModel: parentModel,
      exceeds200kTokens: false,
    })
  }

  // Prioritize the frontmatter model if provided
  if (commandModel) {
    const model = parseUserSpecifiedModel(commandModel)
    return applyParentRegionPrefix(model)
  }

  const agentModelWithExp = agentModel ?? getDefaultSubagentModel()

  if (agentModelWithExp === 'inherit') {
    // Apply runtime model resolution for inherit to get the effective model
    return getRuntimeMainLoopModel({
      permissionMode,
      mainLoopModel: parentModel,
      exceeds200kTokens: false,
    })
  }

  // Resolve 'utility' sentinel to the configured utility model
  // (falls back to defaultModel inside getUtilityModel)
  if (agentModelWithExp === UTILITY_MODEL_SENTINEL) {
    return applyParentRegionPrefix(getUtilityModel())
  }

  const model = parseUserSpecifiedModel(agentModelWithExp)
  return applyParentRegionPrefix(model)
}

export function getAgentModelDisplay(model: string | undefined): string {
  if (!model) return 'Inherit from parent (default)'
  if (model === 'inherit') return 'Inherit from parent'
  if (model === UTILITY_MODEL_SENTINEL) {
    const resolved = getUtilityModel()
    const displayName = getPublicModelDisplayName(resolved)
    return displayName ?? resolved
  }
  // Try to get a display name from the registry
  const displayName = getPublicModelDisplayName(model)
  if (displayName) return displayName
  return model
}
