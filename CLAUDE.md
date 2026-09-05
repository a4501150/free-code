# CLAUDE.md

Only what code cannot reveal belongs here: hidden couplings, external behavior, silent failures, and deliberate decisions.
Build, configuration, testing and layout live in [docs/](docs/).

## Build and test

- E2E tests run the compiled `./cli-dev`. Rebuild with `bun run build:dev:full` after every source edit, or they pass against stale code.
- Unit files share one process, and `mock.module` is global and permanent for it. [tests/unit/autoCompactThreshold.test.ts](tests/unit/autoCompactThreshold.test.ts) stubs `getInitialSettings`, so a later file that writes `freecode.json` reads the stub and fails only in the suite. Gate such a test on an env var the code reads before settings. Module-level `memoize` leaks the same way.
- Read the mock server's request log for bodies, ordering and tool results. Capture the tmux pane only for rendered output, because ANSI contaminates anything parsed from it.
- `TmuxSession` disables prompt suggestions, whose hidden calls would consume mock responses. A test that re-enables them must queue the extra requests.
- Reset a mock server only after the previous turn is idle.

## Providers

- Provider type does not imply auth method: Bedrock and Gemini acquire credentials themselves. Keep Anthropic-only metadata, identity headers and signing behind the Anthropic-type gate; unrelated OpenAI-compatible providers may reject them or lose cache reuse.

### External API behavior

- Anthropic-wire APIs allow four cache breakpoints and hard-400 on a fifth.
- Bedrock rejects an assistant turn whose signed blocks were edited or reordered; removing an intervening `toolUse` is enough.
- Bedrock Converse rejects header-only `claude-code-*` betas. Only documented Converse beta identifiers may travel in the body.
- DeepSeek V4 requires the exact reasoning field returned by a response to be echoed back. Other OpenAI-compatible endpoints may ignore or reject unknown reasoning fields, so never guess one.

### Reasoning

- Reasoning continuation data is provider-specific and not portable. A `ProviderType` missing from the predicate table loses all reasoning silently; `vertex` and `foundry` intentionally alias `anthropic`.
- Gemini signs a whole Part, so signatures can ride on text and tool-use blocks. Never move a signature between blocks.

### Stream events

- A `stream_event` leaving [src/services/api/claude.ts](src/services/api/claude.ts) carries domain types: extended thinking is `reasoning`, not `thinking`. The widened `content_block` type lets the wrong comparison typecheck and silently never match; use [src/types/domainGuards.ts](src/types/domainGuards.ts).

## System prompt and cache prefix

- The prefix order is `tools`, then `system`, then `messages`. Keep the static system prompt byte-identical across sessions; session facts belong in the persisted `user_context_snapshot` and subsequent deltas.
- Tool-derived variation is free because a tool change already invalidates everything after the tools block. Do not reintroduce global cache scope; this fork lacks the scale and byte-identical preambles needed to benefit.
- Output-style bodies in the cached prefix must remain byte-stable; do not substitute `${CLAUDE_PLUGIN_ROOT}` or render a source path beside the style name.

## Context attachments

- `getAttachmentMessages` runs per tool-loop iteration, and yielded attachments remain in the conversation. A stable predicate duplicates content on every tool call and accelerates compaction; standing policy belongs in the cached prefix instead.
- A once-per-window guard must inspect the transcript. Compaction replaces history and re-arms the guard without a reset hook.
- Do not count `AssistantMessage` objects as turns: streaming emits one per content block. Count human turns or responses keyed by `message.id`.
- Session logging drops attachments unless `isLoggableMessage` explicitly allows their type. Any new attachment that must survive resume needs an allowlist entry, or it is silently lost.

## Injected context in the UI

- `shouldHideAttachmentInUI` and the unseen-divider filter in [src/components/FullscreenLayout.tsx](src/components/FullscreenLayout.tsx) must agree, or the divider anchors to a row the transcript skips.

## Subagents

- `TasksV2Store` must use the main task-list ID. Timers inherit a subagent's `AsyncLocalStorage` scope, so the ambient ID can point at another agent's directory.
- Parent UI callbacks are intentionally removed from subagent context. Any UI-visible output must be routed through retained `LocalAgentTaskState`; otherwise drill-down transcripts render empty.
- Sidechains reuse leader message UUIDs. Keep `Messages` keyed by the viewed agent transcript, or React keys and the height cache collide; local agents are excluded by teammate-only guards.

## Sessions and resume

- A session ID is not exclusive. Two live processes can interleave writes into one transcript and share `~/.freecode/tasks/<sessionId>/`.
- Live-holder checks fail open intentionally when a PID cannot be probed. Every session-adoption path needs the ownership check; protecting one resume path protects none of the others.
- `gracefulShutdownSync` only schedules exit. Throw `ResumeCancelledError` afterward, or the process can adopt a session it just refused.
- Mid-session transfer uses `ownership_fork`, not `fork`; the latter skips cross-session reconstruction. Forks do not write transcripts themselves, so preserve the first-message UUID change that triggers re-recording.

## Config and hooks

- `modelSettings.json` merges after `freecode.json`. Keep its raw-key filter before validation, or an unrelated key can silently override or invalidate provider configuration.
- Disabling all hooks must gate settings-, plugin- and session-derived hooks separately; missing one channel silently re-enables it, including in worktree-hook detection.
- Every hook execution path must independently re-check workspace trust. A new path without that gate is a silent security bypass.

## Terminal UI

- A ScrollBox child cannot derive height from its parent: percentage height or empty stretch collapses to `minHeight` after culling and re-entry. Give dividers real content or use a neighbor border.
- REPL scroll bindings register before modals and own wheel, PgUp/PgDn and ctrl+home/end. Modals must publish `ModalContext.scrollRef`; `useInput` cannot claim those keys.
- Re-pin after a `conversationId` change or an async intermediate empty range, and clear `scrollFollowBaseline` when restoring sticky scroll. Do not key another re-pin on message count because streaming also changes it.
- Apply the follow threshold only on downward scrolls. The rendered list is not append-only: tool results reorder, and collapsed or streaming rows are replaced in place.
- Apple Terminal strips shift from arrow keys and splits option+up into escape then up. Never require modified arrows.
- Keybinding emitters run before DOM `onKeyDown`; layered escape behavior must live in the emitter layer because request cancellation can claim escape first.
- Tool results are validated against `outputSchema` before rendering. A schema narrower than `call()` output silently removes the row; MCP output must admit content arrays as well as strings.

## Tool arguments

- Strict schemas make models send `null` for omitted optionals. Strip only placeholder nulls, never a null the schema admits, and use `tool.inputJSONSchema ?? tool.inputSchema`; a Zod passthrough hides MCP arguments.

## Edit anchors

- Anchors resolve by content, not position, and remain reusable after earlier edits to the file.
- HASH fingerprints the line plus its two neighbors; Read widens to ±2 ("2"-prefixed label) when a window repeats. The cap is deliberate: it bounds how far rewriting one line invalidates held anchors (its two neighbors'), and fully duplicated windows must fail as ambiguous rather than guess. Do not widen `HASH_LEN` either: measured duplicate-line rates are 38.5% at three characters, so failures come from duplicate text, not collisions; the sibling-shift rule still resolves ambiguous range endings.
- A stale anchor whose every window twin moved alike lands exactly where the anchor claimed and nothing flags it. Only edits that change a window's contents (vs. shifting it) are detectable as drift.
- Success results re-quote anchors for changed hunks widened ±2 because the rewritten lines' neighbors have new hashes. A stale neighbor anchor after a nearby edit is expected, not a bug. Read slices get edge context via readFileInRange's prevLines/nextLines; a slice read without them would show edge labels that mismatch the engine.

## WebUI

- A process socket is identified by PID plus nonce, never session ID: session IDs can change or have multiple holders, while PIDs can be recycled.
- Attach only when registry and descriptor agree on both PID and session ID. Descriptor rewrites are asynchronous, and accepting an early or stale descriptor can attach to the wrong session or return success for a child that exits.
- `sessionSwitched` also fires for `/clear`; subscribers must not assume it means resume.
- A live transcript comes wholly through its socket. Never splice a disk snapshot to a socket tail; queued writes, mutable assistant messages, DAG branches and UI reordering make the merge lossy.
- "Interrupt and send" is one priority enqueue, not cancel then submit. In headless mode every non-stdin producer must call `run()` after `enqueue()` or the turn never starts.
- A browser permission disconnect must not deny by omission. Keep the terminal dialog answerable while the broker retains the request.
- Gateway children require a configured config home with provider settings, trust and API-key approval. A source rebuild does not update a running gateway; restart it, preserving the tunnel hostname when needed.
- Browser resume must wait for the requested session's descriptor and use the recorded working directory. Do not pass `--fork-session`, which leaves a duplicate history row.

### Browser client

- An off-screen panel remains focusable and hit-testable unless it also gets `visibility: hidden` or zero height.
- Mobile controls must remain at least 16px to prevent persistent iOS Safari focus zoom; Chromium's 500px minimum cannot validate a 390px layout.
- Keep all client imports from schema and gateway modules type-only. Pulling values brings zod or Node modules into the browser bundle and can break it.
- CSP permits self/data images, not blob URLs. Set generated image data URLs directly on `img`.
- The client follows sessions across processes. Exclude known-dead process keys despite the polling lag, and call gateway `detach()` rather than merely clearing React state, or reconnect can strand the view on an empty dead process.

### Interactive tools in the browser

- `AskUserQuestion` and `ExitPlanMode` require enriched `updatedInput`; a bare allow silently submits empty answers. Exit-plan approval must also drop `plan`, or it falsely reports a user edit.
- Permission-mode changes must be sent before allow on the same socket so the mode lands before tool execution.
- Browser `persist` is deliberately session-scoped. Do not turn an internet-facing approval into the terminal's durable on-disk rule.

## Bash permissions

- There is one security parser and no fallback. `too-complex` must prompt; `shell-quote` is only for display, completion and quoting because its undetectable misparses can create bypasses.
- Security decisions must resolve wrappers through [src/utils/bash/wrappers.ts](src/utils/bash/wrappers.ts), which fails closed on unknown flags. The regex stripper in `bashPermissions.ts` may widen rule matching but must never decide.
- `sourceText` excludes redirects, so checking it alone misses writes such as `> /tmp/evil`.
- `BashTool.isReadOnly` is a positive auto-approval consumed by memory extraction and prompt speculation; false positives execute without a prompt.
