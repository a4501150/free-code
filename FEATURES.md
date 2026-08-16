# Feature Flags Audit

Audit date: 2026-08-15

This repository references 29 active compile-time flags through `feature(...)`.
The default build enables the 10 production-supported flags listed in
`scripts/build.ts`; `--feature-set=dev-full` additionally enables the 15
experimental flags in the same file. The remaining 4 are in neither list and are
only ever on in a hand-rolled `--feature=NAME` build.

## Build variants

- `bun run build` builds the regular external binary at `./cli`.
- `bun run compile` builds the regular external binary at `./dist/cli`.
- `bun run build:dev` builds `./cli-dev` with a dev-stamped version.
- `bun run build:dev:full` builds `./cli-dev` with default plus dev-full flags.
- `--compile --dev` together build `./dist/cli-dev`.

See [docs/building.md](docs/building.md) for the full build reference.

## Default build flags

These are included in the default feature list.

### CLI and output behavior

- `DAEMON` — enables daemon-related command and process plumbing that remains in this snapshot.
- `DUMP_SYSTEM_PROMPT` — enables system-prompt dump support.
- `HARD_FAIL` — enables stricter failure/logging behavior.
- `STREAMLINED_OUTPUT` — enables streamlined output formatting.
- `UNATTENDED_RETRY` — enables unattended retry behavior in API retry flows.

### Runtime/settings behavior

- `COORDINATOR_MODE` — enables coordinator mode, coordinator tool filtering, task-list automation, and the built-in `worker` agent provider.
- `KAIROS` — enables proactive assistant-mode behavior, including brief UX, channel notices/callbacks, and push notification surfaces; runtime activation is controlled by assistant mode and related settings.
- `NEW_INIT` — enables the newer `/init` decision path.

### Prompt behavior

- `ULTRATHINK` — enables the extra thinking-depth mode switch.

### Always-on default surface

- `VOICE_MODE` — enables voice toggling, dictation keybindings, voice notices, and voice UI; runtime still depends on an available recording backend.

## Dev-full experimental flags

These are in the dev-full list but not the default list.

- `AGENT_MEMORY_SNAPSHOT` — stores extra custom-agent memory snapshot state in the app.
- `AGENT_TRIGGERS` — enables local cron/trigger tools and trigger-related skills.
- `AWAY_SUMMARY` — adds away-from-keyboard summary behavior in the REPL.
- `BUILTIN_EXPLORE_PLAN_AGENTS` — enables built-in explore/plan agent presets.
- `CONNECTOR_TEXT` — enables connector-text block handling in API/logging/UI paths.
- `EXTRACT_MEMORIES` — enables post-query memory extraction hooks.
- `HISTORY_PICKER` — enables the interactive prompt history picker.
- `HOOK_PROMPTS` — passes prompt/request text into hook execution flows.
- `MCP_RICH_OUTPUT` — enables richer MCP UI rendering.
- `MESSAGE_ACTIONS` — enables message action entrypoints in the interactive UI.
- `POWERSHELL_AUTO_MODE` — enables PowerShell-specific auto-mode permission handling.
- `PROMPT_CACHE_BREAK_DETECTION` — enables cache-break detection around compaction/query/API flow.
- `QUICK_SEARCH` — enables prompt quick-search behavior.
- `TEAMMEM` — enables team-memory files, watcher hooks, and related UI messages.
- `WEBUI` — enables the browser session UI: a per-process attach socket, the `claude web` command, the gateway hosted by the daemon supervisor, and the tunnel providers.

## Individually enabled flags

These are referenced in source but are not in the default or dev-full lists.

- `BUDDY` — companion sprite, its speech-bubble notifications, and the `/buddy`
  command. The only importer of `src/buddy/` is `src/commands/buddy/buddy.ts`,
  which is not registered in `src/commands.ts`; the flag-gated modules
  (`prompt.ts`, `CompanionSprite.tsx`, `useBuddyNotification.tsx`) have no
  consumers at all. Enabling the flag currently has no effect.
- `DEDICATED_SEARCH_TOOLS` — enables dedicated search-tool behavior where referenced.
- `VERIFY_PLAN` — enables plan verification guidance and task/todo verification nudges.
- `WORKTREE_MODE` — enables worktree-mode behavior where referenced.

## Useful entry points

- Feature-aware build logic: `scripts/build.ts`
- Feature-gated command imports: `src/commands.ts`
- Feature-gated tool imports: `src/tools.ts`
- Feature-gated CLI entry paths: `src/entrypoints/cli.tsx`
