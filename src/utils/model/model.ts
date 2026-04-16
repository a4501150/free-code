/**
 * Model utilities — barrel re-export.
 *
 * This file re-exports from the focused modules for backward compatibility.
 * All existing `import { ... } from './model.js'` continue to work unchanged.
 *
 * - modelTypes.ts: Shared type definitions (ModelName, ModelSetting, etc.)
 * - modelResolution.ts: Model selection/resolution logic
 * - modelDisplay.ts: Human-readable display strings
 *
 * Ensure that any model codenames introduced here are also added to
 * scripts/excluded-strings.txt to avoid leaking them.
 */

export type { ModelShortName, ModelName, ModelSetting } from './modelTypes.js'
export {
  getSmallFastModel,
  getUserSpecifiedModelSetting,
  getMainLoopModel,
  getRuntimeMainLoopModel,
  getDefaultMainLoopModelSetting,
  getDefaultMainLoopModel,
  parseUserSpecifiedModel,
  normalizeModelStringForAPI,
} from './modelResolution.js'
export {
  getClaudeAiUserDefaultModelDescription,
  renderModelSetting,
  renderDefaultModelSetting,
  getPublicModelDisplayName,
  renderModelName,
  getPublicModelName,
  modelDisplayString,
} from './modelDisplay.js'
