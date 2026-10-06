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
 * errors when the Bun bundler flattens adapter cross-imports.
 */
import type { ProviderAdapter } from '../adapter.js'
import type { ProviderType } from '../../../utils/settings/types.js'
import { resolveProviderForModel } from './resolve.js'
import { anthropicAdapter } from './anthropic-adapter-impl.js'
import { vertexAnthropicAdapter } from './vertex-adapter-impl.js'
import { foundryAdapter } from './foundry-adapter-impl.js'
import { bedrockAdapter } from './bedrock-adapter-impl.js'
import { openaiChatCompletionsAdapter } from './openai-chat-completions-adapter-impl.js'
import { codexAdapter } from './codex-adapter-impl.js'
import { geminiAdapter } from './gemini-adapter-impl.js'

export { UnresolvedModelError, resolveProviderForModel } from './resolve.js'

export function getAdapterForProviderType(
  type: ProviderType,
): ProviderAdapter | undefined {
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
 * Resolve the adapter for a given model ID via strict provider resolution.
 * Throws {@link UnresolvedModelError} when no configured provider serves
 * the model; callers that treat token counting as best-effort catch it.
 */
export function getAdapterForModel(model: string): ProviderAdapter {
  const { config } = resolveProviderForModel(model)
  const adapter = getAdapterForProviderType(config.type)
  if (!adapter) {
    throw new Error(`No adapter registered for provider type "${config.type}"`)
  }
  return adapter
}
