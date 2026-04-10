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

# Run all tests (requires `bun run build` first)
bun test

# Run e2e tests explicitly
bun run test:e2e
```

Run the built binary with `./cli` or `./cli-dev`. Set `ANTHROPIC_API_KEY` in the environment or use OAuth via `./cli /login`.

## Testing

All tests are e2e: they launch the real compiled binary (`./cli`) against a mock Anthropic API server and verify behavior through tmux sessions.

```
tests/
  helpers/              # Shared test infrastructure
    mock-server.ts      # MockAnthropicServer (Bun.serve, response queue, request logging)
    sse-encoder.ts      # SSE stream encoder matching Anthropic streaming format
    fixture-builders.ts # textResponse(), toolUseResponse(), errorResponse(), etc.
  e2e/                  # All test suites (tmux-based)
    tmux-helpers.ts     # TmuxSession class — manages CLI in tmux, sends keys, captures pane
    repl.test.ts        # Startup, basic responses, prompts, multiple turns, slash commands
    tool-use.test.ts    # Bash, Read, Edit, Write, Grep, Glob, NotebookEdit, Config, parallel
    conversation-flow.test.ts  # Message ordering, multi-turn, max-turns, stop reasons, thinking
    error-handling.test.ts     # HTTP 400/401/429/500/529 errors, truncated SSE
    edge-cases.test.ts         # Special chars, large I/O, multiple text blocks
    output-formats.test.ts     # Headless --print mode: text, json, stream-json
```

**How it works**: Each test creates a `TmuxSession` pointing at a `MockAnthropicServer`. The CLI runs without `--bare` (all tools registered) and without permission-skipping flags (real default permission mode). `submitAndApprove()` auto-detects and approves permission dialogs. Tests verify via:
- `server.getRequestLog()` — what the CLI sent to the API
- `readFile()` — disk side effects from tool execution
- `capturePane()` — what the user sees on screen

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

**Default build** (`bun run build`): 34 flags enabled (runtime-gated features safe to always include).

**Dev-full build** (`bun run build:dev:full`): 55 flags enabled (adds 21 experimental). The remaining 10 additional flags need `--feature=FLAG_NAME`.

#### Default features (always included in every build)

These are safe to always include because they require explicit runtime activation (CLI flag, slash command, setting, or file).

| Flag | Runtime Gate | Description |
|------|-------------|-------------|
| `BG_SESSIONS` | `--bg` / `--background` | Background sessions via tmux (ps/logs/attach/kill) |
| `BREAK_CACHE_COMMAND` | debug injection | Injects cache-breaking string into system prompt |
| `BUDDY` | `/buddy` command | Virtual companion sprites with rarity, speech bubbles |
| `BUILDING_CLAUDE_APPS` | `/claude-api` skill | Registers "Claude API" bundled skill |
| `BYOC_ENVIRONMENT_RUNNER` | `claude environment-runner` | CLI subcommand for BYOC |
| `CACHED_MICROCOMPACT` | config (default off) | Caches micro-compaction results across pipeline |
| `COORDINATOR_MODE` | env `CLAUDE_CODE_COORDINATOR_MODE=1` | Delegates work to agents, filters tools, custom prompt |
| `DAEMON` | `claude daemon` / `--daemon-worker` | Long-running supervisor daemon |
| `DIRECT_CONNECT` | `claude connect <url>` | Remote server connection with auth |
| `DUMP_SYSTEM_PROMPT` | `--dump-system-prompt` | Prints system prompt and exits |
| `FORK_SUBAGENT` | `/fork` command | Fork agent mode — full-access subagent |
| `HARD_FAIL` | `--hard-fail` | Makes `logError()` crash instead of silently logging |
| `HISTORY_SNIP` | `/force-snip` + SnipTool | Trim older conversation history |
| `KAIROS` | `--assistant` or `.claude/agents/assistant.md` | **Full assistant mode** — proactive, scheduling, notifications, daily logs (52 files) |
| `KAIROS_BRIEF` | `--brief` or `/brief` | BriefTool (SendUserMessage) + settings + prompt + UI |
| `KAIROS_CHANNELS` | `--channels <servers>` | Channel notifications via MCP, message queue |
| `KAIROS_DREAM` | `/dream` skill | Background memory consolidation |
| `KAIROS_GITHUB_WEBHOOKS` | `/subscribe-pr` command | SubscribePRTool for GitHub PR subscriptions |
| `KAIROS_PUSH_NOTIFICATION` | setting `agentPushNotifEnabled` | Push notification tool + settings |
| `LODESTONE` | auto (disable via setting) | Deep link protocol handler (`claude-cli://`) |
| `NEW_INIT` | env `CLAUDE_CODE_NEW_INIT=true` | Alternate `/init` prompt mentioning skills/hooks |
| `OVERFLOW_TEST_TOOL` | debug tool | Debug tool for overflow scenario testing |
| `REVIEW_ARTIFACT` | `/hunter` skill | ReviewArtifactTool with custom permission UI |
| `RUN_SKILL_GENERATOR` | skill invocation | Skill generator/scaffolding |
| `SELF_HOSTED_RUNNER` | `claude self-hosted-runner` | Headless poll-based execution |
| `SSH_REMOTE` | `claude ssh <host> [dir]` | SSH-backed remote sessions |
| `STREAMLINED_OUTPUT` | `--output-format=stream-json` | Streamlined transformer for headless output |
| `TEMPLATES` | `claude new` / `claude list` / `claude reply` | Template execution system |
| `ULTRAPLAN` | `/ultraplan` command | Web-based planning with rainbow trigger keywords |
| `UNATTENDED_RETRY` | env `CLAUDE_CODE_UNATTENDED_RETRY=true` | Persistent retry on 429/529 in headless/CI mode |
| `ULTRATHINK` | user types "ultrathink" keyword | Ultra/extended thinking mode |
| `VERIFICATION_AGENT` | prompt nudge (benign) | Adversarial verification agent; PASS/FAIL/PARTIAL verdicts |
| `VOICE_MODE` | hold-to-talk keybinding | Voice dictation with STT streaming |
| `WORKFLOW_SCRIPTS` | `/workflows` command | WorkflowTool + task tracking |

#### Experimental features (in `fullExperimentalFeatures` array)

These are enabled by `--feature-set=dev-full`. They activate immediately when built (no additional runtime gate), so they are kept out of default builds.

| Flag | Description | Notes |
|------|-------------|-------|
| `AGENT_MEMORY_SNAPSHOT` | Snapshot agent memory; review/apply pending snapshots | Runs when auto-memory enabled |
| `AGENT_TRIGGERS` | Cron/scheduled task tools (CronCreate/Delete/List), scheduler | Registers cron tools; disable via `CLAUDE_CODE_DISABLE_CRON` |
| `AWAY_SUMMARY` | Detects user idle, generates summary of what happened | Passive trigger |
| `BASH_CLASSIFIER` | ML classifier for bash command safety | Changes permission pipeline |
| `BUILTIN_EXPLORE_PLAN_AGENTS` | Enables built-in Explore and Plan subagent types | Simple toggle |
| `COMPACTION_REMINDERS` | Injects compaction reminder into system prompt | Benign |
| `CONNECTOR_TEXT` | API beta: connector text blocks | Changes API beta headers |
| `EXTRACT_MEMORIES` | Background memory extraction on query completion | Controlled by `memoryExtraction` setting |
| `HISTORY_PICKER` | History search dialog (Ctrl+R alternative) | Benign UI addition |
| `HOOK_PROMPTS` | Passes `requestPrompt` to tool use context | Minimal (1 line) |
| `MCP_RICH_OUTPUT` | Enhanced MCP tool output rendering | Benign |
| `MESSAGE_ACTIONS` | Keyboard-navigable message actions (copy, retry) | Disable via `CLAUDE_CODE_DISABLE_MESSAGE_ACTIONS` |
| `POWERSHELL_AUTO_MODE` | Allows PowerShell tool in auto mode | Removes permission restriction |
| `PROMPT_CACHE_BREAK_DETECTION` | Monitors cache metrics for prompt cache breaks | Passive monitoring |
| `QUICK_SEARCH` | Quick Open + Global Search (Ctrl+F) | Benign UI addition |
| `SHOT_STATS` | Tracks one-shot vs multi-shot stats | Passive tracking |
| `TEAMMEM` | Team memory sync — shared memory files, filesystem watcher | Major subsystem |
| `TOKEN_BUDGET` | User-specified output token budget with enforcement | User types `+500k` to activate |
| `TRANSCRIPT_CLASSIFIER` | Auto mode — AI-powered permission classifier | Major subsystem; adds "auto" mode |
| `TREE_SITTER_BASH` | Tree-sitter-based bash parsing (replaces regex) | Security-sensitive parser change |
| `TREE_SITTER_BASH_SHADOW` | Shadow mode: tree-sitter in parallel, logs divergences | Non-destructive |

#### Additional feature flags (not in default or dev-full)

These must be individually enabled with `--feature=FLAG_NAME`:

| Flag | Description |
|------|-------------|
| `AUTO_THEME` | Adds "Auto (match terminal)" option to theme picker |
| `COMMIT_ATTRIBUTION` | Tracks permission/escape/prompt counts for commit attribution |
| `CONTEXT_COLLAPSE` | Archives older context into collapsed summaries (stub — no-op) |
| `EXPERIMENTAL_SKILL_SEARCH` | Remote skill search/indexing from MCP (stub — no-op) |
| `FILE_PERSISTENCE` | Post-turn file persistence with event emission (stub — no-op) |
| `MCP_SKILLS` | Fetches and registers skills from MCP server resources |
| `REACTIVE_COMPACT` | Trigger-based automatic compaction (stub — no-op) |
| `SLOW_OPERATION_LOGGING` | Performance instrumentation (JSON.stringify, structuredClone) |
| `TERMINAL_PANEL` | TerminalCaptureTool + meta+j keybinding |
| `UDS_INBOX` | Unix domain socket IPC — peer discovery, messaging, `/peers` |

Total: **65 unique build-time feature flags** (34 default + 21 dev-full + 10 additional).

All 65 flags build clean.

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
