# CLAUDE.md

Only knowledge the code cannot state belongs below: external API behavior,
hidden couplings, silent failures, and deliberate decisions. Do not add
architecture tours, tool inventories, or facts a file grep recovers — they go
stale and they mislead. A pointer to a file beats restating what the file says.

## Daily commands and build traps

- `bun run build` writes `./cli`; `bun run build:dev:full` writes `./cli-dev` (the dev-full flag set — `WEBUI` among them). The `--compile` flag name is misleading: every build calls `bun build --compile`, the flag only moves output into `dist/`. See [scripts/build.ts](scripts/build.ts); [FEATURES.md](FEATURES.md) is the only authority on what each flag does.
- A feature name passed to the build is not validated: a typo becomes a dead flag, and unknown args are ignored without a message. `dev-full` is the only named feature set.
- `bun run dev` runs `src/entrypoints/cli.tsx` with NONE of the build's default feature defines — flag-gated behavior differs from every built binary. Build to test anything a flag gates.
- The binary is not self-contained: the build copies `vendor/ripgrep/` and `vendor/search-tools/` sidecars beside it, and they must move with it. A system `rg` is preferred at runtime unless `USE_BUILTIN_RIPGREP=1`.
- `src/webui/generated/assets.ts` is git-ignored; the build writes an empty stub when `WEBUI` is off so a fresh clone still compiles. Never commit the generated copy.
- `bun run test` neither typechecks nor formats. Run `bun run typecheck`, `bun run test:unit` and `bun run format` (prettier) yourself; keep fmt clean.
- e2e drives the COMPILED binary in tmux, not `src/`: run `bun run build:dev:full` first (default target `./cli-dev`; a stale build passes tests against old code). Each test runs `env -i` with a temporary HOME/config — no real credential or setting reaches a test. Read assertions from the mock provider's request log, not the tmux pane (ANSI contaminates it), and reset a mock only after the previous turn goes idle.
- Unit tests share one process: `mock.module` is global and permanent, so a stub of `getInitialSettings` (or module-level `memoize`) in one file leaks into every later file. Passes alone, fails in the suite.

## Where to look

| Area                                    | Entry                                                                                                                                                                                                 |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Process entry, flags, startup order     | [src/entrypoints/cli.tsx](src/entrypoints/cli.tsx) → [src/main.tsx](src/main.tsx) — the first imports (startup profile mark, keychain prefetch) are side effects that must stay first; do not reorder |
| Agent loop                              | [src/query.ts](src/query.ts), [src/QueryEngine.ts](src/QueryEngine.ts)                                                                                                                                |
| Tool registry / slash-command registry  | [src/tools.ts](src/tools.ts), [src/commands.ts](src/commands.ts)                                                                                                                                      |
| Wire adapters (one per provider format) | [src/services/api/adapters/](src/services/api/adapters/)                                                                                                                                              |
| Provider-neutral domain types           | [src/types/domain.ts](src/types/domain.ts)                                                                                                                                                            |
| Settings schema and the two-file split  | [src/utils/settings/](src/utils/settings/)                                                                                                                                                            |
| Edit placement, seen ledger, sightings  | [src/utils/editApproval.ts](src/utils/editApproval.ts), [src/utils/editMatch.ts](src/utils/editMatch.ts), [src/utils/fileSightings.ts](src/utils/fileSightings.ts)                                    |
| Tool permission decision                | [src/utils/permissions/permissions.ts](src/utils/permissions/permissions.ts)                                                                                                                          |
| Terminal renderer                       | [src/ink/](src/ink/) — NOT the npm `ink` package; it is the local `react-reconciler` implementation reached through [src/ink.ts](src/ink.ts). Change the tree, not the (declared, unused) dependency  |
| Native-module replacements              | [src/native-ts/](src/native-ts/) — Yoga-compatible layout, fuzzy index, color diff, all TypeScript, no native build step                                                                              |
| Browser session UI                      | `src/webui/`: `attach/` per-process socket, `gateway/` HTTP inside the daemon, `client/` React app, `protocol/` shared schemas, `tunnel/` public-URL providers                                        |
| Import-cycle breakers                   | [src/schemas/](src/schemas/) — shared Zod schemas live here precisely because importing them from elsewhere cycles                                                                                    |

## Configuration

- Config home is `~/.freecode` (`FREECODE_CONFIG_DIR` overrides, `CLAUDE_CONFIG_DIR` accepted as fallback). Provider and model-routing keys live ONLY in `modelSettings.json` — the exact key list is [src/utils/settings/modelSettingsKeys.ts](src/utils/settings/modelSettingsKeys.ts); a key outside it is dropped before validation, so one bad key cannot take the provider config down. Everything else belongs in `freecode.json`.
- Disabling all hooks must gate settings-, plugin- and session-derived hooks separately; missing one channel silently re-enables it, including in worktree-hook detection.
- Every hook execution path must independently re-check workspace trust. A new path without that gate is a silent security bypass.
- An absent `statusLine` runs the embedded default script ([src/statusline/default-statusline.sh](src/statusline/default-statusline.sh), inlined at build and materialized to a PID-scoped tmp file); it skips the trust gate because its content ships in the binary. Only `statusLine: {"type":"off"}` hides the statusline.

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
- Subagents have full edit permission: `subagentAutoApproveEdits` on their permission context auto-allows Edit/Write `ask` decisions (deny rules, allow rules, plan mode and safety-check asks still win). A subagent permission prompt has no reliably available human, so edits must not wait for one.
- Subagents without a prompt UI also set `subagentAutoApproveAsks`: a hook-unobjected `ask` with no rule, plan-mode, safety-check or user-interaction objection auto-approves on the inherited rules. Deliberately fail-open for subagents only — other headless contexts (SDK print) keep fail-closed auto-reject because they don't set the flag.
- Tool capability gating runs against the main-loop model when the parent assembles its pool; `runAgent` re-checks `isEnabled()` under `runWithMainLoopModelScope(agentModel)`, and that filter must stay inside the scope or capability-gated tools (WebSearch) leak to agents whose model can't serve them. The inverse gap — a capability the agent model has but the main model lacks — keeps the tool absent intentionally.
- MCP server instructions are appended to the agent system prompt after agent-specific servers initialize, scoped to tools the agent exposes. The instructions-delta attachment only reaches the main transcript, so it must not gate this section.
- A session ID is not exclusive. Two live processes can interleave writes into one transcript and share `~/.freecode/tasks/<sessionId>/`.
- Live-holder checks fail open intentionally when a PID cannot be probed. Every session-adoption path needs the ownership check; protecting one resume path protects none of the others.
- `gracefulShutdownSync` only schedules exit. Throw `ResumeCancelledError` afterward, or the process can adopt a session it just refused.
- Mid-session transfer uses `ownership_fork`, not `fork`; the latter skips cross-session reconstruction. Forks do not write transcripts themselves, so preserve the first-message UUID change that triggers re-recording.

## Terminal UI

- The `<tool_use_error>` body is the single source of truth for a failed tool call, for the model and the terminal alike. Tool `UI.tsx` error renderers must pass it to `FallbackToolUseErrorMessage` verbatim (tag-stripped); substituting static per-case strings (or collapsing `InputValidationError` to a generic line) re-introduces a second story that diverges from what the model was told.
- A ScrollBox child cannot derive height from its parent: percentage height or empty stretch collapses to `minHeight` after culling and re-entry. Give dividers real content or use a neighbor border.
- REPL scroll bindings register before modals and own wheel, PgUp/PgDn and ctrl+home/end. Modals must publish `ModalContext.scrollRef`; `useInput` cannot claim those keys.
- Re-pin after a `conversationId` change or an async intermediate empty range, and clear `scrollFollowBaseline` when restoring sticky scroll. Do not key another re-pin on message count because streaming also changes it.
- Apply the follow threshold only on downward scrolls. The rendered list is not append-only: tool results reorder, and collapsed or streaming rows are replaced in place.
- Apple Terminal strips shift from arrow keys and splits option+up into escape then up. Never require modified arrows.
- Keybinding emitters run before DOM `onKeyDown`; layered escape behavior must live in the emitter layer because request cancellation can claim escape first.
- Tool results are validated against `outputSchema` before rendering. A schema narrower than `call()` output silently removes the row; MCP output must admit content arrays as well as strings.

## Tool arguments

- Strict schemas make models send `null` for omitted optionals. Strip only placeholder nulls, never a null the schema admits, and use `tool.inputJSONSchema ?? tool.inputSchema`; a Zod passthrough hides MCP arguments. Stripping must keep running against the Zod schema for built-ins — the presented (strict-shaped) schema marks those nulls as admitted.
- OpenAI-compatible adapters present every tool schema strict-shaped without setting `strict`: all properties required and nullable, `additionalProperties: false`, draft keywords stripped ([src/services/api/adapters/strictPresentedSchema.ts](src/services/api/adapters/strictPresentedSchema.ts)). Strict-enforcing servers otherwise reject or silently drop tools whose optionals sit outside `required`; schemas with `$ref` are presented unmodified.

## Edit placement and the seen ledger

Approval predicate and freshness contract: commented in [src/utils/editApproval.ts](src/utils/editApproval.ts). Placement resolution (quote/escape/prefix repairs, whitespace-tolerant whole-line pass, content-only disambiguation): [src/utils/editMatch.ts](src/utils/editMatch.ts).

- Approval is content logic, never timestamps: an edit lands when it verifies against current disk bytes and its placement is inside what the model was shown. `timestamp` is a re-validation hint only — touch with unchanged content must approve, and a formatter rewrite must still approve (recovered note) when the match sits inside the seen region.
- Every ledger entry stores the WHOLE current file bytes (BOM-stripped; slice entries for oversized files record `contentFirstLine` so seen-line math stays file-absolute). A ranged Read that stored only its slice made every later edit a failed recovery and replace_all impossible. Sightings merge into an existing entry (union of seen ranges on identical bytes) instead of overwriting it.
- Ledger bytes must match the bytes approvals compare: Edit/Write pass `stripBom` of the current file to approve\*; write-back keeps the BOM.
- Resume rebuilds Read/Write/Edit sightings only ([src/utils/queryHelpers.ts](src/utils/queryHelpers.ts)), marked `contentVerified: false`: unverified entries approve only unique-match placements and never license a Write. Grep/Bash sightings are lost and the unique-match escape absorbs the gap.
- Edit has no line-range parameters: ambiguity is resolved by extending `old_string`, and the error must quote the candidate line numbers so one retry suffices. Repair ladder beyond exact: curly quotes, \uXXXX escapes, pasted-row prefixes, then a whole-line trim() pass for multi-line copies (single-line copies already match as substrings).
- Scratchpad files are exempt from both layers: the write permission matches ANY `<projectTemp>/<uuid>/scratchpad` (session IDs drift across /clear, resume, gateway children), and approveEdit/approveWrite skip the ledger there.
- The Edit tool description is the only place that tells the model Grep content mode and cat/head/nl/sed -n/grep -n/rg -n count as seen (partially) — keep it in sync with the fileSightings allowlist.
- Same-response Edits of one file serialize on the per-file lock in [src/utils/fileLock.ts](src/utils/fileLock.ts): re-plan and re-approve inside the lock, and keep async I/O out of the lock body or atomicity breaks.
- The approvalNote disclosure rides the success message (fresh / recovered / blind-placement / blind); never drop it — it tells the model when the file holds changes outside its context.
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
- Security decisions must resolve wrappers through [src/utils/bash/wrappers.ts](src/utils/bash/wrappers.ts), which fails closed on unknown flags. The regex stripper in [src/tools/BashTool/bashPermissions.ts](src/tools/BashTool/bashPermissions.ts) may widen rule matching but must never decide.
- `sourceText` excludes redirects, so checking it alone misses writes such as `> /tmp/evil`.
- `BashTool.isReadOnly` is a positive auto-approval consumed by memory extraction and prompt speculation; false positives execute without a prompt.
