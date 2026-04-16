import { getDefaultMainLoopModelSetting } from '../model/modelResolution.js'

// When the user has never set teammateDefaultModel in /config, new teammates
// use the configured default model from the provider registry.
export function getHardcodedTeammateModelFallback(): string {
  return getDefaultMainLoopModelSetting()
}
