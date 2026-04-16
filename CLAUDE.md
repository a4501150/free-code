# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Quickstart

- Build/run/test commands: see `scripts` in [package.json](package.json).
- Binaries: `./cli` (standard build) and `./cli-dev` (dev build). `./cli` is what `bun test` runs against.
- Auth: set `ANTHROPIC_API_KEY`, or run `./cli /login` for OAuth.

## High-level architecture

- Entry point: [src/entrypoints/cli.tsx](src/entrypoints/cli.tsx) bootstraps the CLI.
- Main UI: [src/screens/REPL.tsx](src/screens/REPL.tsx) (Ink/React).
- Query pipeline: [src/QueryEngine.ts](src/QueryEngine.ts) coordinates message flow, tool use, and model calls.
- Registries: [src/commands.ts](src/commands.ts) (slash commands) and [src/tools.ts](src/tools.ts) (tools). Bodies live under `src/commands/` and `src/tools/`.
- Subsystems: `src/services/` (API, OAuth, MCP), `src/state/`, `src/hooks/`, `src/components/`, `src/skills/`, `src/plugins/`, `src/bridge/` (IDE), `src/voice/`, `src/tasks/` (background).

## Testing

All tests are e2e — they launch the compiled `./cli` against a mock API server and drive it through tmux.

- Shared infrastructure: `tests/helpers/` — `mock-server.ts`, `mock-openai-server.ts`, `sse-encoder.ts`, `fixture-builders.ts`.
- Suites: `tests/e2e/` — `tmux-helpers.ts` provides `TmuxSession`. `submitAndApprove()` auto-approves permission dialogs.
- Verification hooks: `server.getRequestLog()` (what was sent), `readFile()` (disk side effects), `capturePane()` (on-screen output).
- **`./cli` must be built first** (`bun run build`), NOT `./cli-dev`.

**Debug logging gotcha**: `tmux-helpers.ts` sets `NODE_ENV=test`, and `shouldLogDebugMessage` in [src/utils/debug.ts](src/utils/debug.ts) suppresses `logForDebugging` when `NODE_ENV=test` unless `--debug`/`--debug-to-stderr` is passed. To capture debug logs from an e2e run, pass `additionalArgs: ['--debug']` to `TmuxSession` and read from the config dir.

## Provider system

Model/provider is config-driven via the `providers` field in `freecode.json`. Each provider has a wire-format type, auth config, and model list. When `freecode.json` has no `providers`, a legacy migration synthesizes one from env vars.

### Data flow

```
freecode.json providers  (or legacy env-var migration)
  → ProviderRegistry (singleton, lazy-init)
    → resolveDefaultProvider() / getProviderForModel(model)
      → createClientForProvider()
        → Anthropic SDK + per-type fetch adapter (or native for `anthropic`)
```

### Source of truth

Read these files — do not duplicate their contents here.

- [src/utils/settings/types.ts](src/utils/settings/types.ts) — Zod schemas: `ProviderConfig`, `ProviderModelSchema`, `ProviderAuthConfig`, `ProviderCacheConfig`, `ProviderCapabilitiesSchema`. Also the schema for every freecode.json setting (models, metadata, capabilities, pricing, thinking flags, etc.).
- [src/utils/model/providerRegistry.ts](src/utils/model/providerRegistry.ts) — registry singleton, capability derivation, model indexing, `resolveModelId()`, `propagateModelPrefix()`.
- [src/utils/model/legacyProviderMigration.ts](src/utils/model/legacyProviderMigration.ts) — legacy env vars → provider config (resolves provider-specific env vars into `config.baseUrl`/`config.auth`).
- [src/utils/settings/migrateToFreecode.ts](src/utils/settings/migrateToFreecode.ts) — one-time settings.json → freecode.json migration (incl. `mcpServers` pulled from `~/.claude.json`). Each field promotion is guarded individually so new promotions take effect on existing installs.
- [src/utils/model/agent.ts](src/utils/model/agent.ts) — agent model resolution; sentinel definitions.
- [src/utils/model/modelResolution.ts](src/utils/model/modelResolution.ts), [src/utils/model/modelDisplay.ts](src/utils/model/modelDisplay.ts), [src/utils/model/model.ts](src/utils/model/model.ts) (barrel).
- [src/services/api/client.ts](src/services/api/client.ts) — `getAnthropicClient()`; the only impure shell that creates auth closures for adapters.
- `src/services/api/*-adapter.ts` — one adapter per non-Anthropic wire format.
- [src/constants/api.ts](src/constants/api.ts) — `ANTHROPIC_API_VERSION` and `getApiBaseUrl()`.

### Rules when touching the provider system

- **Adapters are pure.** Zero `process.env` reads, zero auth imports. Everything comes through `ProviderConfig` and injected callbacks. The "impure shell" lives only in [src/services/api/client.ts](src/services/api/client.ts).
- **Query capabilities, not provider identity.** Use `registry.getCapability(model, 'capName')` instead of `isBedrockProvider()` / `isVertexProvider()`. Capabilities are derived from `config.type` with special handling for Anthropic proxies (non-official baseUrl ⇒ `firstPartyFeatures: false`). See `ProviderCapabilitiesSchema` in types.ts.
- **Auth is orthogonal to wire format.** Any of `apiKey`, `bearer`, `oauth`, `aws`, `gcp`, `azure` can pair with any provider type. Resolution reads `config.auth.active`.
- **Cache behavior is per-provider** via `cache.type`: `explicit-breakpoint` (keep `cache_control` markers), `automatic-prefix` (strip markers, provider caches automatically), `none` (strip markers, no caching). Enforced in `getPromptCachingEnabled()` in [src/services/api/claude.ts](src/services/api/claude.ts).
- **No hardcoded Anthropic URLs or version strings** outside [src/constants/api.ts](src/constants/api.ts). All non-SDK Anthropic HTTP calls go through `getApiBaseUrl()` + `ANTHROPIC_API_VERSION`.

### Agent model sentinels

Built-in agents use sentinel strings instead of hardcoded model IDs; resolved at runtime by `getAgentModel()` in [src/utils/model/agent.ts](src/utils/model/agent.ts):

- `'smallFast'` → `defaultSmallFastModel` (used by Explore, claude-code-guide)
- `'balanced'` → `defaultBalancedModel` → falls back to inherit (used by statusline-setup, magicDocs)
- `'inherit'` → parent model

`defaultSubagentModel` (or env `CLAUDE_CODE_SUBAGENT_MODEL`) is a **hard override** that beats tool-specified and agent-definition models.

### Resolution priority (primary / subagent / smallFast model)

env var override > freecode.json field > hardcoded fallback.

### Known limitations (do not "fix" these without context)

- **Circular dep `providerRegistry.ts` ↔ `auth.ts`**: mitigated by lazy `require()` in providerRegistry.
- **`modelResolution.ts` env reads** (`ANTHROPIC_MODEL`, `ANTHROPIC_SMALL_FAST_MODEL`): user-facing config, acceptable.
- **Adapter fallback model IDs** (e.g. `'gemini-2.0-flash'`, `'gpt-4'`): adapter-internal defaults, acceptable.
- **Fast mode hardcodes `'opus'`** ([src/utils/fastMode.ts](src/utils/fastMode.ts)): this is an Anthropic API protocol value gated by `firstPartyFeatures`, not a provider-system model ID. Intentional; marked `@[MODEL LAUNCH]`.
- **Substring model-family checks** (`.includes('opus')` / `['haiku']` etc. at a handful of call sites in claude.ts, errors.ts, toolSearch.ts, rateLimitMocking.ts): fragile but low-priority; should eventually become capability queries.
- **`modelDisplay.ts` has several overlapping display helpers** (`getPublicModelDisplayName`, `renderModelName`, `getPublicModelName`, etc.). Prime candidates for inlining — check call counts before consolidating.

## Build system

- Build script: [scripts/build.ts](scripts/build.ts). Read this for: the full feature-flag list, which flags are in the default set vs. `fullExperimentalFeatures` (dev-full), and all `--define` macro values.
- **Feature flags** use Bun's `feature('FLAG')` — untouched flags are stripped entirely at build time (compile-time DCE). Pass `--feature=FLAG` or `--feature-set=dev-full`.
- **React Compiler is optional** (`--react-compiler`). Default builds skip it. The `.tsx` files in `src/` are the **clean pre-compilation source** — do not reintroduce compiler artifacts (`_c()`, `$[N]` patterns) when editing.

## Settings (freecode.json) and environment variables

- **Settings schema** (the authoritative list of every setting + its default): [src/utils/settings/types.ts](src/utils/settings/types.ts). Do not maintain a duplicate table here.
- **Default model fields** (`defaultModel`, `defaultSubagentModel`, `defaultSmallFastModel`, `defaultBalancedModel`, `availableSubagentModels`) live in freecode.json. See the schema; resolution priority above applies.
- **Runtime environment variables**: full list is in the source — grep for `isEnvTruthy(` and `process.env.CLAUDE_CODE_` / `process.env.ANTHROPIC_`. `isEnvTruthy` is defined in [src/utils/envUtils.ts](src/utils/envUtils.ts); truthy values are `'1'`, `'true'`, `'yes'`, `'on'` (case-insensitive).

## Gotchas

### Scroll re-pin after context clear / conversationId bump

The virtual scroll ([src/hooks/useVirtualScroll.ts](src/hooks/useVirtualScroll.ts)) caches item heights keyed by message UUID + `conversationId`. `clearConversation` ([src/commands/clear/conversation.ts](src/commands/clear/conversation.ts)) does `setMessages([])` + `setConversationId(randomUUID())`, invalidating the entire cache. Without `scrollToBottom()` after the bump, stale `scrollTop` lands in an empty offset range ⇒ **blank screen** (recovers on user scroll).

**Invariant**: `stickyScroll=true` on ScrollBox ⇒ `useVirtualScroll` uses the tail-walk path (always shows the last N items). When `stickyScroll=false`, the visible range is computed from `scrollTop` — stale `scrollTop` after cache wipe ⇒ empty range ⇒ blank.

Re-pin call sites that defend this invariant (each covers a distinct code path — read the surrounding code before removing any):

- `scrollToBottom()` immediately after `setConversationId()` inside `clearConversation`.
- `scrollToBottom()` at the end of `clearConversation` (covers standalone `/clear`, which bypasses `processInitialMessage`).
- `setTimeout(repinScroll, 0)` after `onQuery` in `processInitialMessage` in REPL.tsx (plan-mode path; catches intermediate renders across `await` boundaries).
- `repinScroll()` in the `lastMsgIsHuman` and `focusedInputDialog` effects in REPL.tsx.

**Rule**: if you modify `clearConversation`, compaction, or plan-mode approval, ensure `scrollToBottom()` fires after every `setConversationId()` bump and after every async op that can trigger an intermediate render.

### Yoga percentage-height collapse inside ScrollBox

A node inside a ScrollBox with `height="100%"` can collapse to 0 after being culled by `renderScrolledChildren` and then re-entering the viewport on scroll-back. `dropSubtreeCache` removes the nodeCache entry, and Yoga percentage resolution needs a definite parent height — a content-sized flex-row parent does not provide one on relayout.

**Symptom**: a border-only `<Box>` (e.g. a vertical divider) disappears after scroll-back.

**Fix**: inside ScrollBox content, use `minHeight={N}` or `alignSelf="stretch"` + `flexShrink={0}` instead of `height="100%"`. Applied at [src/components/LogoV2/LogoV2.tsx](src/components/LogoV2/LogoV2.tsx) (vertical divider, `minHeight={9}`).
