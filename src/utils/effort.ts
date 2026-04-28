// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import { isUltrathinkEnabled } from './thinking.js'
import { getInitialSettings } from './settings/settings.js'
import { getProviderRegistry } from './model/providerRegistry.js'

import { isEnvTruthy } from './envUtils.js'
import type { EffortLevel } from 'src/entrypoints/sdk/runtimeTypes.js'

export type { EffortLevel }

export const EFFORT_LEVELS = [
  'low',
  'medium',
  'high',
  'max',
  'xhigh',
] as const satisfies readonly EffortLevel[]

export type EffortValue = EffortLevel | number

export function modelSupportsEffort(model: string): boolean {
  if (isEnvTruthy(process.env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT)) {
    return true
  }
  // Per-model effortLevels from freecode.json
  const configLevels = getProviderRegistry().getModelEffortLevels(model)
  if (configLevels !== undefined) {
    return configLevels.length > 0
  }
  return false
}

/**
 * Return the configured effort levels for a model. Falls back to the
 * standard Anthropic set when no provider config is available.
 */
export function getModelEffortLevels(model: string): string[] {
  const configLevels = getProviderRegistry().getModelEffortLevels(model)
  if (configLevels !== undefined && configLevels.length > 0) {
    return configLevels
  }
  // Fallback: standard Anthropic levels
  if (modelSupportsMaxEffort(model)) {
    return ['low', 'medium', 'high', 'max']
  }
  return ['low', 'medium', 'high']
}

export function modelSupportsMaxEffort(model: string): boolean {
  const configLevels = getProviderRegistry().getModelEffortLevels(model)
  if (configLevels !== undefined) {
    return configLevels.includes('max')
  }
  return false
}

export function isEffortLevel(value: string): value is EffortLevel {
  return (EFFORT_LEVELS as readonly string[]).includes(value)
}

export function parseEffortValue(value: unknown): EffortValue | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined
  }
  if (typeof value === 'number' && isValidNumericEffort(value)) {
    return value
  }
  const str = String(value).toLowerCase()
  if (isEffortLevel(str)) {
    return str
  }
  const numericValue = parseInt(str, 10)
  if (!isNaN(numericValue) && isValidNumericEffort(numericValue)) {
    return numericValue
  }
  return undefined
}

/**
 * Numeric values are model-default only and not persisted.
 * 'max' is session-scoped for external users (ants can persist it).
 * Write sites call this before saving to settings so the Zod schema
 * (which only accepts string levels) never rejects a write.
 */
export function toPersistableEffort(
  value: EffortValue | undefined,
): EffortLevel | undefined {
  if (
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh'
  ) {
    return value
  }
  if (value === 'max' && (getInitialSettings()?.numericEffort ?? false)) {
    return value
  }
  return undefined
}

/**
 * Resolve the effort value that will actually be sent to the API for a given
 * model, following the precedence chain:
 *   effortOverride (skill/agent frontmatter, per-execution-context)
 *     → selectedEffort from provider config (user picker selection)
 *     → defaultEffort from provider config (model default, with ultrathink fallback)
 *
 * Returns undefined when no effort parameter should be sent.
 */
export function resolveAppliedEffort(
  model: string,
  effortOverride: EffortValue | undefined,
): EffortValue | undefined {
  const selectedEffort = getSelectedEffortForModel(model)
  const resolved =
    effortOverride ?? selectedEffort ?? getDefaultEffortForModel(model)
  // API rejects 'max' on non-Opus-4.6 models — downgrade to 'high'.
  if (resolved === 'max' && !modelSupportsMaxEffort(model)) {
    return 'high'
  }
  return resolved
}

/**
 * Get the user-selected effort for a model from provider config.
 * Returns undefined if no selectedEffort is persisted.
 */
function getSelectedEffortForModel(model: string): EffortValue | undefined {
  const selected = getProviderRegistry().getModelSelectedEffort(model)
  return selected !== undefined ? parseEffortValue(selected) : undefined
}

/**
 * Resolve the effort level to show the user. Wraps resolveAppliedEffort
 * with the 'high' fallback (what the API uses when no effort param is sent).
 * Single source of truth for the status bar and /effort output (CC-1088).
 */
export function getDisplayedEffortLevel(model: string): EffortLevel {
  const resolved = resolveAppliedEffort(model, undefined) ?? 'high'
  return convertEffortValueToLevel(resolved)
}

/**
 * Build the ` with {level} effort` suffix shown in Logo/Spinner.
 * Returns empty string if the resolved level matches the model's default.
 * Delegates to resolveAppliedEffort() so the displayed level matches what
 * the API actually receives (including max→high clamp for non-Opus models).
 */
export function getEffortSuffix(model: string): string {
  const resolved = resolveAppliedEffort(model, undefined)
  if (resolved === undefined) return ''
  const resolvedLevel = convertEffortValueToLevel(resolved)
  const modelDefault = getDefaultEffortForModel(model)
  const defaultLevel = modelDefault
    ? convertEffortValueToLevel(modelDefault)
    : 'high'
  if (resolvedLevel === defaultLevel) return ''
  return ` with ${resolvedLevel} effort`
}

export function isValidNumericEffort(value: number): boolean {
  return Number.isInteger(value)
}

export function convertEffortValueToLevel(value: EffortValue): EffortLevel {
  if (typeof value === 'string') {
    // Runtime guard: value may come from remote config where
    // TypeScript types can't help us. Coerce unknown strings to 'high'
    // rather than passing them through unchecked.
    return isEffortLevel(value) ? value : 'high'
  }
  if (
    (getInitialSettings()?.numericEffort ?? false) &&
    typeof value === 'number'
  ) {
    if (value <= 50) return 'low'
    if (value <= 85) return 'medium'
    if (value <= 100) return 'high'
    return 'max'
  }
  return 'high'
}

/**
 * Get user-facing description for effort levels
 *
 * @param level The effort level to describe
 * @returns Human-readable description
 */
export function getEffortLevelDescription(level: EffortLevel): string {
  switch (level) {
    case 'low':
      return 'Quick, straightforward implementation with minimal overhead'
    case 'medium':
      return 'Balanced approach with standard implementation and testing'
    case 'high':
      return 'Comprehensive implementation with extensive testing and documentation'
    case 'max':
      return 'Maximum capability with deepest reasoning'
    default:
      return level
  }
}

/**
 * Get user-facing description for effort values (both string and numeric)
 *
 * @param value The effort value to describe
 * @returns Human-readable description
 */
export function getEffortValueDescription(value: EffortValue): string {
  if (
    (getInitialSettings()?.numericEffort ?? false) &&
    typeof value === 'number'
  ) {
    return `Numeric effort value of ${value}`
  }

  if (typeof value === 'string') {
    return getEffortLevelDescription(value)
  }
  return 'Balanced approach with standard implementation and testing'
}

// @[MODEL LAUNCH]: Set defaultEffort on the model entry in legacyProviderMigration.ts.
export function getDefaultEffortForModel(
  model: string,
): EffortValue | undefined {
  // Per-model defaultEffort from freecode.json is the source of truth
  const configDefault = getProviderRegistry().getModelDefaultEffort(model)
  if (configDefault !== undefined) {
    return parseEffortValue(configDefault)
  }

  // When ultrathink feature is on, default effort to medium (ultrathink bumps to high)
  if (isUltrathinkEnabled() && modelSupportsEffort(model)) {
    return 'medium'
  }

  // Fallback to undefined, which means we don't set an effort level. This
  // should resolve to high effort level in the API.
  return undefined
}
