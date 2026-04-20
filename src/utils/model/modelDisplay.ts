/**
 * Model display/presentation utilities.
 *
 * Pure functions that generate human-readable strings from model identifiers.
 * Uses the provider registry for display labels.
 */

import { getProviderRegistry } from './providerRegistry.js'
import { getDefaultMainLoopModel, parseUserSpecifiedModel } from './modelResolution.js'
import type { ModelName, ModelSetting } from './modelTypes.js'
import { stripProviderPrefix } from './parseModelStringWithRegistry.js'

// ── Display string generation ──────────────────────────────────────

/**
 * Returns a human-readable display name for a model, or null if no
 * display name is available. Uses the provider registry's `label` field.
 */
export function getPublicModelDisplayName(model: ModelName): string | null {
  const registry = getProviderRegistry()
  const resolved = registry.getProviderForModel(model)
  if (resolved?.model.label) return resolved.model.label
  return null
}

export function renderModelName(model: ModelName): string {
  const publicName = getPublicModelDisplayName(model)
  if (publicName) {
    return publicName
  }
  return model
}

/**
 * Returns a safe author name for public display (e.g., in git commit trailers).
 * Returns "Claude {Label}" for models with labels, or "Claude ({model})"
 * for unknown models so the exact model name is preserved.
 */
export function getPublicModelName(model: ModelName): string {
  const publicName = getPublicModelDisplayName(model)
  if (publicName) {
    const stripped = stripProviderPrefix(model)
    if (stripped.includes('gpt-') || stripped.includes('codex')) {
      return publicName
    }
    return `Claude ${publicName}`
  }
  return `Claude (${model})`
}

export function getClaudeAiUserDefaultModelDescription(
  _fastMode = false,
): string {
  const model = getDefaultMainLoopModel()
  const displayName = getPublicModelDisplayName(model)
  return displayName ?? renderModelName(model)
}

export function renderModelSetting(setting: string): string {
  return renderModelName(setting)
}

export function renderDefaultModelSetting(
  setting: string,
): string {
  return renderModelName(parseUserSpecifiedModel(setting))
}

export function modelDisplayString(model: ModelSetting): string {
  if (model === null) {
    return `Default (${getClaudeAiUserDefaultModelDescription()})`
  }
  const resolvedModel = parseUserSpecifiedModel(model)
  return model === resolvedModel ? resolvedModel : `${model} (${resolvedModel})`
}
