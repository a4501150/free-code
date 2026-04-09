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
  - src/services/: API clients, OAuth/MCP integration, analytics stubs
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

**Dev-full build** (`bun run build:dev:full`): Enables all 32 experimental features listed in `fullExperimentalFeatures` in scripts/build.ts.

#### Experimental features (in `fullExperimentalFeatures` array)

These are enabled by `--feature-set=dev-full`:

| Flag | Description |
|------|-------------|
| `AGENT_MEMORY_SNAPSHOT` | Snapshot agent memory for context preservation |
| `AGENT_TRIGGERS` | Cron/scheduled task tools (CronCreate, CronDelete, CronList) |
| `AGENT_TRIGGERS_REMOTE` | Remote agent trigger support |
| `AWAY_SUMMARY` | Away summary when returning to a session |
| `BASH_CLASSIFIER` | ML classifier for bash command safety |
| `BUILTIN_EXPLORE_PLAN_AGENTS` | Built-in Explore and Plan subagent types |
| `CACHED_MICROCOMPACT` | Cached micro-compaction of conversation context |
| `COMPACTION_REMINDERS` | Reminders attached to compacted context |
| `CONNECTOR_TEXT` | Connector text blocks in API responses |
| `EXTRACT_MEMORIES` | Automatic memory extraction from conversations |
| `HISTORY_PICKER` | History picker UI (Ctrl+R alternative) |
| `HOOK_PROMPTS` | Pass request prompts to hooks |
| `KAIROS_BRIEF` | Brief/summary mode for Kairos assistant |
| `KAIROS_CHANNELS` | Channel-based notifications for Kairos |
| `LODESTONE` | Protocol registration and discovery |
| `MCP_RICH_OUTPUT` | Rich output rendering for MCP tool results |
| `MESSAGE_ACTIONS` | Message action buttons (copy, retry, etc.) |
| `NATIVE_CLIPBOARD_IMAGE` | Native clipboard image paste support |
| `NEW_INIT` | New `/init` flow for project setup |
| `POWERSHELL_AUTO_MODE` | Auto-mode support for PowerShell commands |
| `PROMPT_CACHE_BREAK_DETECTION` | Detect and handle prompt cache breaks |
| `QUICK_SEARCH` | Quick search overlay (Ctrl+F) |
| `SHOT_STATS` | Shot distribution statistics tracking |
| `TEAMMEM` | Team memory sync — shared memory files across team |
| `TOKEN_BUDGET` | Token budget tracking and enforcement |
| `TREE_SITTER_BASH` | Tree-sitter based bash command parsing |
| `TREE_SITTER_BASH_SHADOW` | Shadow mode for tree-sitter bash (comparison) |
| `ULTRAPLAN` | Enhanced plan mode with multi-agent orchestration |
| `ULTRATHINK` | Enhanced thinking/reasoning mode |
| `UNATTENDED_RETRY` | Automatic retry in unattended/headless mode |
| `VERIFICATION_AGENT` | Verification subagent for task validation |
| `VOICE_MODE` | Voice input/output (enabled by default in all builds) |

#### Additional feature flags (not in dev-full set)

These must be individually enabled with `--feature=FLAG_NAME`:

| Flag | Description |
|------|-------------|
| `AUTO_THEME` | Auto theme detection option in theme picker |
| `BG_SESSIONS` | Background sessions (ps/logs/attach/kill subcommands) |
| `BREAK_CACHE_COMMAND` | Cache-breaking command injection |
| `BUDDY` | Companion sprite / buddy character |
| `BUILDING_CLAUDE_APPS` | Bundled skill for building Claude API apps |
| `BYOC_ENVIRONMENT_RUNNER` | Bring-your-own-compute environment runner CLI |
| `COMMIT_ATTRIBUTION` | Git commit co-author attribution |
| `CONTEXT_COLLAPSE` | Context collapse for conversation management |
| `COORDINATOR_MODE` | Multi-agent coordinator mode |
| `DAEMON` | Long-running daemon/supervisor mode |
| `DIRECT_CONNECT` | Direct connection to remote instances |
| `DUMP_SYSTEM_PROMPT` | `--dump-system-prompt` CLI flag |
| `EXPERIMENTAL_SKILL_SEARCH` | Remote/experimental skill search and index |
| `FILE_PERSISTENCE` | File persistence/outputs scanning |
| `FORK_SUBAGENT` | Fork subagent capability (`/fork` command) |
| `HARD_FAIL` | Hard failure mode for debugging |
| `HISTORY_SNIP` | History snipping/compression tool |
| `KAIROS` | Full Kairos assistant mode (always-on agent) |
| `KAIROS_DREAM` | Kairos dream/consolidation feature |
| `KAIROS_GITHUB_WEBHOOKS` | GitHub webhook subscriptions for Kairos |
| `KAIROS_PUSH_NOTIFICATION` | Push notification support for Kairos |
| `MCP_SKILLS` | MCP-based skills system |
| `OVERFLOW_TEST_TOOL` | Debug/test tool for overflow testing |
| `PROACTIVE` | Proactive suggestions mode |
| `REACTIVE_COMPACT` | Reactive compaction strategy |
| `REVIEW_ARTIFACT` | Review artifact skill |
| `RUN_SKILL_GENERATOR` | Skill generator bundled skill |
| `SELF_HOSTED_RUNNER` | Self-hosted runner CLI |
| `SLOW_OPERATION_LOGGING` | Slow operation logging/diagnostics |
| `SSH_REMOTE` | SSH remote connections |
| `STREAMLINED_OUTPUT` | Streamlined output format |
| `TEMPLATES` | Template job commands (new/list/reply) |
| `TERMINAL_PANEL` | Terminal panel capture tool |
| `TRANSCRIPT_CLASSIFIER` | Transcript classifier for auto-mode permissions |
| `UDS_INBOX` | Unix domain socket messaging/inbox |
| `WORKFLOW_SCRIPTS` | Workflow scripts tool |

Total: **66 unique build-time feature flags** (32 in dev-full + 34 additional).

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
| `CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK` | Disable non-streaming fallback |
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
| `CLAUDE_CODE_MAX_CONTEXT_TOKENS` | Max context tokens override |
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
| `CLAUDE_CODE_HARD_FAIL` | Hard fail mode for debugging |
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
