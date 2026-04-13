import { getProviderRegistry } from '../model/providerRegistry.js'

// @[MODEL LAUNCH]: Update the fallback model below.
// When the user has never set teammateDefaultModel in /config, new teammates
// use Opus 4.6. Must be provider-aware so Bedrock/Vertex/Foundry customers get
// the correct model ID.
export function getHardcodedTeammateModelFallback(): string {
  const resolved = getProviderRegistry().getProviderForModel('claude-opus-4-6')
  return resolved?.model.id ?? 'claude-opus-4-6'
}
