/**
 * Model resolution utilities.
 *
 * Determines which model to use based on user settings, provider configuration,
 * and environment variables. Pure resolution logic — no display string
 * generation (that lives in modelDisplay.ts).
 */

import { getMainLoopModelOverride } from "../../bootstrap/state.js";
import type { PermissionMode } from "../permissions/PermissionMode.js";
import { getProviderRegistry } from "./providerRegistry.js";
import type { ModelName, ModelSetting } from "./modelTypes.js";
import { qualifyModel, stripContextSuffix } from "./parseModelString.js";
import { parseModelStringFromRegistry } from "./parseModelStringWithRegistry.js";
import { getInitialSettings } from "../settings/settings.js";

// Re-export types from modelTypes for backward compat
export type { ModelShortName, ModelName, ModelSetting } from "./modelTypes.js";

export function getSmallFastModel(): ModelName {
  // Priority: env var > freecode.json defaultSmallFastModel > defaultModel
  if (process.env.ANTHROPIC_SMALL_FAST_MODEL) {
    return qualifyWithDefault(
      stripContextSuffix(process.env.ANTHROPIC_SMALL_FAST_MODEL),
    );
  }
  const configured = getProviderRegistry().getConfiguredDefaultSmallFastModel();
  if (configured) {
    return configured as ModelName;
  }
  // Fall back to the main default model (no separate "haiku" fallback)
  return getDefaultMainLoopModel();
}

/**
 * Helper to get the model from /model (including via /config), the --model flag, environment variable,
 * or the saved settings. The returned value is always a full model ID.
 * Undefined if the user didn't configure anything, in which case we fall back to
 * the default (null).
 *
 * Priority order within this function:
 * 1. Model override during session (from /model command) - highest priority
 * 2. Model override at startup (from --model flag)
 * 3. ANTHROPIC_MODEL environment variable
 * 4. Settings (from user's saved settings)
 */
export function getUserSpecifiedModelSetting(): ModelSetting | undefined {
  let specifiedModel: ModelSetting | undefined;

  const modelOverride = getMainLoopModelOverride();
  if (modelOverride !== undefined) {
    // Session override from /model command or --model flag — highest priority
    specifiedModel = modelOverride;
  } else {
    // Priority: env var > freecode.json defaultModel
    const envModel = process.env.ANTHROPIC_MODEL;
    if (envModel) {
      specifiedModel = stripContextSuffix(envModel);
    } else {
      const registry = getProviderRegistry();
      specifiedModel = registry.getConfiguredDefaultModel() || undefined;
    }
  }

  return specifiedModel;
}

/**
 * Get the main loop model to use for the current session.
 *
 * Model Selection Priority Order:
 * 1. Model override during session (from /model command) - highest priority
 * 2. Model override at startup (from --model flag)
 * 3. ANTHROPIC_MODEL environment variable
 * 4. Settings (from user's saved settings)
 * 5. Built-in default (first model in registry)
 *
 * @returns The resolved model name to use
 */
export function getMainLoopModel(): ModelName {
  const model = getUserSpecifiedModelSetting();
  if (model !== undefined && model !== null) {
    return parseUserSpecifiedModel(model);
  }
  return getDefaultMainLoopModel();
}

/**
 * Helper to qualify a bare model ID with the default provider name.
 * If the model is already qualified, returns it as-is.
 */
function qualifyWithDefault(bareModelId: string): ModelName {
  const registry = getProviderRegistry();
  const parsed = parseModelStringFromRegistry(bareModelId);
  // Use the parsed provider if it was explicitly qualified, otherwise use default
  const provider = parsed.provider || registry.getDefaultProviderName() || "";
  return qualifyModel(provider, parsed.modelId);
}

/**
 * Get the model to use for runtime, depending on the runtime context.
 * If planModeModel is configured, uses it in plan mode.
 */
export function getRuntimeMainLoopModel(params: {
  permissionMode: PermissionMode;
  mainLoopModel: string;
  exceeds200kTokens?: boolean;
}): ModelName {
  const { permissionMode, mainLoopModel, exceeds200kTokens = false } = params;

  // If planModeModel is configured and we're in plan mode, use it
  if (permissionMode === "plan" && !exceeds200kTokens) {
    const planModel = getInitialSettings().planModeModel;
    if (planModel) {
      return parseUserSpecifiedModel(planModel);
    }
  }

  return mainLoopModel;
}

/**
 * Get the default main loop model setting.
 *
 * Returns freecode.json defaultModel, or the first model ID from the registry.
 */
export function getDefaultMainLoopModelSetting(): ModelName | string {
  const registry = getProviderRegistry();
  const configured = registry.getConfiguredDefaultModel();
  if (configured) {
    return configured;
  }
  // Fall back to first model in the registry
  const allModels = registry.getAllModels();
  if (allModels.length > 0) {
    const first = allModels[0]!;
    return qualifyModel(first.providerName, first.model.id);
  }
  throw new Error(
    'No models are configured in the provider registry. Configure at least one provider model or set a default model.',
  );
}

/**
 * Synchronous operation to get the default main loop model to use
 * (bypassing any user-specified values).
 */
export function getDefaultMainLoopModel(): ModelName {
  return parseUserSpecifiedModel(getDefaultMainLoopModelSetting());
}

/**
 * Returns a fully-qualified model name for use in this session.
 * Qualifies bare model IDs with the default provider prefix.
 */
export function parseUserSpecifiedModel(modelInput: string): ModelName {
  const parsed = parseModelStringFromRegistry(modelInput);
  // Return the qualified string, preserving original case for custom model
  // names (e.g., Azure Foundry deployment IDs)
  return qualifyModel(parsed.provider, parsed.modelId);
}

export function normalizeModelStringForAPI(model: string): string {
  return parseModelStringFromRegistry(model).modelId;
}
