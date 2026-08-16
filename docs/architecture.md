# Architecture

A Bun-compiled TypeScript CLI. The terminal UI is React, rendered by a
repository-local terminal renderer. The optional browser UI is React in a real
browser, served by `Bun.serve`.

## Entry points

| Path                                                                            | Role                                                                         |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| [src/entrypoints/cli.tsx](../src/entrypoints/cli.tsx)                           | The executable's entry. Routes to the REPL, to a subcommand or to the daemon |
| [src/main.tsx](../src/main.tsx)                                                 | Commander program, flag parsing, startup order                               |
| [src/setup.ts](../src/setup.ts)                                                 | Startup sequence: working directory, hooks, plugins, commands                |
| [src/commands.ts](../src/commands.ts)                                           | Slash-command registry                                                       |
| [src/tools.ts](../src/tools.ts)                                                 | Agent-tool registry                                                          |
| [src/QueryEngine.ts](../src/QueryEngine.ts) and [src/query.ts](../src/query.ts) | The agent loop                                                               |
| [src/screens/REPL.tsx](../src/screens/REPL.tsx)                                 | The interactive screen                                                       |

The import order at the top of `main.tsx` matters. Two side effects run before
the heavy modules load: a startup profile mark, and a parallel macOS keychain
prefetch. Do not reorder them.

## Source directories

`src/` holds 36 directories.

### Agent loop and tools

| Directory      | Contents                                                               |
| -------------- | ---------------------------------------------------------------------- |
| `query/`       | Loop configuration, dependencies, terminal transitions, stop hooks     |
| `tools/`       | Agent tools: Bash, Read, Edit, Agent, Skill, MCP, LSP and the rest     |
| `tasks/`       | Background task management                                             |
| `skills/`      | The skill system                                                       |
| `plugins/`     | The plugin system                                                      |
| `coordinator/` | Coordinator mode: prompt and tool filtering, the worker-agent provider |
| `assistant/`   | Assistant-mode activation, team setup and prompt additions             |
| `proactive/`   | The autonomous-mode state machine                                      |
| `memdir/`      | Memory directories, scanning, age and relevance, prompt construction   |

### Model and transport

| Directory             | Contents                                                            |
| --------------------- | ------------------------------------------------------------------- |
| `services/api/`       | One adapter per wire format, plus retry, errors and transport       |
| `services/mcp/`       | MCP client over stdio, SSE and streamable HTTP                      |
| `services/lsp/`       | LSP client. The tool is off unless `ENABLE_LSP_TOOL` is set         |
| `services/oauth/`     | OAuth flows for Anthropic and OpenAI                                |
| `services/compact/`   | Conversation compaction                                             |
| `utils/model/`        | Provider registry, presets, model resolution, legacy migration      |
| `utils/settings/`     | Settings schema, the `freecode.json` and `modelSettings.json` split |
| `types/`              | Provider-neutral domain types and their guards                      |
| `structuredProtocol/` | Message, control and settings types for structured transport        |
| `remote/`             | Adapters between remote SDK messages and local REPL messages        |
| `schemas/`            | Shared Zod schemas, kept separate to break import cycles            |

Every provider converts to one domain message shape. Code above the adapter layer
never sees a wire type. See [src/types/domain.ts](../src/types/domain.ts).

### Terminal UI

| Directory       | Contents                                                                |
| --------------- | ----------------------------------------------------------------------- |
| `ink/`          | The terminal renderer                                                   |
| `native-ts/`    | Pure TypeScript replacements for native modules                         |
| `components/`   | UI components                                                           |
| `hooks/`        | React hooks                                                             |
| `context/`      | React contexts: overlays, modals, queued messages, notifications, voice |
| `screens/`      | Full screens, including the REPL                                        |
| `keybindings/`  | Keybinding schema, defaults, parsing, resolution, user overrides        |
| `vim/`          | Vim mode: state transitions, motions, operators, text objects           |
| `outputStyles/` | Built-in, plugin, user and project output styles                        |
| `state/`        | The application state store                                             |
| `bootstrap/`    | Process and session state: working directory, identity, usage, model    |

Two of these surprise people:

- **`ink/` is not the npm package.** It is a 101-file local implementation on `react-reconciler`, reached through [src/ink.ts](../src/ink.ts). `ink` stays declared in `package.json`, but no runtime module imports it. Change the local tree, not the dependency.
- **`native-ts/` removes native modules.** It holds a Yoga-compatible layout engine, a fuzzy file index and a color diff, all in TypeScript, so the binary needs no native build step.

### Interfaces

| Directory    | Contents                                                                |
| ------------ | ----------------------------------------------------------------------- |
| `cli/`       | Headless output, NDJSON and structured I/O, export, subcommand handlers |
| `daemon/`    | Daemon supervisor commands and the worker registry                      |
| `webui/`     | The browser session UI                                                  |
| `voice/`     | Voice input                                                             |
| `commands/`  | Slash-command implementations                                           |
| `constants/` | API, beta, OAuth, prompt, product and error constants                   |
| `utils/`     | Everything else, including `bash/`, `permissions/` and `hooks`          |
| `vendor/`    | The source-vendored Claude-for-Chrome MCP bridge                        |
| `buddy/`     | A companion sprite behind the `BUDDY` flag. Nothing imports it today    |
| `moreright/` | A no-op compatibility stub                                              |

## The browser UI

`src/webui/` is behind the `WEBUI` flag, which only a dev-full build enables.

| Path               | Role                                                                 |
| ------------------ | -------------------------------------------------------------------- |
| `webui/attach/`    | A per-process Unix socket that exposes a live session                |
| `webui/gateway/`   | The authenticated HTTP server, hosted inside the daemon              |
| `webui/client/`    | The React browser client                                             |
| `webui/protocol/`  | Shared schemas for the socket and the HTTP API                       |
| `webui/tunnel/`    | Tunnel providers for a public URL                                    |
| `webui/generated/` | The compiled client asset. Git-ignored, stubbed when the flag is off |

The gateway binds `127.0.0.1`. A tunnel is the only public path. The socket keys
on process ID and a nonce, never on session ID, because a session ID moves
between processes.

## Build-time feature flags

`feature('NAME')` from `bun:bundle` is a compile-time switch, not a runtime
check. The build replaces it with a constant and the bundler removes the dead
branch.

Because of that, a flag that is off is absent from the binary. See
[building.md](building.md) for the sets and [FEATURES.md](../FEATURES.md) for the
per-flag audit.
