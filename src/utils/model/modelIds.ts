/**
 * Model ID Constants & Wire Resolution
 *
 * Canonical first-party model IDs and the mechanism to resolve them to
 * provider-specific wire IDs (e.g. Bedrock inference profile ARNs).
 *
 * This replaces the old ModelKey / ModelStrings system. The codebase
 * should reference models by their canonical ID constant (e.g. OPUS_46)
 * and call getWireModelId() when the provider-specific wire string is needed.
 */

import { logError } from '../log.js'
import { sequential } from '../sequential.js'
import { getInitialSettings } from '../settings/settings.js'
import { findFirstMatch, getBedrockInferenceProfiles } from './bedrock.js'
import { getProviderRegistry } from './providerRegistry.js'

// ── Wire ID resolution ──────────────────────────────────────────────
// Provider-specific model IDs may differ from canonical IDs (e.g. Bedrock
// uses regional inference profile ARNs). This module caches the mapping
// and resolves on demand.

/** Module-local cache of Bedrock inference profile overrides: canonical → wire ID */
let bedrockWireIds: Map<string, string> | null = null

/** Whether Bedrock init has been triggered (but may still be in-flight) */
let bedrockInitStarted = false

/**
 * Resolve a canonical model ID to the provider-specific wire ID.
 *
 * For Anthropic direct: returns the canonical ID unchanged.
 * For Bedrock: returns the inference profile ARN or region-prefixed ID.
 * Applies modelOverrides from settings on top.
 */
export function getWireModelId(canonicalId: string): string {
  // 1. Check Bedrock inference profiles
  if (bedrockWireIds) {
    const bedrockId = bedrockWireIds.get(canonicalId)
    if (bedrockId) {
      return applyModelOverride(canonicalId, bedrockId)
    }
  }

  // 2. Check provider registry for a model whose canonical ID matches
  const registry = getProviderRegistry()
  const resolved = registry.getModelByCanonicalId(canonicalId)
  if (resolved) {
    return applyModelOverride(canonicalId, resolved.model.id)
  }

  // 3. Fallback: use canonical ID directly, apply overrides
  return applyModelOverride(canonicalId, canonicalId)
}

/**
 * Apply user-configured modelOverrides from freecode.json on top of a resolved wire ID.
 * Overrides are keyed by canonical first-party model ID.
 */
function applyModelOverride(canonicalId: string, wireId: string): string {
  let overrides: Record<string, string> | undefined
  try {
    overrides = getInitialSettings().modelOverrides
  } catch {
    return wireId
  }
  if (!overrides) return wireId
  return overrides[canonicalId] ?? wireId
}

/**
 * Resolve an overridden model ID (e.g. a Bedrock ARN) back to its canonical
 * first-party model ID. If the input doesn't match any current override value,
 * it is returned unchanged. Safe to call during module init.
 */
export function resolveOverriddenModel(modelId: string): string {
  let overrides: Record<string, string> | undefined
  try {
    overrides = getInitialSettings().modelOverrides
  } catch {
    return modelId
  }
  if (!overrides) return modelId
  for (const [canonicalId, override] of Object.entries(overrides)) {
    if (override === modelId) {
      return canonicalId
    }
  }
  return modelId
}

// ── Bedrock initialization ──────────────────────────────────────────

function isBedrock(): boolean {
  return (
    getProviderRegistry().getDefaultProvider()?.config.type ===
    'bedrock-converse'
  )
}

const updateBedrockWireIds = sequential(async () => {
  if (bedrockWireIds !== null) return // Already initialized
  try {
    const profiles = await getBedrockInferenceProfiles()
    if (!profiles?.length) {
      bedrockWireIds = new Map()
      return
    }
    const map = new Map<string, string>()
    // Derive canonical IDs from the provider registry (single source of truth)
    for (const { model } of getProviderRegistry().getAllModels()) {
      const match = findFirstMatch(profiles, model.id)
      if (match) {
        map.set(model.id, match)
      }
    }
    bedrockWireIds = map
  } catch (error) {
    logError(error as Error)
    bedrockWireIds = new Map() // Empty map so we don't retry
  }
})

function initWireIds(): void {
  if (bedrockInitStarted) return
  bedrockInitStarted = true

  if (!isBedrock()) {
    bedrockWireIds = new Map() // No-op for non-Bedrock
    return
  }
  // On Bedrock, start background fetch (non-blocking)
  void updateBedrockWireIds()
}

/**
 * Ensure wire model IDs are fully initialized.
 * For Bedrock users, this waits for the profile fetch to complete.
 * Call this before generating model options to ensure correct region strings.
 */
export async function ensureWireModelIdsInitialized(): Promise<void> {
  if (bedrockWireIds !== null) return
  if (!isBedrock()) {
    bedrockWireIds = new Map()
    return
  }
  await updateBedrockWireIds()
}

// Trigger init on first import (non-blocking for Bedrock)
// This ensures the cache is warmed before first getWireModelId() call
try {
  initWireIds()
} catch {
  // Swallow errors during module init
}

// ── Test utilities ──────────────────────────────────────────────────

export function resetWireModelIdsForTesting(): void {
  bedrockWireIds = null
  bedrockInitStarted = false
}
