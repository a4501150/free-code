/**
 * Adapter registry.
 *
 * Maps `ProviderType` to its `ProviderAdapter` implementation. The registry
 * is consulted by token-counting call sites in `tokenEstimation.ts` and by
 * the streaming loop's `updateUsage`/`accumulateUsage` paths.
 *
 * Adapter lookups use a switch statement inside function bodies rather than
 * a top-level `const` map. This ensures imported adapter values are only
 * read at call time (after all modules have initialized), avoiding TDZ
 * errors when the Bun bundler flattens the circular module graph
 * (client.ts → adapters → tokenEstimation.ts → client.ts).
 */
import type { ProviderAdapter } from '../adapter.js'
import type {
  ProviderConfig,
  ProviderType,
} from '../../../utils/settings/types.js'
import { getProviderRegistry } from '../../../utils/model/providerRegistry.js'
import { anthropicAdapter } from './anthropic-adapter.js'
import { vertexAnthropicAdapter } from './vertex-adapter-impl.js'
import { foundryAdapter } from './foundry-adapter-impl.js'
import { bedrockAdapter } from './bedrock-adapter-impl.js'
import { openaiChatCompletionsAdapter } from './openai-chat-completions-adapter-impl.js'
import { codexAdapter } from './codex-adapter-impl.js'
import { geminiAdapter } from './gemini-adapter-impl.js'

const FALLBACK_PROVIDER_CONFIG: ProviderConfig = {
  type: 'anthropic',
  models: [],
  auth: { active: 'apiKey' },
}

export function getAdapterForProviderType(type: ProviderType): ProviderAdapter {
  switch (type) {
    case 'anthropic':
      return anthropicAdapter
    case 'vertex':
      return vertexAnthropicAdapter
    case 'foundry':
      return foundryAdapter
    case 'bedrock-converse':
      return bedrockAdapter
    case 'openai-chat-completions':
      return openaiChatCompletionsAdapter
    case 'openai-responses':
      return codexAdapter
    case 'gemini':
      return geminiAdapter
  }
}

/**
 * Resolve the adapter for a given model ID. Falls back to the Anthropic
 * adapter when the model is not in the provider registry (e.g. token-count
 * probes for unknown model names).
 */
export function getAdapterForModel(model: string): ProviderAdapter {
  const resolved = getProviderRegistry().getProviderForModel(model)
  if (resolved) {
    return getAdapterForProviderType(resolved.config.type) ?? anthropicAdapter
  }
  return anthropicAdapter
}

/**
 * Resolve the provider config passed to an adapter for a given model ID.
 * Unknown models use the default provider so validation probes still reach the
 * configured backend; the final fallback only covers an empty registry.
 */
export function getProviderConfigForModel(model: string): ProviderConfig {
  const registry = getProviderRegistry()
  return (
    registry.getProviderForModel(model)?.config ??
    registry.getDefaultProvider()?.config ??
    FALLBACK_PROVIDER_CONFIG
  )
}
