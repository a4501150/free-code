# CLAUDE.md

Guidance for agents working in this repository. Keep this file short: prefer links to source-of-truth files over copied config values, command tables, schemas, or code examples.

## Start here

- Use [package.json](package.json) for current build, run, format, typecheck, and test scripts.
- The standard built CLI is `./cli`; the dev build is `./cli-dev`. E2E tests drive the built `./cli`, so rebuild after source edits before running them.
- Main entry points: [src/entrypoints/cli.tsx](src/entrypoints/cli.tsx), [src/screens/REPL.tsx](src/screens/REPL.tsx), and [src/QueryEngine.ts](src/QueryEngine.ts).
- Registries: [src/commands.ts](src/commands.ts) and [src/tools.ts](src/tools.ts). Implementations live under [src/commands/](src/commands/) and [src/tools/](src/tools/).
- Major subsystems live under [src/services/](src/services/), [src/state/](src/state/), [src/hooks/](src/hooks/), [src/components/](src/components/), [src/skills/](src/skills/), [src/plugins/](src/plugins/), [src/voice/](src/voice/), and [src/tasks/](src/tasks/).

## Source-of-truth map

Read these files instead of duplicating their contents here:

- Settings/freecode schema and defaults: [src/utils/settings/types.ts](src/utils/settings/types.ts).
- Settings migration: [src/utils/settings/migrateToFreecode.ts](src/utils/settings/migrateToFreecode.ts).
- Provider registry and model lookup: [src/utils/model/providerRegistry.ts](src/utils/model/providerRegistry.ts).
- Legacy provider migration: [src/utils/model/legacyProviderMigration.ts](src/utils/model/legacyProviderMigration.ts).
- Agent model resolution and sentinels: [src/utils/model/agent.ts](src/utils/model/agent.ts).
- Model helpers: [src/utils/model/modelResolution.ts](src/utils/model/modelResolution.ts), [src/utils/model/modelDisplay.ts](src/utils/model/modelDisplay.ts), and [src/utils/model/model.ts](src/utils/model/model.ts).
- API client impure shell: [src/services/api/client.ts](src/services/api/client.ts).
- Provider adapters: [src/services/api/](src/services/api/).
- API constants: [src/constants/api.ts](src/constants/api.ts).
- Build flags, defines, and React Compiler staging: [scripts/build.ts](scripts/build.ts).
- Runtime env semantics: search source references and read [src/utils/envUtils.ts](src/utils/envUtils.ts).

## Testing

- E2E tests launch the compiled CLI through tmux. Test harnesses and fixture builders live in [tests/helpers/](tests/helpers/) and [tests/e2e/tmux-helpers.ts](tests/e2e/tmux-helpers.ts).
- Unit tests live in [tests/unit/](tests/unit/) and cover adapters, settings, token handling, schemas, and parsing utilities.
- After source edits, run `bun run build` before E2E tests; otherwise tests may exercise a stale `./cli`.
- Run the suites that cover the changed subsystem. If no suite covers the behavior, add or update a focused test.
- For new E2E files, copy timing/session patterns from existing [tests/e2e/](tests/e2e/) files rather than inventing new sleeps.

### Test gotchas

- `TmuxSession` runs with `NODE_ENV=test`; debug logging is suppressed unless debug flags are passed. For ad-hoc diagnostics, CLI `console.error` output is visible through the tmux log helpers.
- Prefer mock server request logs over pane scraping when asserting API payloads; rendered ANSI can contaminate scraped text.
- E2E tests need explicit timeouts and polling helpers such as `waitFor`, `waitForRequestCount`, `waitForRequest`, and `TmuxSession.waitForScreen`.
- Prompt suggestions are disabled in `TmuxSession` by default because hidden suggestion calls consume mock server responses. Tests that enable them must account for extra requests.
- Group multiple turns in one tmux session only when startup, history, resume, and stream-state assumptions are irrelevant. Reset mock servers only after the previous turn is idle.
- To test subagent model resolution, use a unique marker in the subagent system prompt and locate the subagent request in the mock server log. For feature-flag-gated built-ins, prefer a user-defined markdown agent in the test fixture. See [tests/e2e/provider-config.test.ts](tests/e2e/provider-config.test.ts).

## Provider system rules

- Provider configuration is driven by `freecode.json`; when providers are absent, legacy env/config migration synthesizes them. Read the source-of-truth files above for exact schemas and resolution order.
- Keep adapters pure: no direct env reads and no auth imports inside provider adapters. Auth/config enters through `ProviderConfig` and injected callbacks; [src/services/api/client.ts](src/services/api/client.ts) owns the impure boundary.
- Query capabilities through the registry instead of branching on provider identity. Special cases for Anthropic proxies, first-party features, and cache behavior belong in the provider/model layer.
- Auth is independent of wire format. Do not assume a provider type implies a specific auth method.
- Do not hardcode Anthropic URLs or API versions outside [src/constants/api.ts](src/constants/api.ts).
- Anthropic-platform-only body metadata and headers must stay gated to Anthropic-type providers. This prevents meaningless identifiers and per-session cache-key churn on other providers.
- `defaultSubagentModel` is a hard override for subagent routing. If changing tiered agent model behavior, read [src/utils/model/agent.ts](src/utils/model/agent.ts) and the provider-config tests first.

## Build and settings rules

- Feature flags are compile-time `feature(...)` gates. Before adding or changing a flag, inspect [scripts/build.ts](scripts/build.ts) and existing source references so the flag is intentionally default, dev-full, or explicitly build-only.
- Do not reintroduce React Compiler artifacts into source. The checked-in `.tsx` files are the clean pre-compilation source; compiler output belongs only in the build staging path.
- Do not copy settings tables, default model lists, env-var lists, or feature-flag lists into this file. Link to the schema or build script instead.

## Non-obvious gotchas

### Scroll re-pin after context clear or conversation ID changes

Virtual scrolling caches item heights by message UUID and conversation ID. If you modify clear, compact, plan-mode approval, or any path that bumps `conversationId`, ensure scroll is re-pinned after the bump and after async operations that can render intermediate empty ranges. Read [src/hooks/useVirtualScroll.ts](src/hooks/useVirtualScroll.ts), [src/commands/clear/conversation.ts](src/commands/clear/conversation.ts), and the relevant REPL code before changing these paths.

### Fingerprint stability depends on the first API user message

Anthropic attribution uses a fingerprint derived from the first API user message. Do not add per-turn dynamic content ahead of it, reshape the stable user-context prepend, remove module-level memoization from user context, or clear user-context caches except at semantic invalidation boundaries such as prompt injection changes, compact, or clear. Read [src/utils/fingerprint.ts](src/utils/fingerprint.ts), [src/utils/api.ts](src/utils/api.ts), [src/context.ts](src/context.ts), [src/services/api/claude.ts](src/services/api/claude.ts), and the compact/clear cleanup code before touching this flow.

### Codex Responses adapter must tolerate noncanonical llama.cpp SSE

The codex `/v1/responses` adapter intentionally handles llama.cpp event-order differences for reasoning blocks, missing function-call argument done events, reasoning metadata side-channel deltas, and parallel tool-call item ordering. Do not simplify these state-machine branches without running the codex adapter unit tests and checking [src/services/api/codex-fetch-adapter.ts](src/services/api/codex-fetch-adapter.ts), [src/services/api/claude.ts](src/services/api/claude.ts), and [tests/unit/](tests/unit/).

### ScrollBox children should not rely on percentage height

Inside ScrollBox content, a Yoga node with percentage height can collapse after culling and re-entry. Prefer an explicit minimum height or stretch with no shrink for divider-like children. See [src/components/LogoV2/LogoV2.tsx](src/components/LogoV2/LogoV2.tsx) for the current pattern.
