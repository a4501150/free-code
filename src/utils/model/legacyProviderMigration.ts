/**
 * Legacy Provider Migration
 *
 * Auto-generates provider configs from legacy environment variables
 * when settings.providers is not explicitly configured.
 *
 * This ensures backward compatibility: existing users who rely on
 * ANTHROPIC_API_KEY, CLAUDE_CODE_USE_BEDROCK, etc. continue to work
 * without any config changes.
 */

import type { ProviderConfig, ProviderModelConfig } from "../settings/types.js";
import { isEnvTruthy } from "../envUtils.js";

/** Return type of migrateFromLegacyEnvVars */
export interface LegacyMigrationResult {
  providers: Record<string, ProviderConfig>;
  defaultModel?: string;
  defaultSubagentModel?: string;
  defaultSmallFastModel?: string;
}
import { getSettingsForSource } from "../settings/settings.js";

// ── Default Claude models ────────────────────────────────────────────

// Shared capability presets for Claude models (1P / Foundry)
const CLAUDE_46_CAPS = {
  thinking: true,
  adaptiveThinking: true,
  interleavedThinking: true,
  serverContextManagement: true,
  structuredOutputs: true,
} as const;

const CLAUDE_4X_CAPS = {
  thinking: true,
  adaptiveThinking: false,
  interleavedThinking: true,
  serverContextManagement: true,
  structuredOutputs: true,
} as const;

// 3P (Bedrock/Vertex) — no server context management or structured outputs betas
const CLAUDE_46_3P_CAPS = {
  thinking: true,
  adaptiveThinking: true,
  interleavedThinking: true,
  serverContextManagement: false,
  structuredOutputs: false,
} as const;

const CLAUDE_4X_3P_CAPS = {
  thinking: true,
  adaptiveThinking: false,
  interleavedThinking: true,
  serverContextManagement: false,
  structuredOutputs: false,
} as const;

// ── Pricing presets (per Mtok, USD) ──────────────────────────────────
// @see https://platform.claude.com/docs/en/about-claude/pricing

const SONNET_PRICING = {
  input: 3,
  output: 15,
  cacheWrite: 3.75,
  cacheRead: 0.3,
  webSearch: 0.01,
} as const;

const OPUS_46_PRICING = {
  input: 5,
  output: 25,
  cacheWrite: 6.25,
  cacheRead: 0.5,
  webSearch: 0.01,
} as const;

const HAIKU_45_PRICING = {
  input: 1,
  output: 5,
  cacheWrite: 1.25,
  cacheRead: 0.1,
  webSearch: 0.01,
} as const;

const DEFAULT_ANTHROPIC_MODELS: ProviderModelConfig[] = [
  {
    id: "claude-opus-4-6",
    label: "Opus 4.6",

    description: "Most capable",
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    maxOutputTokensDefault: 64_000,

    pricing: OPUS_46_PRICING,
    effortLevels: ["low", "medium", "high", "max"],
    defaultEffort: "high",
    ...CLAUDE_46_CAPS,
  },
  {
    id: "claude-sonnet-4-6",
    label: "Sonnet 4.6",

    description: "Fast and capable",
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    maxOutputTokensDefault: 32_000,

    pricing: SONNET_PRICING,
    effortLevels: ["low", "medium", "high", "max"],
    defaultEffort: "high",
    ...CLAUDE_46_CAPS,
  },
  {
    id: "claude-haiku-4-5-20251001",
    label: "Haiku 4.5",

    description: "Fastest",
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    maxOutputTokensDefault: 64_000,
    pricing: HAIKU_45_PRICING,
    ...CLAUDE_4X_CAPS,
  },
  {
    id: "claude-opus-4-5-20251101",
    label: "Opus 4.5",

    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    maxOutputTokensDefault: 64_000,
    pricing: OPUS_46_PRICING,
    effortLevels: ["low", "medium", "high"],
    defaultEffort: "high",
    ...CLAUDE_4X_CAPS,
  },
  {
    id: "claude-sonnet-4-5-20250929",
    label: "Sonnet 4.5",

    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    maxOutputTokensDefault: 32_000,
    pricing: SONNET_PRICING,
    ...CLAUDE_4X_CAPS,
  },
];

const DEFAULT_BEDROCK_MODELS: ProviderModelConfig[] = [
  {
    id: "us.anthropic.claude-opus-4-6-v1",
    label: "Opus 4.6",

    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    maxOutputTokensDefault: 64_000,

    effortLevels: ["low", "medium", "high", "max"],
    defaultEffort: "high",
    ...CLAUDE_46_3P_CAPS,
  },
  {
    id: "us.anthropic.claude-sonnet-4-6",
    label: "Sonnet 4.6",

    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    maxOutputTokensDefault: 32_000,

    effortLevels: ["low", "medium", "high", "max"],
    defaultEffort: "high",
    ...CLAUDE_46_3P_CAPS,
  },
  {
    id: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    label: "Haiku 4.5",

    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    maxOutputTokensDefault: 64_000,
    ...CLAUDE_4X_3P_CAPS,
  },
  {
    id: "us.anthropic.claude-opus-4-5-20251101-v1:0",
    label: "Opus 4.5",

    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    maxOutputTokensDefault: 64_000,
    effortLevels: ["low", "medium", "high"],
    defaultEffort: "high",
    ...CLAUDE_4X_3P_CAPS,
  },
  {
    id: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
    label: "Sonnet 4.5",

    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    maxOutputTokensDefault: 32_000,
    ...CLAUDE_4X_3P_CAPS,
  },
];

const DEFAULT_VERTEX_MODELS: ProviderModelConfig[] = [
  {
    id: "claude-opus-4-6",
    label: "Opus 4.6",

    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    maxOutputTokensDefault: 64_000,

    effortLevels: ["low", "medium", "high", "max"],
    defaultEffort: "high",
    ...CLAUDE_46_3P_CAPS,
  },
  {
    id: "claude-sonnet-4-6",
    label: "Sonnet 4.6",

    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    maxOutputTokensDefault: 32_000,

    effortLevels: ["low", "medium", "high", "max"],
    defaultEffort: "high",
    ...CLAUDE_46_3P_CAPS,
  },
  {
    id: "claude-haiku-4-5@20251001",
    label: "Haiku 4.5",

    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    maxOutputTokensDefault: 64_000,
    ...CLAUDE_4X_3P_CAPS,
  },
  {
    id: "claude-opus-4-5@20251101",
    label: "Opus 4.5",

    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    maxOutputTokensDefault: 64_000,
    effortLevels: ["low", "medium", "high"],
    defaultEffort: "high",
    ...CLAUDE_4X_3P_CAPS,
  },
  {
    id: "claude-sonnet-4-5@20250929",
    label: "Sonnet 4.5",

    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    maxOutputTokensDefault: 32_000,
    ...CLAUDE_4X_3P_CAPS,
  },
];

const DEFAULT_FOUNDRY_MODELS: ProviderModelConfig[] = [
  {
    id: "claude-opus-4-6",
    label: "Opus 4.6",

    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    maxOutputTokensDefault: 64_000,

    effortLevels: ["low", "medium", "high", "max"],
    defaultEffort: "high",
    ...CLAUDE_46_CAPS,
  },
  {
    id: "claude-sonnet-4-6",
    label: "Sonnet 4.6",

    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    maxOutputTokensDefault: 32_000,

    effortLevels: ["low", "medium", "high", "max"],
    defaultEffort: "high",
    ...CLAUDE_46_CAPS,
  },
  {
    id: "claude-haiku-4-5",
    label: "Haiku 4.5",

    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    maxOutputTokensDefault: 64_000,
    ...CLAUDE_4X_CAPS,
  },
  {
    id: "claude-sonnet-4-5",
    label: "Sonnet 4.5",

    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    maxOutputTokensDefault: 32_000,
    ...CLAUDE_4X_CAPS,
  },
];

// OpenAI models: thinking translated to reasoning_effort by adapter
const OPENAI_CAPS = {
  thinking: true,
  adaptiveThinking: false,
  interleavedThinking: false,
  serverContextManagement: false,
  structuredOutputs: false,
} as const;

const DEFAULT_CODEX_MODELS: ProviderModelConfig[] = [
  {
    id: "gpt-5.4",
    label: "GPT-5.4",

    description: "Latest GPT",
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    maxOutputTokensDefault: 128_000,
    effortLevels: ["none", "low", "medium", "high", "xhigh"],
    ...OPENAI_CAPS,
  },
  {
    id: "gpt-5.3-codex",
    label: "GPT-5.3 Codex",

    description: "Frontier agentic coding",
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    maxOutputTokensDefault: 128_000,
    effortLevels: ["low", "medium", "high", "xhigh"],
    ...OPENAI_CAPS,
  },
  {
    id: "gpt-5.4-mini",
    label: "GPT-5.4 Mini",

    description: "Fast GPT",
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    maxOutputTokensDefault: 128_000,
    effortLevels: ["none", "low", "medium", "high", "xhigh"],
    ...OPENAI_CAPS,
  },
];

// ── Migration logic ──────────────────────────────────────────────────

/**
 * Generate provider configs from legacy environment variables.
 * Called at startup when settings.providers is absent.
 *
 * @param opts.oauthTokens - OAuth tokens from secure storage (if available).
 *   Passed in by the registry's lazy init to avoid circular deps.
 */
export function migrateFromLegacyEnvVars(opts?: {
  oauthTokens?: { accessToken: string } | null;
}): LegacyMigrationResult {
  const providers: Record<string, ProviderConfig> = {};

  // Read settings.env block as fallback — these env vars may not be in
  // process.env yet if applySafeConfigEnvironmentVariables() hasn't run.
  const settingsEnv =
    (getSettingsForSource("userSettings")?.env as
      | Record<string, string>
      | undefined) ?? {};
  const getEnv = (key: string): string | undefined =>
    process.env[key] || settingsEnv[key];

  if (isEnvTruthy(getEnv("CLAUDE_CODE_USE_BEDROCK"))) {
    const region = getEnv("AWS_REGION") || getEnv("AWS_DEFAULT_REGION");
    providers["bedrock"] = {
      type: "bedrock-converse",
      cache: { type: "none" },
      auth: {
        active: "aws",
        aws: { region: region || "us-east-1" },
      },
      models: DEFAULT_BEDROCK_MODELS,
    };
  } else if (isEnvTruthy(getEnv("CLAUDE_CODE_USE_VERTEX"))) {
    const region = getEnv("CLOUD_ML_REGION");
    const projectId = getEnv("ANTHROPIC_VERTEX_PROJECT_ID");
    providers["vertex"] = {
      type: "vertex",
      cache: { type: "explicit-breakpoint" },
      auth: {
        active: "gcp",
        gcp: {
          ...(region ? { region } : {}),
          ...(projectId ? { projectId } : {}),
        },
      },
      models: DEFAULT_VERTEX_MODELS,
    };
  } else if (isEnvTruthy(getEnv("CLAUDE_CODE_USE_FOUNDRY"))) {
    // Resolve Foundry env vars into config so the adapter stays pure
    const foundryResource = getEnv("ANTHROPIC_FOUNDRY_RESOURCE");
    const foundryBaseUrl =
      getEnv("ANTHROPIC_FOUNDRY_BASE_URL") ||
      (foundryResource
        ? `https://${foundryResource}.services.ai.azure.com/anthropic`
        : undefined);
    const foundryApiKey = getEnv("ANTHROPIC_FOUNDRY_API_KEY");
    providers["foundry"] = {
      type: "foundry",
      ...(foundryBaseUrl ? { baseUrl: foundryBaseUrl } : {}),
      cache: { type: "none" },
      auth: {
        active: foundryApiKey ? "apiKey" : "azure",
        ...(foundryApiKey
          ? { apiKey: { keyEnv: "ANTHROPIC_FOUNDRY_API_KEY" } }
          : { azure: {} }),
      },
      models: DEFAULT_FOUNDRY_MODELS,
    };
  } else if (isEnvTruthy(getEnv("CLAUDE_CODE_USE_OPENAI"))) {
    // OpenAI/Codex provider — uses openai-responses transform
    providers["codex"] = {
      type: "openai-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      cache: { type: "automatic-prefix" },
      auth: {
        active: "oauth",
        oauth: { accessToken: "" }, // filled at runtime from Codex OAuth tokens
      },
      models: DEFAULT_CODEX_MODELS,
    };
  } else {
    // Default: Anthropic direct API
    const baseUrl = getEnv("ANTHROPIC_BASE_URL");
    const hasAuthToken = !!getEnv("ANTHROPIC_AUTH_TOKEN");
    let auth: ProviderConfig["auth"];
    if (opts?.oauthTokens?.accessToken) {
      // Claude.ai OAuth subscriber — tokens from secure storage
      auth = {
        active: "oauth",
        oauth: {
          accessToken: opts.oauthTokens.accessToken,
        },
      };
    } else if (hasAuthToken) {
      auth = {
        active: "bearer",
        bearer: { tokenEnv: "ANTHROPIC_AUTH_TOKEN" },
      };
    } else {
      auth = {
        active: "apiKey",
        apiKey: { keyEnv: "ANTHROPIC_API_KEY" },
      };
    }

    providers["anthropic"] = {
      type: "anthropic",
      ...(baseUrl ? { baseUrl } : {}),
      cache: { type: "explicit-breakpoint" },
      auth,
      models: DEFAULT_ANTHROPIC_MODELS,
    };
  }

  // Migrate legacy model selection to defaultModel/defaultSubagentModel.
  // Sources: real env vars, managed env vars in settings.env, and settings.model.
  // Cannot use parseUserSpecifiedModel() here (registry not yet initialized),
  // so we do simple provider:modelId qualification.
  const defaultProviderName = Object.keys(providers)[0] ?? "anthropic";

  // Strip legacy [Nm] context suffixes — context window is now config-driven
  const stripContextSuffix = (m: string): string =>
    m.replace(/\[\d+m\]$/i, "");
  const qualify = (model: string): string => {
    const bare = stripContextSuffix(model);
    return bare.includes(":") ? bare : `${defaultProviderName}:${bare}`;
  };

  const envModel = getEnv("ANTHROPIC_MODEL");
  const settingsModel = getSettingsForSource("userSettings")?.model;
  const rawDefaultModel = envModel || settingsModel || undefined;
  const defaultModel = rawDefaultModel ? qualify(rawDefaultModel) : undefined;

  const envSubagent = getEnv("CLAUDE_CODE_SUBAGENT_MODEL");
  const defaultSubagentModel = envSubagent ? qualify(envSubagent) : undefined;

  const envSmallFast =
    getEnv("ANTHROPIC_SMALL_FAST_MODEL") ||
    getEnv("ANTHROPIC_DEFAULT_HAIKU_MODEL");
  const defaultSmallFastModel = envSmallFast
    ? qualify(envSmallFast)
    : undefined;

  return {
    providers,
    defaultModel,
    defaultSubagentModel,
    defaultSmallFastModel,
  };
}

// Re-export default model lists for use in other modules
export {
  DEFAULT_ANTHROPIC_MODELS,
  DEFAULT_BEDROCK_MODELS,
  DEFAULT_VERTEX_MODELS,
  DEFAULT_FOUNDRY_MODELS,
  DEFAULT_CODEX_MODELS,
};

