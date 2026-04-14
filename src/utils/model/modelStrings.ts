import {
  getModelStrings as getModelStringsState,
  setModelStrings as setModelStringsState,
} from 'src/bootstrap/state.js'
import { logError } from '../log.js'
import { sequential } from '../sequential.js'
import { getInitialSettings } from '../settings/settings.js'
import { findFirstMatch, getBedrockInferenceProfiles } from './bedrock.js'
import { getProviderRegistry } from './providerRegistry.js'

// ── ModelKey definition ─────────────────────────────────────────────
// Authoritative list of model generation keys. Adding a new model
// requires adding its modelKey to legacyProviderMigration.ts model
// arrays AND adding it here.

export const MODEL_KEYS = [
  'haiku35',
  'haiku45',
  'sonnet35',
  'sonnet37',
  'sonnet40',
  'sonnet45',
  'sonnet46',
  'opus40',
  'opus41',
  'opus45',
  'opus46',
  'gpt54',
  'gpt53codex',
  'gpt54mini',
  'gpt52codex',
  'gpt51codex',
  'gpt51codexMini',
  'gpt51codexMax',
  'gpt52',
] as const

export type ModelKey = (typeof MODEL_KEYS)[number]

/**
 * Canonical first-party model IDs, keyed by ModelKey.
 * These are the Anthropic-direct model IDs used as the universal
 * reference for model identity (e.g. in modelOverrides keys).
 */
const CANONICAL_IDS: Record<ModelKey, string> = {
  haiku35: 'claude-3-5-haiku-20241022',
  haiku45: 'claude-haiku-4-5-20251001',
  sonnet35: 'claude-3-5-sonnet-20241022',
  sonnet37: 'claude-3-7-sonnet-20250219',
  sonnet40: 'claude-sonnet-4-20250514',
  sonnet45: 'claude-sonnet-4-5-20250929',
  sonnet46: 'claude-sonnet-4-6',
  opus40: 'claude-opus-4-20250514',
  opus41: 'claude-opus-4-1-20250805',
  opus45: 'claude-opus-4-5-20251101',
  opus46: 'claude-opus-4-6',
  gpt54: 'gpt-5.4',
  gpt53codex: 'gpt-5.3-codex',
  gpt54mini: 'gpt-5.4-mini',
  gpt52codex: 'gpt-5.2-codex',
  gpt51codex: 'gpt-5.1-codex',
  gpt51codexMini: 'gpt-5.1-codex-mini',
  gpt51codexMax: 'gpt-5.1-codex-max',
  gpt52: 'gpt-5.2',
}

/** Reverse map: canonical first-party ID → ModelKey */
const CANONICAL_ID_TO_KEY: Record<string, ModelKey> = Object.fromEntries(
  (Object.entries(CANONICAL_IDS) as [ModelKey, string][]).map(([key, id]) => [
    id,
    key,
  ]),
) as Record<string, ModelKey>

/** Runtime list of canonical model IDs. */
export const CANONICAL_MODEL_IDS = Object.values(CANONICAL_IDS) as [
  string,
  ...string[],
]

/**
 * Maps each model version to its provider-specific model ID string.
 */
export type ModelStrings = Record<ModelKey, string>

/**
 * Build ModelStrings from the provider registry's modelKey index.
 * Falls back to canonical (first-party) IDs for any keys not found
 * in the registry (e.g. user-configured providers missing some models).
 */
function getRegistryModelStrings(): ModelStrings {
  const registry = getProviderRegistry()
  const out = {} as ModelStrings
  for (const key of MODEL_KEYS) {
    const modelId = registry.getModelIdByKey(key)
    out[key] = modelId ?? CANONICAL_IDS[key]
  }
  return out
}

async function getBedrockModelStrings(): Promise<ModelStrings> {
  const fallback = getRegistryModelStrings()
  let profiles: string[] | undefined
  try {
    profiles = await getBedrockInferenceProfiles()
  } catch (error) {
    logError(error as Error)
    return fallback
  }
  if (!profiles?.length) {
    return fallback
  }
  // Each model's canonical first-party ID is the substring we search for in
  // the user's inference profile list (e.g. "claude-opus-4-6" matches
  // "eu.anthropic.claude-opus-4-6-v1"). Fall back to the registry-derived ID
  // when no matching profile is found.
  const out = {} as ModelStrings
  for (const key of MODEL_KEYS) {
    const needle = CANONICAL_IDS[key]
    out[key] = findFirstMatch(profiles, needle) || fallback[key]
  }
  return out
}

/**
 * Layer user-configured modelOverrides (from settings.json) on top of the
 * provider-derived model strings. Overrides are keyed by canonical first-party
 * model ID (e.g. "claude-opus-4-6") and map to arbitrary provider-specific
 * strings — typically Bedrock inference profile ARNs.
 */
function applyModelOverrides(ms: ModelStrings): ModelStrings {
  const overrides = getInitialSettings().modelOverrides
  if (!overrides) {
    return ms
  }
  const out = { ...ms }
  for (const [canonicalId, override] of Object.entries(overrides)) {
    const key = CANONICAL_ID_TO_KEY[canonicalId]
    if (key && override) {
      out[key] = override
    }
  }
  return out
}

/**
 * Resolve an overridden model ID (e.g. a Bedrock ARN) back to its canonical
 * first-party model ID. If the input doesn't match any current override value,
 * it is returned unchanged. Safe to call during module init (no-ops if settings
 * aren't loaded yet).
 */
export function resolveOverriddenModel(modelId: string): string {
  let overrides: Record<string, string> | undefined
  try {
    overrides = getInitialSettings().modelOverrides
  } catch {
    return modelId
  }
  if (!overrides) {
    return modelId
  }
  for (const [canonicalId, override] of Object.entries(overrides)) {
    if (override === modelId) {
      return canonicalId
    }
  }
  return modelId
}

function isBedrock(): boolean {
  return (
    getProviderRegistry().getDefaultProvider()?.config.type ===
    'bedrock-converse'
  )
}

const updateBedrockModelStrings = sequential(async () => {
  if (getModelStringsState() !== null) {
    // Already initialized. Doing the check here, combined with
    // `sequential`, allows the test suite to reset the state
    // between tests while still preventing multiple API calls
    // in production.
    return
  }
  try {
    const ms = await getBedrockModelStrings()
    setModelStringsState(ms)
  } catch (error) {
    logError(error as Error)
  }
})

function initModelStrings(): void {
  const ms = getModelStringsState()
  if (ms !== null) {
    // Already initialized
    return
  }
  // Initial with default values for non-Bedrock providers
  if (!isBedrock()) {
    setModelStringsState(getRegistryModelStrings())
    return
  }
  // On Bedrock, update model strings in the background without blocking.
  // Don't set the state in this case so that we can use `sequential` on
  // `updateBedrockModelStrings` and check for existing state on multiple
  // calls.
  void updateBedrockModelStrings()
}

export function getModelStrings(): ModelStrings {
  const ms = getModelStringsState()
  if (ms === null) {
    initModelStrings()
    // Bedrock path falls through here while the profile fetch runs in the
    // background — still honor overrides on the interim defaults.
    return applyModelOverrides(getRegistryModelStrings())
  }
  return applyModelOverrides(ms)
}

/**
 * Ensure model strings are fully initialized.
 * For Bedrock users, this waits for the profile fetch to complete.
 * Call this before generating model options to ensure correct region strings.
 */
export async function ensureModelStringsInitialized(): Promise<void> {
  const ms = getModelStringsState()
  if (ms !== null) {
    return
  }

  // For non-Bedrock, initialize synchronously
  if (!isBedrock()) {
    setModelStringsState(getRegistryModelStrings())
    return
  }

  // For Bedrock, wait for the profile fetch
  await updateBedrockModelStrings()
}
