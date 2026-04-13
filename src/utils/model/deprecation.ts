/**
 * Model deprecation utilities
 *
 * Contains information about deprecated models and their retirement dates.
 */

import type { ProviderType } from '../settings/types.js'
import { getProviderRegistry } from './providerRegistry.js'

type DeprecatedModelInfo = {
  isDeprecated: true
  modelName: string
  retirementDate: string
}

type NotDeprecatedInfo = {
  isDeprecated: false
}

type DeprecationInfo = DeprecatedModelInfo | NotDeprecatedInfo

type DeprecationEntry = {
  /** Human-readable model name */
  modelName: string
  /** Retirement dates by provider type (null = not deprecated for that provider) */
  retirementDates: Partial<Record<ProviderType, string | null>> & {
    /** Default retirement date for provider types not explicitly listed */
    default?: string | null
  }
}

/**
 * Deprecated models and their retirement dates by provider type.
 * Keys are substrings to match in model IDs (case-insensitive).
 * To add a new deprecated model, add an entry to this object.
 */
const DEPRECATED_MODELS: Record<string, DeprecationEntry> = {
  'claude-3-opus': {
    modelName: 'Claude 3 Opus',
    retirementDates: {
      default: 'January 5, 2026',
      'bedrock-converse': 'January 15, 2026',
    },
  },
  'claude-3-7-sonnet': {
    modelName: 'Claude 3.7 Sonnet',
    retirementDates: {
      default: 'February 19, 2026',
      'bedrock-converse': 'April 28, 2026',
      vertex: 'May 11, 2026',
    },
  },
  'claude-3-5-haiku': {
    modelName: 'Claude 3.5 Haiku',
    retirementDates: {
      anthropic: 'February 19, 2026',
      // Not deprecated on bedrock, vertex, foundry
    },
  },
}

/**
 * Check if a model is deprecated and get its deprecation info
 */
function getDeprecatedModelInfo(modelId: string): DeprecationInfo {
  const lowercaseModelId = modelId.toLowerCase()
  const providerType = getProviderRegistry().getProviderType(modelId)

  for (const [key, value] of Object.entries(DEPRECATED_MODELS)) {
    if (!lowercaseModelId.includes(key)) {
      continue
    }
    // Look up retirement date: check specific provider type first, then default
    const retirementDate =
      (providerType ? value.retirementDates[providerType] : undefined) ??
      value.retirementDates.default ??
      null
    if (!retirementDate) {
      continue
    }
    return {
      isDeprecated: true,
      modelName: value.modelName,
      retirementDate,
    }
  }

  return { isDeprecated: false }
}

/**
 * Get a deprecation warning message for a model, or null if not deprecated
 */
export function getModelDeprecationWarning(
  modelId: string | null,
): string | null {
  if (!modelId) {
    return null
  }

  const info = getDeprecatedModelInfo(modelId)
  if (!info.isDeprecated) {
    return null
  }

  return `⚠ ${info.modelName} will be retired on ${info.retirementDate}. Consider switching to a newer model.`
}
