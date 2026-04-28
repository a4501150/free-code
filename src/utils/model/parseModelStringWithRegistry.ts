/**
 * Registry-backed helpers that wrap the pure parseModelString parser.
 *
 * Extracted from parseModelString.ts so the pure parser has no dependency on
 * the provider registry. This module is the single cut point for the
 * parseModelString ↔ providerRegistry cycle.
 */

import { parseModelString, type ParsedModelString } from './parseModelString.js'
import { getProviderRegistry } from './providerRegistry.js'

/**
 * Convenience wrapper that uses the singleton provider registry.
 */
export function parseModelStringFromRegistry(input: string): ParsedModelString {
  const registry = getProviderRegistry()
  return parseModelString(
    input,
    registry.getProviderNames(),
    registry.getDefaultProviderName() ?? '',
  )
}

/**
 * Strip the provider prefix from a model string, returning "modelId".
 */
export function stripProviderPrefix(model: string): string {
  const parsed = parseModelStringFromRegistry(model)
  return parsed.modelId
}
