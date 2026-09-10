# CLAUDE.md

Architecture, build, configuration and testing live in [docs/](docs/).
Only knowledge the code cannot state belongs below: external API behavior,
hidden couplings, silent failures, and deliberate decisions.

## Providers

- Provider type does not imply auth method: Bedrock and Gemini acquire credentials themselves. Keep Anthropic-only metadata, identity headers and signing behind the Anthropic-type gate; unrelated OpenAI-compatible providers may reject them or lose cache reuse.
- Bedrock rejects an assistant turn whose signed blocks were edited or reordered; removing an intervening `toolUse` is enough. Bedrock Converse rejects header-only `claude-code-*` betas — only documented Converse beta identifiers may travel in the body.
- DeepSeek V4 requires the exact reasoning field returned by a response to be echoed back. Other OpenAI-compatible endpoints may ignore or reject unknown reasoning fields, so never guess one.
- Reasoning continuation data is provider-specific and not portable. A `ProviderType` missing from the predicate table loses all reasoning silently; `vertex` and `foundry` intentionally alias `anthropic`.
- A `stream_event` leaving [src/services/api/claude.ts](src/services/api/claude.ts) carries domain types: extended thinking is `reasoning`, not `thinking`. Use [src/types/domainGuards.ts](src/types/domainGuards.ts); raw `content_block` comparisons typecheck and silently never match.

## System prompt and cache prefix

- The prefix order is `tools`, then `system`, then `messages`. Keep the static system prompt byte-identical across sessions; session facts belong in the persisted `user_context_snapshot` and subsequent deltas.
- Tool-derived variation is free because a tool change already invalidates everything after the tools block. Global cache scope was dropped deliberately; do not reintroduce it.
- Everything inside the cached prefix must be byte-stable across sessions: output-style bodies (no `${CLAUDE_PLUGIN_ROOT}` substitution, no source path beside the style name), tool descriptions, and the config-home-specific tool-catalog manifest path — route it through the env-context attachment.

## Context attachments

- `getAttachmentMessages` runs per tool-loop iteration, and yielded attachments remain in the conversation. A stable predicate duplicates content on every tool call and accelerates compaction; standing policy belongs in the cached prefix instead.
- A once-per-window guard must inspect the transcript. Compaction replaces history and re-arms the guard without a reset hook.
- Do not count `AssistantMessage` objects as turns: streaming emits one per content block. Count human turns or responses keyed by `message.id`.
- Session logging drops attachments unless `isLoggableMessage` explicitly allows their type. Any new attachment that must survive resume needs an allowlist entry, or it is silently lost.
- `shouldHideAttachmentInUI` and the unseen-divider filter in [src/components/FullscreenLayout.tsx](src/components/FullscreenLayout.tsx) must agree, or the divider anchors to a row the transcript skips.

## Subagents and sessions

- `TasksV2Store` must use the main task-list ID. Timers inherit a subagent's `AsyncLocalStorage` scope, so the ambient ID can point at another agent's directory.
- Parent UI callbacks are intentionally removed from subagent context. UI-visible output must be routed through retained `LocalAgentTaskState`, or drill-down transcripts render empty.
- A session ID is not exclusive. Two live processes can interleave writes into one transcript and share `~/.freecode/tasks/<sessionId>/`.
- Live-holder checks fail open intentionally when a PID cannot be probed. Every session-adoption path needs the ownership check; protecting one resume path protects none of the others.
- `gracefulShutdownSync` only schedules exit. Throw `ResumeCancelledError` afterward, or the process can adopt a session it just refused.
- Mid-session transfer uses `ownership_fork`, not `fork`; the latter skips cross-session reconstruction. Forks do not write transcripts themselves, so preserve the first-message UUID change that triggers re-recording.

## Config and hooks

- Disabling all hooks must gate settings-, plugin- and session-derived hooks separately; missing one channel silently re-enables it, including in worktree-hook detection.
- Every hook execution path must independently re-check workspace trust. A new path without that gate is a silent security bypass.
- An absent `statusLine` runs the embedded default script ([src/statusline/default-statusline.sh](src/statusline/default-statusline.sh), inlined at build and materialized to a PID-scoped tmp file); it skips the trust gate because its content ships in the binary. Only `statusLine: {"type":"off"}` hides the statusline.

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

## Edit and Read anchors

Label format and resolution contract: commented in [src/utils/hashline.ts](src/utils/hashline.ts). Response-local edit poisoning: commented in [src/utils/editState.ts](src/utils/editState.ts).

- Crossed anchor pairs (right hash, wrong line) are the dominant model error once format is handled: models reconstruct pairs from memory instead of looking them up. Error payloads that quote the fresh anchors recover in one retry; keep them.
- Read entries always store an explicit `offset` (whole-file reads: offset 1), so whole-file checks (Read dedup) must accept offset <= 1 with no limit.

## WebUI

- A process socket is identified by PID plus nonce, never session ID. Attach only when registry and descriptor agree on both PID and session ID; descriptor rewrites are asynchronous, and accepting an early or stale descriptor can attach to the wrong session.
- `sessionSwitched` also fires for `/clear`; subscribers must not assume it means resume.
- A live transcript comes wholly through its socket. Never splice a disk snapshot to a socket tail; queued writes, mutable assistant messages, DAG branches and UI reordering make the merge lossy.
- "Interrupt and send" is one priority enqueue, not cancel then submit. In headless mode every non-stdin producer must call `run()` after `enqueue()` or the turn never starts.
- A browser permission disconnect must not deny by omission: keep the terminal dialog answerable while the broker retains the request.
- Gateway children require a configured config home with provider settings, trust and API-key approval. A source rebuild does not update a running gateway; restart it, preserving the tunnel hostname when needed.
- Browser resume must wait for the requested session's descriptor and use the recorded working directory. Do not pass `--fork-session`, which leaves a duplicate history row.
- The client follows sessions across processes. Exclude known-dead process keys despite the polling lag, and call gateway `detach()` rather than merely clearing React state, or reconnect can strand the view on an empty dead process.
- The browser client keeps all imports from schema and gateway modules type-only, or zod and Node modules leak into the bundle. CSP permits self/data images, not blob URLs. Off-screen panels stay focusable and hit-testable unless they also get `visibility: hidden` or zero height, and mobile controls must remain at least 16px against iOS Safari focus zoom.
- `AskUserQuestion` and `ExitPlanMode` require enriched `updatedInput`; a bare allow silently submits empty answers. Exit-plan approval must also drop `plan`, or it falsely reports a user edit.
- Permission-mode changes must be sent before allow on the same socket so the mode lands before tool execution. Browser `persist` is deliberately session-scoped; do not turn an internet-facing approval into the terminal's durable on-disk rule.

## Bash permissions

- There is one security parser and no fallback. `too-complex` must prompt; `shell-quote` is only for display, completion and quoting because its undetectable misparses can create bypasses.
- Security decisions must resolve wrappers through [src/utils/bash/wrappers.ts](src/utils/bash/wrappers.ts), which fails closed on unknown flags. The regex stripper in `bashPermissions.ts` may widen rule matching but must never decide.
- `sourceText` excludes redirects, so checking it alone misses writes such as `> /tmp/evil`.
- `BashTool.isReadOnly` is a positive auto-approval consumed by memory extraction and prompt speculation; false positives execute without a prompt.
