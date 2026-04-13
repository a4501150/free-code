/**
 * Shared model type definitions.
 * Extracted to break circular dependencies between modelResolution and modelDisplay.
 */

import type { ModelAlias } from './aliases.js'

export type ModelShortName = string
export type ModelName = string
export type ModelSetting = ModelName | ModelAlias | null
