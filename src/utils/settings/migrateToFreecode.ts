/**
 * One-shot migration from legacy `~/.claude/settings.json` →
 * `~/.claude/freecode.json`.
 *
 * Called only by the user-consented migration dialog in `showSetupScreens`.
 * Writes a complete `freecode.json` in a single pass:
 *
 *   1. Copy every field from `settings.json`.
 *   2. Synthesize a `providers` block from legacy env vars (the caller's
 *      `process.env` merged on top of `settings.json.env`).
 *   3. Promote legacy `model` / `ANTHROPIC_MODEL` / friends to top-level
 *      `defaultModel` / `defaultSubagentModel` / `defaultSmallFastModel`.
 *   4. Strip env vars that are now baked into the provider config.
 *   5. Pull `mcpServers` over from `~/.claude.json` if not already present.
 *
 * No circular deps — only uses fs, path, and envUtils.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { getClaudeConfigHomeDir } from "../envUtils.js";
import { safeParseJSON } from "../json.js";
import {
  orderFreecodeKeys,
  writeFreecodeSettingsFile,
} from "./freecodeSettings.js";
import { synthesizeProvidersFromLegacy } from "../model/legacyProviderMigration.js";
import { stripContextSuffix } from "../model/parseModelString.js";

/**
 * Env vars that become redundant once the migration has written a complete
 * providers block + default-model fields into freecode.json. These are
 * stripped from the migrated `settings.env` → `freecode.json.env` block so
 * later launches don't re-resolve them.
 *
 * NOTE: `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`, and
 * `ANTHROPIC_FOUNDRY_API_KEY` are NOT consumed — the provider config
 * references them by name via `tokenEnv` / `keyEnv` at request time.
 */
const CONSUMED_ENV_VARS: readonly string[] = [
  // Provider selection flags (now implied by provider type).
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_OPENAI",
  // Base URLs (now in provider config baseUrl).
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_FOUNDRY_BASE_URL",
  "ANTHROPIC_FOUNDRY_RESOURCE",
  // Region / project (now in provider config auth).
  "CLOUD_ML_REGION",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  // Model defaults (now promoted to defaultModel / etc.).
  "ANTHROPIC_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
];

function legacySettingsPath(): string {
  return join(getClaudeConfigHomeDir(), "settings.json");
}

/**
 * Does `~/.claude/settings.json` exist on disk?
 * Direct existence check — does not go through the settings cache.
 */
export function legacySettingsFileExists(): boolean {
  return existsSync(legacySettingsPath());
}

function readLegacySettings(): Record<string, unknown> | null {
  if (!legacySettingsFileExists()) return null;
  try {
    const parsed = safeParseJSON(readFileSync(legacySettingsPath(), "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Non-fatal
  }
  return null;
}

/**
 * Read ~/.claude.json directly (no config.ts import to avoid circular deps).
 * Used to migrate mcpServers from the global config file.
 */
function readGlobalClaudeJson(): Record<string, unknown> | null {
  const configPath = join(
    process.env.CLAUDE_CONFIG_DIR || homedir(),
    ".claude.json",
  );
  if (!existsSync(configPath)) return null;
  try {
    const parsed = safeParseJSON(readFileSync(configPath, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Non-fatal
  }
  return null;
}

/**
 * User-consented, one-shot migration of `~/.claude/settings.json` →
 * `~/.claude/freecode.json`. Writes a complete `freecode.json` in a single
 * pass. Safe to call even if `settings.json` is missing (becomes a no-op
 * write of `{}`).
 *
 * The caller (the setup-screen migration dialog) is responsible for:
 *   - Checking that the user consented.
 *   - Resetting the settings cache + provider registry after this returns.
 */
export function runLegacyToFreecodeMigration(): void {
  const legacy = readLegacySettings();
  const globalJson = readGlobalClaudeJson();
  const legacyEnv = (legacy?.env ?? {}) as Record<string, string | undefined>;

  const out: Record<string, unknown> = { ...(legacy ?? {}) };
  // Legacy `model` is superseded by top-level `defaultModel` (qualified).
  delete out.model;

  const { providers, defaultModel, defaultSubagentModel, defaultSmallFastModel } =
    synthesizeProvidersFromLegacy({
      env: { ...process.env, ...legacyEnv },
    });

  // Promote synthesized defaults, but let an explicit pre-existing field win
  // over env-derived output (matches the old per-field-guarded behavior).
  if (defaultModel && !out.defaultModel) out.defaultModel = defaultModel;
  if (defaultSubagentModel && !out.defaultSubagentModel)
    out.defaultSubagentModel = defaultSubagentModel;
  if (defaultSmallFastModel && !out.defaultSmallFastModel)
    out.defaultSmallFastModel = defaultSmallFastModel;

  // Legacy `settings.json.model` (not an env var) also gets promoted to
  // `defaultModel` if nothing stronger set it. Qualify with the default
  // provider so the registry can resolve it.
  if (!out.defaultModel && typeof legacy?.model === "string") {
    const defaultProviderName = Object.keys(providers)[0] ?? "anthropic";
    const bare = stripContextSuffix(legacy.model);
    out.defaultModel = bare.includes(":")
      ? bare
      : `${defaultProviderName}:${bare}`;
  }

  // Strip env vars whose value now lives in the providers block.
  const env = { ...(out.env as Record<string, string> | undefined ?? {}) };
  for (const key of CONSUMED_ENV_VARS) {
    delete env[key];
  }
  if (Object.keys(env).length > 0) {
    out.env = env;
  } else {
    delete out.env;
  }

  // Pull mcpServers over from ~/.claude.json if missing.
  if (!out.mcpServers) {
    const mcpServers = globalJson?.mcpServers;
    if (
      mcpServers &&
      typeof mcpServers === "object" &&
      Object.keys(mcpServers as Record<string, unknown>).length > 0
    ) {
      out.mcpServers = mcpServers;
    }
  }

  out.providers = providers;

  writeFreecodeSettingsFile(orderFreecodeKeys(out));
}

/**
 * One-time migration: project-level .claude/settings.json → .claude/freecode.json
 *
 * Copies project settings files to the new filenames. No field promotion needed
 * (unlike user-global, project settings don't have model env vars to migrate).
 * Old files are NOT deleted — migration copies, doesn't move.
 */
export function migrateProjectSettingsToFreecode(projectRoot: string): void {
  const pairs: Array<[string, string]> = [
    ["settings.json", "freecode.json"],
    ["settings.local.json", "freecode.local.json"],
  ];

  for (const [oldName, newName] of pairs) {
    const oldPath = join(projectRoot, ".claude", oldName);
    const newPath = join(projectRoot, ".claude", newName);

    if (existsSync(newPath)) continue;
    if (!existsSync(oldPath)) continue;

    try {
      const content = readFileSync(oldPath, "utf8");
      // Validate it's valid JSON before writing
      const parsed = safeParseJSON(content);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        continue;
      }
      mkdirSync(dirname(newPath), { recursive: true });
      writeFileSync(newPath, JSON.stringify(parsed, null, 2) + "\n", "utf8");
    } catch {
      // Non-fatal: skip this file if anything goes wrong
    }
  }
}
