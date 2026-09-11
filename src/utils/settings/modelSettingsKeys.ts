// The complete set of keys modelSettings.json owns; providers and model
// routing live ONLY there, everything else in freecode.json. A key outside
// this set is dropped by the reader BEFORE validation, so one bad key cannot
// take the whole provider configuration down with it.
export const MODEL_SETTINGS_KEYS: ReadonlySet<string> = new Set([
  'providers',
  'defaultModel',
  'defaultSubagentModel',
  'defaultSmallFastModel',
  'defaultBalancedModel',
  'defaultMostPowerfulModel',
  'availableSubagentModels',
  'modelOverrides',
  'teammateDefaultModel',
  'advisorConfig',
  'planAgentConfig',
])
