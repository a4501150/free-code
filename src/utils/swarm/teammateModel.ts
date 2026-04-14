import { getProviderRegistry } from '../model/providerRegistry.js'
import { getModelStrings } from '../model/modelStrings.js'

// @[MODEL LAUNCH]: Update the fallback model below.
// When the user has never set teammateDefaultModel in /config, new teammates
// use Opus 4.6. Must be provider-aware so Bedrock/Vertex/Foundry customers get
// the correct model ID.
export function getHardcodedTeammateModelFallback(): string {
  const opus46 = getModelStrings().opus46
  const resolved = getProviderRegistry().getProviderForModel(opus46)
  return resolved?.model.id ?? opus46
}
