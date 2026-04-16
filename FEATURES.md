# Feature Flags Audit

Audit date: 2026-04-09

This repository currently references 66 `feature('FLAG')` compile-time flags.
Of those, 30 are in the `fullExperimentalFeatures` array (enabled by
`--feature-set=dev-full`) and 36 are additional flags that must be individually
enabled.

Important: "bundle cleanly" does not always mean "runtime-safe". Some flags
still depend on optional native modules, claude.ai OAuth, or
externalized `@ant/*` packages.

## Build Variants

- `bun run build`
  Builds the regular external binary at `./cli`.
- `bun run compile`
  Builds the regular external binary at `./dist/cli`.
- `bun run build:dev`
  Builds `./cli-dev` with a dev-stamped version.
- `bun run build:dev:full`
  Builds `./cli-dev` with all 30 flags from `fullExperimentalFeatures`.

## Default Build Flags

- `VOICE_MODE`
  This is now included in the default build pipeline, not just the dev build.
  It enables `/voice`, push-to-talk UI, voice notices, and dictation plumbing.
  Runtime still depends on claude.ai OAuth plus either the native audio module
  or a fallback recorder such as SoX.

## Working Experimental Features

These are the user-facing or behavior-changing flags that currently bundle
cleanly and should still be treated as experimental in this snapshot unless
explicitly called out as default-on.

### Interaction and UI Experiments

- `AWAY_SUMMARY`
  Adds away-from-keyboard summary behavior in the REPL.
- `HISTORY_PICKER`
  Enables the interactive prompt history picker.
- `HOOK_PROMPTS`
  Passes the prompt/request text into hook execution flows.
- `KAIROS_BRIEF`
  Enables brief-only transcript layout and BriefTool-oriented UX without the
  full assistant stack.
- `KAIROS_CHANNELS`
  Enables channel notices and channel callback plumbing around MCP/channel
  messaging.
- `LODESTONE`
  Enables deep-link / protocol-registration related flows and settings wiring.
- `MESSAGE_ACTIONS`
  Enables message action entrypoints in the interactive UI.
- `NEW_INIT`
  Enables the newer `/init` decision path.
- `QUICK_SEARCH`
  Enables prompt quick-search behavior.
- `SHOT_STATS`
  Enables additional shot-distribution stats views.
- `TOKEN_BUDGET`
  Enables token budget tracking, prompt triggers, and token warning UI.
- `ULTRAPLAN`
  Enables `/ultraplan`, prompt triggers, and exit-plan affordances.
- `ULTRATHINK`
  Enables the extra thinking-depth mode switch.
- `VOICE_MODE`
  Enables voice toggling, dictation keybindings, voice notices, and voice UI.

### Agent, Memory, and Planning Experiments

- `AGENT_MEMORY_SNAPSHOT`
  Stores extra custom-agent memory snapshot state in the app.
- `AGENT_TRIGGERS`
  Enables local cron/trigger tools and bundled trigger-related skills.
- `BUILTIN_EXPLORE_PLAN_AGENTS`
  Enables built-in explore/plan agent presets.
- `CACHED_MICROCOMPACT`
  Enables cached microcompact state through query and API flows.
- `COMPACTION_REMINDERS`
  Enables reminder copy around compaction and attachment flows.
- `EXTRACT_MEMORIES`
  Enables post-query memory extraction hooks.
- `PROMPT_CACHE_BREAK_DETECTION`
  Enables cache-break detection around compaction/query/API flow.
- `TEAMMEM`
  Enables team-memory files, watcher hooks, and related UI messages.
- `VERIFICATION_AGENT`
  Enables verification-agent guidance in prompts and task/todo tooling.

### Tools, Permissions, and Remote Experiments

- `BASH_CLASSIFIER`
  Enables classifier-assisted bash permission decisions.
- `CONNECTOR_TEXT`
  Enables connector-text block handling in API/logging/UI paths.
- `MCP_RICH_OUTPUT`
  Enables richer MCP UI rendering.
- `POWERSHELL_AUTO_MODE`
  Enables PowerShell-specific auto-mode permission handling.
- `TREE_SITTER_BASH`
  Enables the tree-sitter bash parser backend.
- `TREE_SITTER_BASH_SHADOW`
  Enables the tree-sitter bash shadow rollout path.
- `UNATTENDED_RETRY`
  Enables unattended retry behavior in API retry flows.

## Bundle-Clean Support Flags

These also bundle cleanly, but they are mostly rollout, platform,
or plumbing toggles rather than user-facing experimental features.

- `BREAK_CACHE_COMMAND`
  Injects the break-cache command path.
- `DUMP_SYSTEM_PROMPT`
  Enables the system-prompt dump path.
- `FILE_PERSISTENCE`
  Enables file persistence plumbing.
- `HARD_FAIL`
  Enables stricter failure/logging behavior.
- `SLOW_OPERATION_LOGGING`
  Enables slow-operation logging.
- `AUTO_THEME`
  Adds auto theme detection option in the theme picker.
- `COMMIT_ATTRIBUTION`
  Adds git commit co-author attribution.
- `PROACTIVE`
  Enables proactive suggestions mode.
- `STREAMLINED_OUTPUT`
  Enables streamlined output format.

## Compile-Safe But Runtime-Caveated

These bundle today, but I would still treat them as experimental because they
have meaningful runtime caveats:

- `VOICE_MODE`
  Bundles cleanly, but requires claude.ai OAuth and a local recording backend.
  The native audio module is optional now; on this machine the fallback path
  asks for `brew install sox`.
- `KAIROS_BRIEF`, `KAIROS_CHANNELS`
  Bundle cleanly, but they do not restore the full missing assistant stack.
  They only expose the brief/channel-specific surfaces that still exist.
- `TEAMMEM`
  Bundles cleanly, but only does useful work when team-memory config/files are
  actually enabled in the environment.

## Broken Flags With Easy Reconstruction Paths

These are the failed flags where the current blocker looks small enough that a
focused reconstruction pass could probably restore them without rebuilding an
entire subsystem.

- `BG_SESSIONS`
  Fails on missing `src/cli/bg.js`. The CLI fast-path dispatch in
  `src/entrypoints/cli.tsx` is already wired.
- `BUDDY`
  Fails on missing `src/commands/buddy/index.js`. The buddy UI components and
  prompt-input hooks already exist.
- `FORK_SUBAGENT`
  Fails on missing `src/commands/fork/index.js`. Command slot and message
  rendering support are already present.
- `HISTORY_SNIP`
  Fails on missing `src/commands/force-snip.js`. The surrounding SnipTool and
  query/message comments are already there.
- ~~`KAIROS_GITHUB_WEBHOOKS`~~ **FIXED** — SubscribePRTool, subscribe-pr command, and UserGitHubWebhookMessage implemented.
- ~~`KAIROS_PUSH_NOTIFICATION`~~ **FIXED** — PushNotificationTool implemented wrapping sendNotification().
- `MCP_SKILLS`
  Fails on missing `src/skills/mcpSkills.js`. `mcpSkillBuilders.ts` already
  exists specifically to support that missing registry layer.
- `OVERFLOW_TEST_TOOL`
  Fails on missing `src/tools/OverflowTestTool/OverflowTestTool.js`. This
  appears isolated and test-only.
- `RUN_SKILL_GENERATOR`
  Fails on missing `src/runSkillGenerator.js`. The bundled skill registration
  path already expects it.
- `TEMPLATES`
  Fails on missing `src/cli/handlers/templateJobs.js`. The CLI fast-path is
  already wired in `src/entrypoints/cli.tsx`.
- `TRANSCRIPT_CLASSIFIER`
  The first hard failure is missing
  `src/utils/permissions/yolo-classifier-prompts/auto_mode_system_prompt.txt`.
  The classifier engine, parser, and settings plumbing already exist, so the
  missing prompt/assets are likely the first reconstruction target.

## Broken Flags With Partial Wiring But Medium-Sized Gaps

These do have meaningful surrounding code, but the missing piece is larger
than a single wrapper or asset.

- `BYOC_ENVIRONMENT_RUNNER`
  Missing `src/environment-runner/main.js`.
- `CONTEXT_COLLAPSE`
  Missing `src/tools/CtxInspectTool/CtxInspectTool.js`.
- `COORDINATOR_MODE`
  Missing `src/coordinator/workerAgent.js`.
- `DAEMON`
  Missing `src/daemon/workerRegistry.js`.
- `DIRECT_CONNECT`
  Missing `src/server/parseConnectUrl.js`.
- `EXPERIMENTAL_SKILL_SEARCH`
  Missing `src/services/skillSearch/localSearch.js`.
- `REACTIVE_COMPACT`
  Missing `src/services/compact/reactiveCompact.js`.
- `REVIEW_ARTIFACT`
  Missing `src/hunter.js`.
- `SELF_HOSTED_RUNNER`
  Missing `src/self-hosted-runner/main.js`.
- `SSH_REMOTE`
  Missing `src/ssh/createSSHSession.js`.
- `TERMINAL_PANEL`
  Missing `src/tools/TerminalCaptureTool/TerminalCaptureTool.js`.
- `UDS_INBOX`
  Missing `src/utils/udsMessaging.js`.
- `WORKFLOW_SCRIPTS`
  Fails first on `src/commands/workflows/index.js`, but there are more gaps:
  `tasks.ts` already expects `LocalWorkflowTask`, and `tools.ts` expects a
  real `WorkflowTool` implementation while only `WorkflowTool/constants.ts`
  exists in this snapshot.

## Previously Broken Flags — Now Fixed

- ~~`KAIROS`~~ **FIXED** — Full implementations: `src/proactive/` (state machine + tick hook), `src/assistant/` (mode detection, team init, system prompt), `src/services/sessionTranscript/` (JSONL persistence), `src/services/kairosGate.ts`, SleepTool, SendUserFileTool.
- ~~`KAIROS_DREAM`~~ **FIXED** — Dream skill implemented using existing consolidationPrompt infrastructure.

## Useful Entry Points

- Feature-aware build logic: `scripts/build.ts`
- Feature-gated command imports: `src/commands.ts`
- Feature-gated tool imports: `src/tools.ts`
- Feature-gated task imports: `src/tasks.ts`
- Feature-gated query behavior: `src/query.ts`
- Feature-gated CLI entry paths: `src/entrypoints/cli.tsx`
