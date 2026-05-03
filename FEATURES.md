# Feature Flags Audit

Audit date: 2026-05-03

This repository currently references 42 compile-time flags through `feature(...)`.
The default build enables the production-supported subset in `scripts/build.ts`;
`--feature-set=dev-full` additionally enables the experimental list in the same
file.

## Build variants

- `bun run build` builds the regular external binary at `./cli`.
- `bun run compile` builds the regular external binary at `./dist/cli`.
- `bun run build:dev` builds `./cli-dev` with a dev-stamped version.
- `bun run build:dev:full` builds `./cli-dev` with default plus dev-full flags.

## Default build flags

These are included in the default feature list.

### CLI and output behavior

- `DAEMON` — enables daemon-related command and process plumbing that remains in this snapshot.
- `DUMP_SYSTEM_PROMPT` — enables system-prompt dump support.
- `HARD_FAIL` — enables stricter failure/logging behavior.
- `STREAMLINED_OUTPUT` — enables streamlined output formatting.
- `UNATTENDED_RETRY` — enables unattended retry behavior in API retry flows.

### Slash-command and skill behavior

- `BUDDY` — enables buddy command/UI surfaces that remain in this snapshot.
- `KAIROS_DREAM` — enables the dream skill and related consolidation behavior.

### Runtime/settings behavior

- `CACHED_MICROCOMPACT` — enables cached microcompact state through query and API flows.
- `COORDINATOR_MODE` — enables coordinator mode, coordinator tool filtering, task-list automation, and the built-in `worker` agent provider.
- `KAIROS` — enables proactive assistant-mode behavior.
- `KAIROS_BRIEF` — enables brief-only transcript layout and BriefTool-oriented UX.
- `KAIROS_CHANNELS` — enables channel notices and channel callback plumbing.
- `KAIROS_PUSH_NOTIFICATION` — enables push notification tooling for proactive mode.
- `LODESTONE` — enables protocol/deep-link registration flows and related settings wiring.
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
- `BASH_CLASSIFIER` — enables classifier-assisted bash permission decisions.
- `BUILTIN_EXPLORE_PLAN_AGENTS` — enables built-in explore/plan agent presets.
- `COMPACTION_REMINDERS` — enables reminder copy around compaction and attachment flows.
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
- `TOKEN_BUDGET` — enables token budget tracking, prompt triggers, and token warning UI.
- `TRANSCRIPT_CLASSIFIER` — enables transcript-classifier checks for auto mode.
- `TREE_SITTER_BASH` — enables the tree-sitter bash parser backend.
- `TREE_SITTER_BASH_SHADOW` — enables the tree-sitter bash shadow rollout path.

## Individually enabled flags

These are referenced in source but are not in the default or dev-full lists.

- `DEDICATED_SEARCH_TOOLS` — enables dedicated search-tool behavior where referenced.
- `VERIFY_PLAN` — enables plan verification guidance and task/todo verification nudges.
- `WORKTREE_MODE` — enables worktree-mode behavior where referenced.

## Useful entry points

- Feature-aware build logic: `scripts/build.ts`
- Feature-gated command imports: `src/commands.ts`
- Feature-gated tool imports: `src/tools.ts`
- Feature-gated task imports: `src/tasks.ts`
- Feature-gated query behavior: `src/query.ts`
- Feature-gated CLI entry paths: `src/entrypoints/cli.tsx`
