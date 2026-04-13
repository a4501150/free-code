/**
 * Model string parser.
 *
 * All model strings in the system are provider-qualified: `provider:modelId[contextSuffix]`.
 * This module provides the single parsing/reassembly point for that format.
 *
 * Examples:
 *   "anthropic:claude-opus-4-6"        → { provider: "anthropic", modelId: "claude-opus-4-6", contextSuffix: "" }
 *   "anthropic:claude-opus-4-6[1m]"    → { provider: "anthropic", modelId: "claude-opus-4-6", contextSuffix: "[1m]" }
 *   "bedrock:us.anthropic.claude-opus-4-6-v1:0" → { provider: "bedrock", modelId: "us.anthropic.claude-opus-4-6-v1:0", contextSuffix: "" }
 *
 * Bedrock ARNs contain colons (e.g. "v1:0"). The parser only splits on the first
 * colon when the prefix matches a known registered provider name.
 */

export interface ParsedModelString {
  /** Provider name — always present. */
  provider: string
  /** Bare model ID with no context suffix. */
  modelId: string
  /** Context suffix, e.g. "[1m]" or "". */
  contextSuffix: string
  /** The original untouched input. */
  raw: string
}

const CONTEXT_SUFFIX_RE = /\[\d+m\]$/i

/**
 * Parse a model string into its components.
 *
 * @param input           Raw model string (e.g. "anthropic:claude-opus-4-6[1m]")
 * @param knownProviders  Set of registered provider names (used to disambiguate colons)
 * @param defaultProvider Fallback provider name when input has no provider prefix
 */
export function parseModelString(
  input: string,
  knownProviders: ReadonlySet<string>,
  defaultProvider: string,
): ParsedModelString {
  const raw = input
  let working = input.trim()

  // 1. Extract context suffix
  let contextSuffix = ''
  const suffixMatch = working.match(CONTEXT_SUFFIX_RE)
  if (suffixMatch) {
    contextSuffix = suffixMatch[0]
    working = working.slice(0, -contextSuffix.length).trim()
  }

  // 2. Try to split on first colon as provider separator
  const colonIdx = working.indexOf(':')
  if (colonIdx > 0) {
    const candidate = working.slice(0, colonIdx).toLowerCase()
    if (knownProviders.has(candidate)) {
      return {
        provider: candidate,
        modelId: working.slice(colonIdx + 1),
        contextSuffix,
        raw,
      }
    }
  }

  // 3. No provider prefix found — use default provider
  return {
    provider: defaultProvider,
    modelId: working,
    contextSuffix,
    raw,
  }
}

/**
 * Convenience wrapper that uses the singleton provider registry.
 */
export function parseModelStringFromRegistry(input: string): ParsedModelString {
  // Lazy import to avoid circular deps
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getProviderRegistry } = require('./providerRegistry.js') as {
    getProviderRegistry: () => {
      getProviderNames: () => Set<string>
      getDefaultProviderName: () => string | null
    }
  }
  const registry = getProviderRegistry()
  return parseModelString(
    input,
    registry.getProviderNames(),
    registry.getDefaultProviderName() ?? '',
  )
}

/**
 * Reassemble a parsed model string: "provider:modelId[contextSuffix]"
 */
export function toQualifiedString(parsed: ParsedModelString): string {
  return `${parsed.provider}:${parsed.modelId}${parsed.contextSuffix}`
}

/**
 * Strip the provider prefix from a model string, returning "modelId[contextSuffix]".
 */
export function stripProviderPrefix(model: string): string {
  const parsed = parseModelStringFromRegistry(model)
  return `${parsed.modelId}${parsed.contextSuffix}`
}

/**
 * Build a qualified model string from parts.
 */
export function qualifyModel(
  provider: string,
  modelId: string,
  contextSuffix?: string,
): string {
  return `${provider}:${modelId}${contextSuffix ?? ''}`
}
