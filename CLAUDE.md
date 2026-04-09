# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Common commands

```bash
# Install dependencies
bun install

# Standard build (./cli)
bun run build

# Dev build (./cli-dev)
bun run build:dev

# Dev build with all experimental features (./cli-dev)
bun run build:dev:full

# Compiled build (./dist/cli)
bun run compile

# Run from source without compiling
bun run dev
```

Run the built binary with `./cli` or `./cli-dev`. Set `ANTHROPIC_API_KEY` in the environment or use OAuth via `./cli /login`.

## High-level architecture

- **Entry point/UI loop**: src/entrypoints/cli.tsx bootstraps the CLI, with the main interactive UI in src/screens/REPL.tsx (Ink/React).
- **Command/tool registries**: src/commands.ts registers slash commands; src/tools.ts registers tool implementations. Implementations live in src/commands/ and src/tools/.
- **LLM query pipeline**: src/QueryEngine.ts coordinates message flow, tool use, and model invocation.
- **Core subsystems**:
  - src/services/: API clients, OAuth/MCP integration
  - src/state/: app state store
  - src/hooks/: React hooks used by UI/flows
  - src/components/: terminal UI components (Ink)
  - src/skills/: skill system
  - src/plugins/: plugin system
  - src/bridge/: IDE bridge
  - src/voice/: voice input
  - src/tasks/: background task management

## Build system

- scripts/build.ts is the build script and feature-flag bundler. Feature flags are set via build arguments (e.g., `--feature=ULTRAPLAN`) or presets like `--feature-set=dev-full` (see README for details).
- React Compiler is available as an **optional** pre-build step via `--react-compiler` flag. It runs `babel-plugin-react-compiler` on `.tsx` files before `bun build`. Default builds skip this — source is clean human-readable React without compiler memoization artifacts.
- The `.tsx` source files in `src/` are the **original** pre-compilation source (extracted from Anthropic's inline source maps). They do NOT contain React Compiler output (`_c()`, `$[N]` patterns). All editing should be done on these clean source files.

## Feature flags

The codebase uses a three-tier feature flag system: build-time bundle features, build-time `--define` macros, and runtime environment variables.

### Build-time feature flags (`feature()`)

Bun's `feature()` function provides compile-time dead code elimination. When a flag is not passed at build time, all code guarded by `feature('FLAG')` is stripped from the binary.

**Usage**: `--feature=FLAG_NAME` or `--feature-set=dev-full` (enables all experimental features).

**Default build** (`bun run build`): Only `VOICE_MODE` is enabled.

**Dev-full build** (`bun run build:dev:full`): Enables all 31 experimental features listed in `fullExperimentalFeatures` in scripts/build.ts.

#### Default feature (always enabled)

| Flag | Files | Description | Implementation |
|------|-------|-------------|----------------|
| `VOICE_MODE` | 17 | Voice dictation (hold-to-talk) with STT streaming, keybindings, UI indicators | Full — command, settings, keybindings, STT service, UI components, hooks |

#### Experimental features (in `fullExperimentalFeatures` array)

These are enabled by `--feature-set=dev-full`:

| Flag | Files | Description | Implementation |
|------|-------|-------------|----------------|
| `AGENT_MEMORY_SNAPSHOT` | 2 | Snapshot agent memory; dialog prompts user to review/apply pending snapshots | Full |
| `AGENT_TRIGGERS` | 11 | Cron/scheduled task tools (CronCreate, CronDelete, CronList), scheduler lifecycle, loop skill | Full |
| `AWAY_SUMMARY` | 2 | Detects user idle, generates summary of what happened while away | Full |
| `BASH_CLASSIFIER` | 15+ | ML classifier for bash command safety; spans entire permission pipeline from decision logic to UI | Full — deepest permission integration |
| `BUILTIN_EXPLORE_PLAN_AGENTS` | 1 | Boolean gate enabling built-in Explore and Plan subagent types | Full (simple toggle) |
| `CACHED_MICROCOMPACT` | 4 | Caches micro-compaction results across prompt/query/API pipeline | Full |
| `COMPACTION_REMINDERS` | 1 | Injects compaction reminder attachment into system prompt | Full (minimal scope) |
| `CONNECTOR_TEXT` | 5 | API beta feature: connector text blocks, end-to-end from headers to rendering | Full |
| `EXTRACT_MEMORIES` | 4 | Background memory extraction on query completion and during housekeeping | Full |
| `HISTORY_PICKER` | 2 | History search dialog (Ctrl+R alternative) with keybinding | Full |
| `HOOK_PROMPTS` | 1 | Passes `requestPrompt` to tool use context for hook prompt requests | Full (1 line) |
| `KAIROS_BRIEF` | 20+ | BriefTool + `/brief` command + settings + prompt injection + UI (OR'd with KAIROS) | Full — major feature |
| `KAIROS_CHANNELS` | 15+ | Channel notifications via MCP, message queue, tool behavior (OR'd with KAIROS) | Full — major feature |
| `LODESTONE` | 4 | Deep link protocol handler (`claude-cli://`), registration, URI handling | Full |
| `MCP_RICH_OUTPUT` | 1 | Enhanced MCP tool output rendering (truncation, richer components) | Full (narrow scope) |
| `MESSAGE_ACTIONS` | 2 | Keyboard-navigable message actions (copy, retry), cursor state | Full |
| `NEW_INIT` | 1 | Alternate `/init` prompt mentioning skills/hooks (double-gated with env var) | Full (narrow scope) |
| `POWERSHELL_AUTO_MODE` | 1 | Allows PowerShell tool in auto/non-interactive mode | Full (minimal) |
| `PROMPT_CACHE_BREAK_DETECTION` | 6 | Monitors cache read/write metrics to detect prompt cache breaks | Full |
| `QUICK_SEARCH` | 2 | Quick Open + Global Search dialogs with Ctrl+F keybinding | Full |
| `SHOT_STATS` | 3 | Tracks one-shot vs multi-shot conversation distribution in stats UI | Full |
| `TEAMMEM` | 17 | Team memory sync — shared memory files, filesystem watcher, extraction | Full — major subsystem |
| `TOKEN_BUDGET` | 6 | User-specified output token budget with enforcement and spinner progress | Full |
| `TRANSCRIPT_CLASSIFIER` | **45** | **Auto mode** — AI-powered permission classifier, auto-approve settings, classifier UI. Prompts extracted from v2.1.96. | Full — major subsystem |
| `TREE_SITTER_BASH` | 1 | Tree-sitter-based bash parsing (replaces regex parser for security analysis) | Full |
| `TREE_SITTER_BASH_SHADOW` | 2 | Shadow mode: runs tree-sitter in parallel with legacy parser, logs divergences | Full |
| `ULTRAPLAN` | 5 | `/ultraplan` command — launches web-based planning with rainbow trigger keywords | Full |
| `ULTRATHINK` | 1 | Gate for ultra/extended thinking mode | Full (minimal) |
| `UNATTENDED_RETRY` | 1 | Persistent retry on 429/529 in headless/CI mode | Full (minimal) |
| `VERIFICATION_AGENT` | 4 | Adversarial verification agent; nudges on task completion, PASS/FAIL/PARTIAL verdicts | Full |

#### Additional feature flags (not in dev-full set)

These must be individually enabled with `--feature=FLAG_NAME`:

| Flag | Files | Description | Build Status |
|------|-------|-------------|--------------|
| `AUTO_THEME` | 1 | Adds "Auto (match terminal)" option to theme picker | **OK** — builds clean |
| `BG_SESSIONS` | 7 | Background sessions via tmux (ps/logs/attach/kill/--bg), session lifecycle | **Broken** — missing `cli/bg.js` |
| `BREAK_CACHE_COMMAND` | 1 | Injects cache-breaking string into system prompt for debugging | **OK** — builds clean |
| `BUDDY` | 7 | Virtual companion sprites with rarity, speech bubbles, reactions, notifications | **OK** — builds clean |
| `BUILDING_CLAUDE_APPS` | 1 | Registers "Claude API" bundled skill | **Broken** — missing `claude-api/` skill docs |
| `BYOC_ENVIRONMENT_RUNNER` | 1 | `claude environment-runner` CLI subcommand for BYOC | **Broken** — missing `environment-runner/main.js` |
| `COMMIT_ATTRIBUTION` | 1 | Tracks permission/escape/prompt counts for commit attribution metrics | **OK** — builds clean |
| `CONTEXT_COLLAPSE` | 13 | Archives older context into collapsed summaries; alternative to reactive compact | **Broken** — missing `CtxInspectTool` |
| `COORDINATOR_MODE` | 15 | Coordinator mode: delegates work to agents, filters tools, custom system prompt | **Broken** — missing `coordinator/workerAgent.js` |
| `DAEMON` | 1 | `claude daemon` + `--daemon-worker` CLI subcommands for long-running supervisor | **OK** — builds clean |
| `DIRECT_CONNECT` | 1 | `claude connect <url>` for remote server connection with auth | **Broken** — missing `server/` module (9 files) |
| `DUMP_SYSTEM_PROMPT` | 1 | `--dump-system-prompt` flag for prompt sensitivity evals | **OK** — builds clean |
| `EXPERIMENTAL_SKILL_SEARCH` | 9 | Remote skill search/indexing from MCP and external sources | **Broken** — missing `services/skillSearch/` (11 files) |
| `FILE_PERSISTENCE` | 1 | Post-turn file persistence with event emission | **OK** — builds clean |
| `FORK_SUBAGENT` | 5 | Fork agent mode — spawns full-access subagent with permission bubbling | **Broken** — missing `commands/fork/`, `UserForkBoilerplateMessage` |
| `HARD_FAIL` | 2 | `--hard-fail` makes `logError()` crash process instead of silently logging | **OK** — builds clean |
| `HISTORY_SNIP` | 8 | SnipTool — trim older conversation history, integrated into query/message pipeline | **Broken** — missing `SnipTool`, `commands/force-snip`, `SnipBoundaryMessage` |
| `KAIROS` | **52** | **Full assistant mode** — scheduling, notifications, team context, persistent sessions, daily logs. Largest flag (120+ refs). | **Broken** — missing `proactive/`, `sessionTranscript/`, `SleepTool`, `SendUserFileTool`, `PushNotificationTool`, `SubscribePRTool` |
| `KAIROS_DREAM` | 1 | Registers "dream" skill for background memory consolidation (requires KAIROS) | **Broken** — depends on KAIROS |
| `KAIROS_GITHUB_WEBHOOKS` | 3 | SubscribePRTool + `/subscribe-pr` for GitHub PR webhook subscriptions | **Broken** — missing `SubscribePRTool`, `commands/subscribe-pr` |
| `KAIROS_PUSH_NOTIFICATION` | 3 | Push notification tool + settings (extends KAIROS notification support) | **Broken** — missing `PushNotificationTool` |
| `MCP_SKILLS` | 3 | Fetches and registers skills from MCP server resources | **OK** — builds clean |
| `OVERFLOW_TEST_TOOL` | 2 | Debug tool for overflow scenario testing + classifier integration | **OK** — builds clean |
| `REACTIVE_COMPACT` | 2 | Trigger-based automatic compaction module | **Broken** — missing `services/compact/reactiveCompact.js` |
| `REVIEW_ARTIFACT` | 2 | "Hunter" skill + ReviewArtifactTool with custom permission UI | **Broken** — missing `hunter.js`, `ReviewArtifactTool`, `ReviewArtifactPermissionRequest` |
| `RUN_SKILL_GENERATOR` | 1 | Skill generator/scaffolding skill | **Broken** — missing `runSkillGenerator.js` |
| `SELF_HOSTED_RUNNER` | 1 | `claude self-hosted-runner` CLI mode for headless poll-based execution | **Broken** — missing `self-hosted-runner/main.js` |
| `SLOW_OPERATION_LOGGING` | 1 | Performance instrumentation wrapping JSON.stringify, structuredClone, etc. | **OK** — builds clean |
| `SSH_REMOTE` | 1 | `claude ssh <host> [dir]` for SSH-backed remote sessions | **Broken** — missing `ssh/createSSHSession.js` |
| `STREAMLINED_OUTPUT` | 1 | Streamlined transformer for headless `stream-json` output format | **OK** — builds clean |
| `TEMPLATES` | 5 | Template execution system — config, permissions, CLI dispatch, job classification | **Broken** — missing `cli/handlers/templateJobs.js` |
| `TERMINAL_PANEL` | 5 | TerminalCaptureTool + meta+j keybinding for terminal panel toggle | **OK** — builds clean |
| `UDS_INBOX` | 10 | Unix domain socket IPC — peer discovery, messaging, `/peers` command, ListPeersTool | **Broken** — missing `ListPeersTool`, `udsMessaging`, `commands/peers/` |
| `WORKFLOW_SCRIPTS` | 7 | WorkflowTool + `/workflows` command + task tracking + custom permission UI | **Broken** — missing `WorkflowTool`, `commands/workflows/`, `LocalWorkflowTask` |

Total: **66 unique build-time feature flags** (1 default + 31 dev-full + 34 additional).

- **Buildable flags**: 1 default (`VOICE_MODE`) + 31 dev-full + 13 hidden that build clean (`AUTO_THEME`, `BREAK_CACHE_COMMAND`, `BUDDY`, `COMMIT_ATTRIBUTION`, `DAEMON`, `DUMP_SYSTEM_PROMPT`, `FILE_PERSISTENCE`, `HARD_FAIL`, `MCP_SKILLS`, `OVERFLOW_TEST_TOOL`, `SLOW_OPERATION_LOGGING`, `STREAMLINED_OUTPUT`, `TERMINAL_PANEL`) = **45 working flags**
- **Broken flags**: 21 hidden flags depend on modules stripped from the upstream source and will fail to build. See "Build Status" column above for missing modules.
- `PROACTIVE` was removed (legacy, subsumed by KAIROS).

> **TODO**: As flags are moved to default-on (enabled in production builds), update the tables above — move the flag to the "Default feature" section and update `defaultFeatures` in scripts/build.ts accordingly.

### Notable settings.json defaults

These settings were migrated from the upstream GrowthBook remote flag system
and ant-internal gates. They are configured in `settings.json` (project-level)
rather than build-time flags.

| Setting | Default | Description |
|---------|---------|-------------|
| `autoMode` | `true` | Enable auto-approve mode |
| `planModeInterviewPhase` | `false` | When false, plan mode uses V2 workflow with built-in Explore/Plan agents instead of the older interview-phase flow |
| `fineGrainedToolStreaming` | `false` | Enable fine-grained tool streaming (eager_input_streaming) |
| `streamingToolExecution` | `true` | Execute tools while model is still streaming |
| `sessionMemory` | `false` | Auto-maintain context notes across long conversations |
| `contentReplacementState` | `false` | Replace stale tool results with stubs to save tokens |
| `destructiveCommandWarning` | `true` | Show warnings for destructive commands in permission dialogs |
| `memoryExtraction` | `true` | Background memory extraction agent |

See `src/utils/settings/types.ts` for the complete schema of all ~45 settings.json options.

### Build-time `--define` macros

Compile-time constant replacements injected via Bun's `--define` flag (scripts/build.ts lines 126-149):

| Macro | Default Value | Description |
|-------|---------------|-------------|
| `process.env.USER_TYPE` | `"external"` | User type (`"ant"` for internal Anthropic builds) — gates hundreds of internal-only checks |
| `process.env.CLAUDE_CODE_FORCE_FULL_LOGO` | `"true"` | Always show full ASCII art logo |
| `process.env.NODE_ENV` | `"development"` (dev only) | Set only in dev builds |
| `process.env.CLAUDE_CODE_EXPERIMENTAL_BUILD` | `"true"` (dev only) | Marks experimental dev builds |
| `process.env.CLAUDE_CODE_VERIFY_PLAN` | `"true"` | Enables plan verification |
| `MACRO.VERSION` | Package version string | Application version |
| `MACRO.BUILD_TIME` | ISO timestamp | Build timestamp |
| `MACRO.PACKAGE_URL` | Package name from package.json | npm package URL |
| `MACRO.NATIVE_PACKAGE_URL` | `undefined` | Native package URL (unset in OSS) |
| `MACRO.FEEDBACK_CHANNEL` | `"github"` | Feedback channel identifier |
| `MACRO.ISSUES_EXPLAINER` | Explanatory string | Issue routing explainer text |
| `MACRO.VERSION_CHANGELOG` | Changelog URL or git log | Version changelog |

### Runtime environment variables

Checked at runtime via `isEnvTruthy()` (src/utils/envUtils.ts). Values `'1'`, `'true'`, `'yes'`, `'on'` (case-insensitive) are truthy.

#### API provider selection

| Variable | Description |
|----------|-------------|
| `CLAUDE_CODE_USE_BEDROCK` | Use AWS Bedrock as API provider |
| `CLAUDE_CODE_USE_VERTEX` | Use Google Vertex AI as API provider |
| `CLAUDE_CODE_USE_FOUNDRY` | Use Foundry as API provider |
| `CLAUDE_CODE_USE_OPENAI` | Use OpenAI as API provider |
| `CLAUDE_CODE_SKIP_BEDROCK_AUTH` | Skip Bedrock authentication |
| `CLAUDE_CODE_SKIP_VERTEX_AUTH` | Skip Vertex authentication |
| `CLAUDE_CODE_SKIP_FOUNDRY_AUTH` | Skip Foundry authentication |

#### Mode flags

| Variable | Description |
|----------|-------------|
| `CLAUDE_CODE_SIMPLE` / `--bare` | Bare mode — skip hooks, LSP, plugins, etc. |
| `CLAUDE_CODE_COORDINATOR_MODE` | Enable multi-agent coordinator mode |
| `CLAUDE_CODE_PROACTIVE` | Enable proactive mode |
| `CLAUDE_CODE_BRIEF` | Brief output mode |
| `CLAUDE_CODE_ACTION` | GitHub Actions mode |
| `CLAUDE_CODE_ENTRYPOINT` | Entry point identifier (cli, sdk-ts, sdk-py, etc.) |

#### Feature disablers (`CLAUDE_CODE_DISABLE_*`)

| Variable | Description |
|----------|-------------|
| `CLAUDE_CODE_DISABLE_THINKING` | Disable extended thinking |
| `CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING` | Disable adaptive thinking |
| `CLAUDE_CODE_DISABLE_FAST_MODE` | Disable fast mode |
| `CLAUDE_CODE_DISABLE_COMMAND_INJECTION_CHECK` | Disable command injection checks |
| `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` | Disable background bash tasks |
| `CLAUDE_CODE_DISABLE_TERMINAL_TITLE` | Disable terminal title setting |
| `CLAUDE_CODE_DISABLE_AUTO_MEMORY` | Disable auto memory |
| `CLAUDE_CODE_DISABLE_CLAUDE_MDS` | Disable .claude.md file loading |
| `CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING` | Disable file checkpointing |
| `CLAUDE_CODE_DISABLE_VIRTUAL_SCROLL` | Disable virtual scrolling |
| `CLAUDE_CODE_DISABLE_MESSAGE_ACTIONS` | Disable message actions |
| `CLAUDE_CODE_DISABLE_MOUSE` | Disable mouse support |
| `CLAUDE_CODE_DISABLE_1M_CONTEXT` | Disable 1M context window |
| `CLAUDE_CODE_DISABLE_CRON` | Disable cron/scheduled tasks |

#### Feature enablers (`CLAUDE_CODE_ENABLE_*`)

| Variable | Description |
|----------|-------------|
| `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION` | Enable prompt suggestions |
| `CLAUDE_CODE_ENABLE_TASKS` | Enable tasks feature |
| `CLAUDE_CODE_ENABLE_TOKEN_USAGE_ATTACHMENT` | Enable token usage attachment |
| `CLAUDE_CODE_ENABLE_CFC` | Enable Claude for Chrome |
| `CLAUDE_CODE_ALWAYS_ENABLE_EFFORT` | Always enable effort selection |

#### Configuration/tuning

| Variable | Description |
|----------|-------------|
| `CLAUDE_CODE_MAX_OUTPUT_TOKENS` | Max output tokens override |
| `CLAUDE_CODE_MAX_RETRIES` | Max API retry count |
| `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY` | Max parallel tool execution |
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | Auto-compact window size |
| `CLAUDE_CODE_EFFORT_LEVEL` | Effort level override |
| `CLAUDE_CODE_SUBAGENT_MODEL` | Subagent model override |
| `CLAUDE_CODE_IDLE_THRESHOLD_MINUTES` | Idle timeout minutes (default 75) |
| `CLAUDE_CODE_IDLE_TOKEN_THRESHOLD` | Idle token threshold (default 100K) |

#### Debugging/profiling

| Variable | Description |
|----------|-------------|
| `CLAUDE_CODE_PROFILE_STARTUP` | Enable startup profiling |
| `CLAUDE_CODE_PROFILE_QUERY` | Enable query profiling |
| `CLAUDE_CODE_PERFETTO_TRACE` | Enable Perfetto tracing |
| `CLAUDE_CODE_DEBUG_REPAINTS` | Debug UI repaints |
| `CLAUDE_CODE_DEBUG_LOG_LEVEL` | Debug log level |
| `CLAUDE_CODE_DIAGNOSTICS_FILE` | Diagnostics output file |

#### Path/directory overrides

| Variable | Description |
|----------|-------------|
| `CLAUDE_CONFIG_DIR` | Config directory (default `~/.claude`) |
| `CLAUDE_CODE_TMPDIR` | Temp directory override |
| `CLAUDE_CODE_SHELL` | Shell override |
| `CLAUDE_CODE_SHELL_PREFIX` | Shell prefix command |
| `CLAUDE_CODE_DEBUG_LOGS_DIR` | Debug logs directory |

#### Other notable env vars

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | API key for direct Anthropic API access |
| `ANTHROPIC_BASE_URL` | Base API URL override |
| `DISABLE_PROMPT_CACHING` | Disable all prompt caching |
| `DISABLE_COMPACT` / `DISABLE_AUTO_COMPACT` | Disable compaction |
| `CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR` | Reset bash CWD after each command |
