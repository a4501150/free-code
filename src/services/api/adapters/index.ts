/**
 * Adapter registry.
 *
 * Maps `ProviderType` to its `ProviderAdapter` implementation. The registry
 * is consulted by token-counting call sites in `tokenEstimation.ts` and (in
 * Step 3) by the streaming loop's `updateUsage`/`accumulateUsage` paths.
 */
import type { ProviderAdapter } from '../adapter.js'
import type { ProviderType } from '../../../utils/settings/types.js'
import { getProviderRegistry } from '../../../utils/model/providerRegistry.js'
import { anthropicAdapter } from './anthropic-adapter.js'
import { vertexAnthropicAdapter } from './vertex-adapter-impl.js'
import { foundryAdapter } from './foundry-adapter-impl.js'
import { bedrockAdapter } from './bedrock-adapter-impl.js'
import { openaiChatCompletionsAdapter } from './openai-chat-completions-adapter-impl.js'
import { codexAdapter } from './codex-adapter-impl.js'
import { geminiAdapter } from './gemini-adapter-impl.js'

const ADAPTERS: Record<ProviderType, ProviderAdapter> = {
  anthropic: anthropicAdapter,
  vertex: vertexAnthropicAdapter,
  foundry: foundryAdapter,
  'bedrock-converse': bedrockAdapter,
  'openai-chat-completions': openaiChatCompletionsAdapter,
  'openai-responses': codexAdapter,
  gemini: geminiAdapter,
}

export function getAdapterForProviderType(type: ProviderType): ProviderAdapter {
  return ADAPTERS[type]
}

/**
 * Resolve the adapter for a given model ID. Falls back to the Anthropic
 * adapter when the model is not in the provider registry (e.g. token-count
 * probes for unknown model names).
 */
export function getAdapterForModel(model: string): ProviderAdapter {
  const resolved = getProviderRegistry().getProviderForModel(model)
  if (resolved) {
    return ADAPTERS[resolved.config.type] ?? anthropicAdapter
  }
  return anthropicAdapter
}
