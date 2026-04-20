/**
 * Migration: settings.json → freecode.json with per-field guards.
 *
 * Each field promotion checks freecode.json first — if the field already
 * exists, it's a no-op. If missing, we try to migrate from settings.json
 * or env var overrides. This makes migrations idempotent and allows new
 * field promotions to backfill on subsequent runs.
 *
 * No circular deps — only uses fs, path, and envUtils.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { getClaudeConfigHomeDir } from "../envUtils.js";
import { safeParseJSON } from "../json.js";
import {
  freecodeSettingsFileExists,
  readFreecodeSettingsFile,
  writeFreecodeSettingsFile,
} from "./freecodeSettings.js";
import { stripContextSuffix } from "../model/parseModelString.js";

function readLegacySettings(): Record<string, unknown> | null {
  const settingsPath = join(getClaudeConfigHomeDir(), "settings.json");
  if (!existsSync(settingsPath)) return null;
  try {
    const parsed = safeParseJSON(readFileSync(settingsPath, "utf8"));
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

export function migrateToFreecodeSettings(): void {
  const existing = freecodeSettingsFileExists()
    ? (readFreecodeSettingsFile() ?? {})
    : {};
  const legacy = readLegacySettings();

  // If neither source has anything, nothing to do
  if (
    Object.keys(existing).length === 0 &&
    (!legacy || Object.keys(legacy).length === 0)
  )
    return;

  // Start from existing freecode.json (or empty for initial migration)
  const isInitial = !freecodeSettingsFileExists();
  const settings: Record<string, unknown> = { ...existing };
  let changed = isInitial; // initial migration always writes

  // On initial migration, copy all legacy settings as the base
  if (isInitial && legacy) {
    Object.assign(settings, legacy);
  }

  // Simple provider qualifier — prepend default provider if not already qualified.
  // Cannot use providerRegistry here (not yet initialized), same approach as legacyProviderMigration.
  const defaultProvider =
    (settings.providers && typeof settings.providers === "object"
      ? Object.keys(settings.providers)[0]
      : undefined) ?? "anthropic";
  const qualify = (model: string): string => {
    const bare = stripContextSuffix(model);
    return bare.includes(":") ? bare : `${defaultProvider}:${bare}`;
  };

  // --- Per-field promotions (each guarded individually) ---

  // Promote deprecated settings.model → defaultModel (qualified)
  if (!settings.defaultModel) {
    const model = settings.model ?? legacy?.model;
    if (model && typeof model === "string") {
      settings.defaultModel = qualify(model);
      changed = true;
    }
  }

  // Remove legacy "model" field — only defaultModel belongs in freecode.json
  if ("model" in settings) {
    delete settings.model;
    changed = true;
  }

  // Promote env-based small/fast model → defaultSmallFastModel (qualified)
  if (!settings.defaultSmallFastModel) {
    const env = (settings.env ?? legacy?.env ?? {}) as Record<string, string>;
    const smallFastModel =
      env.ANTHROPIC_SMALL_FAST_MODEL || env.ANTHROPIC_DEFAULT_HAIKU_MODEL;
    if (smallFastModel && typeof smallFastModel === "string") {
      settings.defaultSmallFastModel = qualify(smallFastModel);
      changed = true;
    }
  }

  // NOTE: Do NOT clean up model env vars (ANTHROPIC_SMALL_FAST_MODEL,
  // ANTHROPIC_DEFAULT_HAIKU_MODEL) from the env block here — the provider
  // migration in getProviderRegistry() still needs to read them. The provider
  // registry cleanup handles env var removal after all migrations complete.

  // Promote mcpServers from ~/.claude.json → freecode.json
  if (!settings.mcpServers) {
    const globalJson = readGlobalClaudeJson();
    const mcpServers = globalJson?.mcpServers;
    if (
      mcpServers &&
      typeof mcpServers === "object" &&
      Object.keys(mcpServers).length > 0
    ) {
      settings.mcpServers = mcpServers;
      changed = true;
    }
  }

  if (changed) {
    writeFreecodeSettingsFile(settings);
  }
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
