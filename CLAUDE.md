# CLAUDE.md

Guidance for agents working in this repository. Keep this file short: prefer links to source-of-truth files over copied config values, command tables, schemas, or code examples.

## Start here

- Use [package.json](package.json) for current build, run, format, typecheck, and test scripts.
- The standard dev build is `bun run build:dev:full` which outputs `./cli-dev` with all feature flags enabled. E2E tests drive `./cli-dev`, so rebuild after source edits before running them.
- The production build is `bun run build` which outputs `./cli` with default feature flags.
- Main entry points: [src/entrypoints/cli.tsx](src/entrypoints/cli.tsx), [src/screens/REPL.tsx](src/screens/REPL.tsx), and [src/QueryEngine.ts](src/QueryEngine.ts).
- Registries: [src/commands.ts](src/commands.ts) and [src/tools.ts](src/tools.ts). Implementations live under [src/commands/](src/commands/) and [src/tools/](src/tools/).
- Major subsystems live under [src/services/](src/services/), [src/state/](src/state/), [src/hooks/](src/hooks/), [src/components/](src/components/), [src/skills/](src/skills/), [src/plugins/](src/plugins/), [src/voice/](src/voice/), and [src/tasks/](src/tasks/).

## Source-of-truth map

Read these files instead of duplicating their contents here:

- Settings/freecode schema and defaults: [src/utils/settings/types.ts](src/utils/settings/types.ts).
- Settings migration: [src/utils/settings/claudeMigration.ts](src/utils/settings/claudeMigration.ts).
- Project config path helpers: [src/utils/projectConfigPaths.ts](src/utils/projectConfigPaths.ts).
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
- After source edits, run `bun run build:dev:full` before E2E tests; otherwise tests may exercise a stale `./cli-dev`.
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

- Provider configuration is driven by `freecode.json`. Read the source-of-truth files above for exact schemas and resolution order.
- Keep adapters pure: no direct env reads and no auth imports inside provider adapters. Auth/config enters through `ProviderConfig` and injected callbacks; [src/services/api/client.ts](src/services/api/client.ts) owns the impure boundary.
- Query capabilities through the registry instead of branching on provider identity. Special cases for Anthropic proxies, first-party features, and cache behavior belong in the provider/model layer.
- Auth is independent of wire format. Do not assume a provider type implies a specific auth method.
- Do not hardcode Anthropic URLs or API versions outside [src/constants/api.ts](src/constants/api.ts).
- Anthropic-platform-only body metadata and headers must stay gated to Anthropic-type providers. This prevents meaningless identifiers and per-session cache-key churn on other providers.
- `defaultSubagentModel` is a hard override for subagent routing. If changing tiered agent model behavior, read [src/utils/model/agent.ts](src/utils/model/agent.ts) and the provider-config tests first.

### Anthropic first-party request requirements

Three mechanisms are required for 1P Anthropic API requests. All three must stay gated to Anthropic-type providers.

1. **`x-anthropic-billing-header`** (system prompt block) — Attribution string embedded as the first system prompt `TextBlockParam` (not an HTTP header). Built by `getAttributionHeader()` in [src/constants/system.ts](src/constants/system.ts). Contains `cc_version=<version>.<fingerprint>`, `cc_entrypoint`, `cch=<integrity_hash>`, and optional `cc_workload`. The `cch` placeholder is replaced at fetch time in [src/services/api/client.ts](src/services/api/client.ts) with an xxHash64 over the serialized body; the server verifies this to gate features like fast mode. Always gets `cacheScope: null` to avoid polluting cache keys. Can be disabled via `CLAUDE_CODE_ATTRIBUTION_HEADER=false`.

2. **`metadata.user_id`** (request body field) — JSON-stringified object containing `device_id`, `account_uuid`, `session_id`, and optional extra fields from `CLAUDE_CODE_EXTRA_METADATA`. Built by `getAPIMetadata()` in [src/services/api/claude.ts](src/services/api/claude.ts). Required for rate limiting and user identification; requests without it get 429s.

3. **`CLISyspromptPrefix`** (system prompt identity) — The "You are Claude Code, Anthropic's official CLI" string placed immediately after the billing header. Built by `getCLISyspromptPrefix()` in [src/constants/system.ts](src/constants/system.ts). The 1P API requires this for non-Haiku models; requests without it are rejected. Has three variants (default, headless with preset, headless without preset) selected by the `customSyspromptPrefix` provider capability. Gets `cacheScope: 'org'` in `splitSysPromptPrefix`.

## Build and settings rules

- Feature flags are compile-time `feature(...)` gates. Before adding or changing a flag, inspect [scripts/build.ts](scripts/build.ts) and existing source references so the flag is intentionally default, dev-full, or explicitly build-only.
- Do not reintroduce React Compiler artifacts into source. The checked-in `.tsx` files are the clean pre-compilation source; compiler output belongs only in the build staging path.
- Do not copy settings tables, default model lists, env-var lists, or feature-flag lists into this file. Link to the schema or build script instead.

## Non-obvious gotchas

### Scroll re-pin after context clear or conversation ID changes

Virtual scrolling caches item heights by message UUID and conversation ID. If you modify clear, compact, plan-mode approval, or any path that bumps `conversationId`, ensure scroll is re-pinned after the bump and after async operations that can render intermediate empty ranges. Read [src/hooks/useVirtualScroll.ts](src/hooks/useVirtualScroll.ts), [src/commands/clear/conversation.ts](src/commands/clear/conversation.ts), and the relevant REPL code before changing these paths.

### Fingerprint stability depends on the first API user message

Anthropic attribution uses a fingerprint derived from the first API user message. Do not add per-turn dynamic content ahead of it, reshape the stable user-context prepend, remove module-level memoization from user context, or clear user-context caches except at semantic invalidation boundaries such as prompt injection changes, compact, or clear. Read [src/utils/fingerprint.ts](src/utils/fingerprint.ts), [src/utils/api.ts](src/utils/api.ts), [src/context.ts](src/context.ts), [src/services/api/claude.ts](src/services/api/claude.ts), and the compact/clear cleanup code before touching this flow.

### UI task store must bypass AsyncLocalStorage agent context

`TasksV2Store` in [src/hooks/useTasksV2.ts](src/hooks/useTasksV2.ts) must use `getMainTaskListId()`, not `getTaskListId()`. Signals like `notifyTasksUpdated()` fire inside the subagent's `AsyncLocalStorage` scope, and `setTimeout` inherits that context — causing the main UI to fetch from the wrong task list directory.

### Subagent UI state travels through the task, not the parent's callbacks

`createSubagentContext` in [src/utils/forkedAgent.ts](src/utils/forkedAgent.ts) deliberately nulls every parent UI callback, so nothing a subagent does can reach the leader's spinner directly. Anything the drill-down or the Agent card must show has to be routed onto `LocalAgentTaskState` ([src/tasks/LocalAgentTask/LocalAgentTask.tsx](src/tasks/LocalAgentTask/LocalAgentTask.tsx)) via an explicit `runAgent` callback, the way `onStreamMode` and `onCompactProgress` are. Two consequences:

- Every `runAgent` consumer must call `appendRetainedAgentMessage`, or the drill-down transcript for that flavour of agent renders empty. There are three loops: `runAsyncAgentLifecycle` in [src/tools/AgentTool/agentToolUtils.ts](src/tools/AgentTool/agentToolUtils.ts), plus the foreground and backgrounded-continuation loops in [src/tools/AgentTool/AgentTool.tsx](src/tools/AgentTool/AgentTool.tsx).
- The live Agent card in the main transcript is `AgentProgressLine` reached through `GroupedAgentToolUseView`, _not_ `renderToolUseProgressMessage` — the latter only serves the non-grouped and slash-command paths. Changing only one of them looks like the change had no effect.

### `stream_event` content blocks carry domain types, not wire types

By the time a `stream_event` leaves [src/services/api/claude.ts](src/services/api/claude.ts) its `content_block` has been converted to a `DomainContentBlock`, so extended thinking is `reasoning`/`redacted_reasoning` — never `thinking`. `DomainStreamEvent.content_block` widens to `{ type: string; ... }` ([src/types/domain.ts](src/types/domain.ts)), so comparing against a wire type still typechecks and silently never matches. Use the guards in [src/types/domainGuards.ts](src/types/domainGuards.ts).

### Project config uses both `.claude/` and `.freecode/` directories

Per-project config supports both `.claude/` (legacy) and `.freecode/` (preferred). When both exist, `.freecode/` takes precedence. Use helpers from [src/utils/projectConfigPaths.ts](src/utils/projectConfigPaths.ts) instead of hardcoding either directory name.

### ScrollBox children must not size themselves from the cross axis

Inside ScrollBox content, a Yoga node whose height comes from the parent — a percentage height, or `alignSelf: 'stretch'` on a node with no content — can collapse after culling and re-entry, falling back to its `minHeight`. A vertical divider built that way silently paints short. Give divider-like nodes real content instead: in [src/components/LogoV2/LogoV2.tsx](src/components/LogoV2/LogoV2.tsx) the divider is the right panel's `borderLeft`, so its height is the feed's own height. Reproduce with `!seq 1 200` to push the node out of view, then PgUp back to it.

### `disableAllHooks` must be checked at every hook channel

Settings hooks, plugin-registered hooks, and session-derived (agent/skill frontmatter) hooks are assembled separately in [src/utils/hooks.ts](src/utils/hooks.ts). `areAllHooksDisabled()` from [src/utils/hooks/hooksConfigSnapshot.ts](src/utils/hooks/hooksConfigSnapshot.ts) gates each one independently — dropping the check at any single channel silently re-enables that channel. `hasWorktreeCreateHook()` mirrors the same filtering and must stay in sync, or it reports hooks that execution then can't find.

### Null tool arguments are omissions, except where the schema admits null

The Responses API normalizes a function tool's schema into OpenAI's strict subset on its own, and strict requires every property to sit in `required` — so on the codex path a model cannot omit an optional field and sends `null` instead. [src/utils/stripStrictNullInputs.ts](src/utils/stripStrictNullInputs.ts) removes those placeholders before validation, but only where the schema says the field may be absent, and never for a `null` the schema itself admits: an MCP tool can mean something by it (agent-browser's `browser_open {profile: null}` asks for a throwaway profile). Same for `""` on a required field, which is a value, not an omission. Pass it `tool.inputJSONSchema ?? tool.inputSchema` — an MCP tool's Zod schema is an opaque passthrough, so the Zod schema alone makes every MCP argument unrecognizable and strips it.

### modelSettings.json is filtered to model keys on read

`modelSettings.json` merges after `freecode.json` within `userSettings`, and `SettingsSchema` is `.passthrough()`, so any general key there would silently outrank `freecode.json`. Reads project it to `MODEL_SETTINGS_KEYS` ([src/utils/settings/modelSettingsKeys.ts](src/utils/settings/modelSettingsKeys.ts)) to mirror the existing write routing. The projection runs on raw JSON _before_ schema validation, so an invalid general key can't fail the file and take its provider config down with it. Model keys still resolve from `freecode.json` when absent from `modelSettings.json`.

### Terminals mangle modified arrow keys — don't build UI on them

Apple Terminal strips shift from arrows: `shift+↑` arrives as a bare `up`, so a `key.shift`-gated branch can never fire there, and the bare arrow silently triggers whatever plain-arrow behavior exists. It sends `option+↑` as ESC-prefixed `ESC ESC [ A`, often split across reads, which [src/ink/parse-keypress.ts](src/ink/parse-keypress.ts) parses as `escape` then `up` — enough to cancel a dialog. ESC-prefix _is_ folded into `meta` for letters (`ESC p` → meta+p, which is why `alt+p` works), just not for CSI sequences. Modified arrows are fine as an enhancement on terminals that transmit them (iTerm2/Ghostty/kitty/WezTerm), but anything a user must be able to reach needs a plain key or a mouse click.

### Only the keybinding emitter can claim a key; DOM handlers always run second

[src/ink/components/App.tsx](src/ink/components/App.tsx) emits the `input` event to all `useInput`/`useKeybinding` listeners and only then calls `dispatchKeyboardEvent`, and the two paths carry different event objects. A DOM `onKeyDown` therefore cannot pre-empt a registered keybinding: `preventDefault()`/`stopPropagation()` on the `KeyboardEvent` can't undo an action the emitter already ran. Concretely, `CancelRequestHandler` ([src/hooks/useCancelRequest.ts](src/hooks/useCancelRequest.ts)) claims escape whenever a query is in flight, so a dialog cannot repurpose escape for an inner "leave this sub-region" step — it will cancel the request first. Layered escape semantics have to be built in the emitter layer (an overlay registration or a competing keybinding), not in `onKeyDown`.

### Click-to-focus is free; region focus is component state

[src/ink/hit-test.ts](src/ink/hit-test.ts) focuses the nearest ancestor with a numeric `tabIndex` before dispatching `onClick`, so a dialog gets click-to-focus without any focus plumbing. Adding `tabIndex` to inner panels is usually the wrong move: it changes Tab traversal (which dialogs often bind to something else) and exposes the reconciler's focus-restoration stack when panels re-render. Prefer keeping one focusable root and tracking which panel owns the arrow keys in component state, driven by `onClick`. Note that a click that drags becomes a text selection and never produces `onClick` at all.

### Sticky-scroll resume is baseline-driven, and the baseline must be cleared with the flag

Once `stickyScroll` is broken, the renderer's positional follow only resumes on an exact `scrollTop >= prevMaxScroll` ([src/ink/render-node-to-output.ts](src/ink/render-node-to-output.ts)), so a transcript that grew while the user was scrolled up leaves them permanently parked short of the bottom — newest output below the fold, blank rows above the prompt, no pill (they're past the unseen-divider baseline), until the next submit re-pins. `scrollFollowBaseline` (captured on the sticky→broken transition in [src/ink/components/ScrollBox.tsx](src/ink/components/ScrollBox.tsx)) is what makes scrolling back down resume following. Two consequences: every place that restores sticky must also clear the baseline (`scrollToBottom` and the renderer's follow), or it goes stale; and only downward scrolls may compare against `getFollowThreshold()` — an upward jump measured against a threshold below the current position would jump to the bottom instead.

### Injected context is rebuilt for display, never moved into the transcript

`showInjectedContext` renders `<system-reminder>` / `<task-notification>` content as collapsible rows. Reminder text mostly does not exist in the transcript — it is materialized from an `Attachment` by `normalizeAttachmentForAPI`, and the CLAUDE.md user-context block is built per-request by `prependUserContext` ([src/utils/contextInjection.ts](src/utils/contextInjection.ts)) and never stored. Both are reconstructed at render time in [src/components/Messages.tsx](src/components/Messages.tsx); the request path is deliberately untouched.

`isVirtual` is not the escape hatch it looks like: `normalizeMessagesForAPI` strips it, but `transformMessagesForExternalTranscript` ([src/utils/sessionStorage.ts](src/utils/sessionStorage.ts)) **promotes it back to a real message on persist**, so on `--resume` a display-only row would become the first API user message and break both the attribution fingerprint and the cached prefix. Keep display-only rows inside `Messages.tsx`'s render derivation, and keep `formatUserContextMessageContent` byte-identical to what `prependUserContext` sends. Two predicates must also agree or the unseen divider anchors to a row the transcript then skips: `shouldHideAttachmentInUI` in [src/components/messages/attachmentVisibility.ts](src/components/messages/attachmentVisibility.ts) is used by both `Messages.tsx` and `computeUnseenDivider`.

### Context attachments are appended per tool-loop iteration and retained forever

`getAttachmentMessages` runs inside the tool-use loop in [src/query.ts](src/query.ts), not once per user turn, and every attachment it yields is pushed onto the conversation permanently. An attachment whose predicate is a pure function of stable state therefore duplicates once per tool call for the rest of the session — a deleted `compaction_reminder` reached 13 identical copies inside a single turn, and because the copies count toward the token total, it accelerated the auto-compact it existed to reassure the model about. Standing policy belongs in the system prompt, where it sits in the cached prefix ([src/constants/prompts.ts](src/constants/prompts.ts) already states that context is unlimited through automatic summarization, twice). Reserve attachments for things that are news when they fire.

When an attachment should fire once per compaction window, derive the guard from the transcript rather than session state: `getAutoCompactImminentAttachment` ([src/utils/attachments.ts](src/utils/attachments.ts)) skips when a copy is already present, and compaction replaces the history holding it, so the next window re-arms with no reset hook. Note the ordering — run the cheap threshold check before the O(n) scan.

A throttle measured in "turns" must count human turns, never assistant messages. Streaming emits one `AssistantMessage` per content block ([src/services/api/claude.ts](src/services/api/claude.ts)), so a response with a text block plus three parallel tool calls advances an assistant-message counter by four, and the tool loop re-checks the threshold just as fast. `getPlanModeAttachmentTurnCount` counts non-meta, non-tool-result user messages for this reason; the deleted `task_reminder` counted assistant messages and fired several times per user turn. Also prefer a trigger that decays: its other gate was "turns since the last `TaskCreate`/`TaskUpdate`", which a session that never uses those tools satisfies forever.

### Reasoning preservation is per-provider opaque state, gated by one capability

Every provider round-trips reasoning differently and none of them accept another's data, so a reasoning block's continuation data lives under `providerState.<provider>` ([src/types/domain.ts](src/types/domain.ts)) and `stripForeignReasoningBlocks` ([src/utils/messages.ts](src/utils/messages.ts)) drops any block whose target provider can't verify it. Three things to keep in mind when touching this:

- The predicate table is keyed by `ProviderType`, and `vertex`/`foundry` deliberately alias to the `anthropic` entry because they share Anthropic's signed thinking blocks. A provider type missing from that table silently loses all reasoning — which is exactly how interleaved thinking was broken on Vertex and Foundry while the registry advertised `preservesReasoningAcrossTurns: true`. The capability is now the kill switch that gates the whole table, so it must stay wired to the call site in [src/services/api/claude.ts](src/services/api/claude.ts).
- `providerState` is on text and tool_use blocks too, not just reasoning ones, because Gemini's `thoughtSignature` is metadata on a whole Part and rides on whichever part produced it. Never move a signature between blocks or merge signed with unsigned blocks.
- Signed reasoning must be replayed verbatim and in its original position. Bedrock rejects an assistant turn whose signed blocks were edited or reordered, and removing an intervening `toolUse` so two reasoning blocks become adjacent is enough to trigger it.

### Bedrock Converse hides Anthropic parameters in additionalModelRequestFields

Converse normalizes away everything Anthropic-specific, so `thinking`, `output_config`, and `anthropic_beta` all go inside `additionalModelRequestFields` using Anthropic's snake_case names (`budget_tokens`, not `budgetTokens`) while real Converse fields like `inferenceConfig.maxTokens` stay camelCase. Betas reach it through the `betasInBody` capability, which is what restricts them to the identifiers Converse documents — sending the header-only betas (`claude-code-*`, `prompt-caching-scope-*`) would 400. Two stream-shape gotchas: `ContentBlockStart` only ever carries a `toolUse` member, so text and reasoning blocks must be opened from their first delta rather than from the start event; and a reasoning signature is not promised to arrive in one delta, so fragments have to accumulate (and base64 `redactedContent` fragments must be decoded before concatenating, never string-joined).

### Chat-completions reasoning: four wire conventions, detected not configured

OpenAI-compatible endpoints disagree on the field name — `reasoning_content` (DeepSeek, xAI, Qwen, Kimi, GLM, Fireworks, llama-server), `reasoning` (Groq, Together, vLLM), OpenRouter's lossless `reasoning_details[]`, or nothing at all (OpenAI's own endpoint, which has no replayable reasoning item; that needs the Responses API). The adapter records whichever field a response used on the block's `providerState` and echoes back into that same one, so a block with no recorded field is never guessed at. Replay is genuinely required in some tool loops (DeepSeek V4 returns 400 without it) and merely ignored in others (vLLM deferred input support; most Jinja templates strip prior thinking), which is why the default is to echo and `preservesReasoningAcrossTurns: false` is the opt-out for endpoints that reject unknown assistant-message fields.
