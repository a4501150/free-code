/**
 * Strict model → provider resolution for the request path.
 *
 * Every outgoing API request must resolve to an explicitly configured
 * provider: either a provider-qualified model string ("provider:modelId")
 * or a bare wire model ID that exactly matches a model declared in some
 * provider's models list. There is no silent fallback to Anthropic — a
 * model no provider serves throws {@link UnresolvedModelError} instead of
 * being quietly sent to whichever provider happens to be first in config.
 *
 * The single tolerated fallback is env-var mode: when NO providers are
 * configured at all, requests go to the Anthropic Messages API (or
 * ANTHROPIC_BASE_URL) with ambient credentials, which is the standalone
 * CLI's zero-config behavior.
 *
 * Lives in its own module (rather than adapters/index.ts) because adapter
 * implementations import it while index.ts imports the adapters; keeping
 * it leaf-level avoids flattening order issues in the Bun bundler.
 */
import type { ResolvedProviderTarget } from '../adapter.js'
import type { ProviderConfig } from '../../../utils/settings/types.js'
import { getProviderRegistry } from '../../../utils/model/providerRegistry.js'

const FALLBACK_PROVIDER: ResolvedProviderTarget = {
  providerName: 'anthropic',
  config: {
    type: 'anthropic',
    models: [],
    auth: { active: 'apiKey' },
  } satisfies ProviderConfig,
}

/** Thrown when no configured provider serves the requested model. */
export class UnresolvedModelError extends Error {
  constructor(model: string) {
    super(
      `Model "${model}" is not served by any configured provider. ` +
        'Model references must be provider-qualified (e.g. "anthropic:claude-opus-5-5") ' +
        'or declared in a provider\'s "models" list in modelSettings.json.',
    )
    this.name = 'UnresolvedModelError'
  }
}

/**
 * Resolve the provider that serves a model. Throws
 * {@link UnresolvedModelError} when providers are configured but none
 * serves the model.
 */
export function resolveProviderForModel(
  model: string | undefined,
): ResolvedProviderTarget {
  const registry = getProviderRegistry()
  const resolved = model ? registry.getProviderForModel(model) : null
  if (resolved) return resolved
  if (!registry.hasProviders()) return FALLBACK_PROVIDER
  throw new UnresolvedModelError(model ?? '<no model>')
}
