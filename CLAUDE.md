# CLAUDE.md

Only things that the code cannot tell you: hidden couplings, external system
behavior, silent failures, and deliberate decisions. If reading the relevant
file answers it, it does not belong here.

## Build and test

- E2E tests run `./cli-dev`. Rebuild with `bun run build:dev:full` after every source edit, or the tests pass against stale code.
- Do not put React Compiler output in source. The checked-in `.tsx` files are the clean pre-compilation source.
- Unit test files share one process, and `mock.module` is global and permanent for it. [tests/unit/autoCompactThreshold.test.ts](tests/unit/autoCompactThreshold.test.ts) stubs `getInitialSettings`, so a later file that writes `freecode.json` reads the stub instead. Such a test passes alone and fails in the suite. Gate it on an env var that the code reads before settings. Module-level `memoize` leaks across files the same way.
- Read the mock server request log. Do not scrape the tmux pane, because ANSI output contaminates the text.
- `TmuxSession` disables prompt suggestions, because hidden suggestion calls consume mock responses. A test that enables them must account for the extra requests.
- Reset a mock server only after the previous turn is idle.

## Providers

- A provider type does not imply an auth method. Bedrock and Gemini acquire credentials themselves, which is why no single boundary owns auth.
- Gate Anthropic-platform body metadata and headers to Anthropic-type providers. Elsewhere they churn the cache key for no benefit.

### Anthropic first-party requests

Three server-side requirements that no local code states:

- A request without `metadata.user_id` gets a 429.
- The 1P API rejects a non-Haiku request without the `CLISyspromptPrefix` block.
- The attribution block's `cch` field hashes the whole body, so it changes on every request. A cache breakpoint there can never hit.

### Reasoning

- Reasoning continuation data is provider-specific and not portable. A `ProviderType` missing from the predicate table loses all reasoning in silence. `vertex` and `foundry` alias the `anthropic` entry.
- Gemini signs a whole Part, so a signature rides on text and tool_use blocks too. Never move one between blocks.
- Bedrock rejects an assistant turn whose signed blocks were edited or reordered. Removal of an intervening `toolUse` is enough to trigger it.
- OpenAI-compatible endpoints disagree on the reasoning field name, and some reject an unknown one. The adapter records the field that a response used and echoes into that same field. Never guess it. DeepSeek V4 returns 400 without the replay, and other endpoints ignore it.

### Bedrock Converse

- The header-only `claude-code-*` betas return 400. Only the identifiers that Converse documents can travel in the body.
- `ContentBlockStart` carries only a `toolUse` member. Open text and reasoning blocks from the first delta instead.
- A reasoning signature can arrive in several deltas. Accumulate the fragments, and decode base64 `redactedContent` before you join it.

### Stream events

A `stream_event` that leaves [src/services/api/claude.ts](src/services/api/claude.ts)
carries domain types, so extended thinking is `reasoning`, never `thinking`.
`DomainStreamEvent.content_block` widens to `{ type: string }`, so a comparison
against a wire type typechecks and silently never matches. Use
[src/types/domainGuards.ts](src/types/domainGuards.ts).

## System prompt and cache prefix

The prefix order is `tools`, then `system`, then `messages`.

- Keep the system prompt byte-identical across sessions and projects. That is what lets a fresh session in a new directory read the prefix instead of writing it. Session facts (cwd, model, git status, scratchpad path) belong in the prepended user-context message, and [tests/unit/staticSystemPrompt.test.ts](tests/unit/staticSystemPrompt.test.ts) guards the rule.
- Tool-derived variation in the system prompt is free, because a change to the tools block already invalidates everything after it.
- The memory prompt names directories but must not interpolate paths, which would cost a per-project prefix. Agent memory is the exception, because a subagent has no environment block.
- The API allows four breakpoints and returns a hard 400 on a fifth. Three are in use, at three different change frequencies. Keep the fourth as headroom.
- The tail marker belongs on the last element of `filteredTools`, because server tools are appended later. On an assistant message it walks back to the last non-reasoning block.
- Do not spend the free breakpoint on the 20-block cache lookback. Real tool loops exceed it on 0.014% of turns, and such a miss costs one extra cache write that the next turn repairs.
- Do not reintroduce global cache scope. It was removed on purpose, because the shared entry only pays off for byte-identical preambles at a scale this fork does not have.
- The attribution fingerprint depends on the first API user message. Do not add per-turn content ahead of it. Do not reshape the user-context prepend. Do not drop its module-level memoization. Clear its caches only at compact, clear, or a prompt injection change.

### Output styles

- A style body must stay byte-stable, because the default style sits in the cached prefix. Never substitute `${CLAUDE_PLUGIN_ROOT}`, and never render a source path beside the name.
- The active style is a module latch, resolved once per process, so a live conversation's prefix never moves under it. Only `/clear` resets it. A synchronous caller must use `getActiveOutputStyleNameSync`.

## Context attachments

- `getAttachmentMessages` runs per tool-loop iteration, not per user turn, and every attachment that it yields stays in the conversation forever. An attachment with a stable predicate duplicates on every tool call and accelerates the compaction that it warns about.
- Put standing policy in the cached prefix instead. Guidance about one tool belongs in that tool's own description. Only cross-cutting policy belongs in [src/constants/prompts.ts](src/constants/prompts.ts). Reserve an attachment for news.
- For a once-per-window guard, test the transcript, not session state. Compaction replaces the history and re-arms the guard with no reset hook.
- Never count `AssistantMessage` objects as turns. Streaming emits one per content block, so one response with three parallel tool calls advances such a counter by four. Count human turns, or count responses keyed by `message.id`.
- Prefer a trigger that decays. A gate that a session satisfies forever fires forever.

## Injected context in the UI

- Reminder text and the CLAUDE.md user-context block do not exist in the transcript. [src/components/Messages.tsx](src/components/Messages.tsx) rebuilds both at render time. Leave the request path alone.
- `isVirtual` is not an escape hatch. `transformMessagesForExternalTranscript` promotes such a row to a real message on persist, so on resume it becomes the first API user message and breaks the fingerprint.
- Keep `formatUserContextMessageContent` byte-identical to what `prependUserContext` sends.
- `shouldHideAttachmentInUI` and `computeUnseenDivider` must agree, or the divider anchors to a row that the transcript then skips.

## Subagents

- `TasksV2Store` must call `getMainTaskListId()`. `setTimeout` inherits the subagent `AsyncLocalStorage` scope, so `getTaskListId()` reads another agent's directory.
- `createSubagentContext` nulls every parent UI callback. Route anything that the UI must show onto `LocalAgentTaskState` through an explicit `runAgent` callback.
- Every `runAgent` consumer must call `appendRetainedAgentMessage`, or that drill-down transcript renders empty. There are three loops.
- The live Agent card is `AgentProgressLine` through `GroupedAgentToolUseView`. `renderToolUseProgressMessage` serves only the non-grouped and slash-command paths, so a change to one alone looks like no change at all.

The drill-down swaps data. It does not mount a screen, so ScrollBox, `Messages`
and `useVirtualScroll` all stay alive and `conversationId` does not change.
Three consequences, none of them visible at the call site:

- Guard every prop scoped to "whose transcript is this" on `viewedAgentTask`. Do not guard on `viewedTeammateTask`, which excludes local agents.
- Key the subtree on the viewed task. Sidechains reuse the leader's UUIDs, so the two transcripts collide in the height cache and in React keys.
- Re-pin scroll in the `useLayoutEffect` beside `repinScroll`. Do not add a second re-pin keyed on message count, because it also fires during ordinary streaming and drags the user down.

## Sessions and resume

- A session ID is not exclusive. Two live processes can interleave writes into one transcript and share `~/.freecode/tasks/<sessionId>/`.
- `getLiveSessionHolders` is read-only on purpose and fails open, because `isProcessRunning` reports false for a PID that it cannot probe.
- Four paths adopt a session, and a check in one covers none of the others: `processResumedConversation`, `ResumeConversation.onSelect`, `REPL.resume`, and `loadInitialMessages`. Only the first, second and fourth share `loadConversationForResume` and its `beforeResumeSideEffects` hook.
- `gracefulShutdownSync` only schedules the exit and returns. Throw `ResumeCancelledError` after it, or the process adopts the session that it just refused.
- A mid-session fork is `'ownership_fork'`, not `'fork'`. `'fork'` means one conversation with a new ID, so it skips content reconstruction, which is wrong for messages from another session.
- Neither fork flavor writes its own transcript. `useLogMessages` re-records the array when the first message UUID changes.

## Config and hooks

- Per-project config lives in `.claude/` or `.freecode/`, and `.freecode/` wins. Use [src/utils/projectConfigPaths.ts](src/utils/projectConfigPaths.ts).
- `modelSettings.json` merges after `freecode.json`, and `SettingsSchema` passes unknown keys through, so a general key there would outrank `freecode.json`. The reader filters raw JSON to `MODEL_SETTINGS_KEYS` before schema validation, so a bad key cannot take the provider config down with it.
- `areAllHooksDisabled()` gates settings hooks, plugin hooks and session-derived hooks separately. A missed check re-enables that one channel in silence. `hasWorktreeCreateHook()` must mirror the same filtering.

## Terminal UI

### Scroll

- A ScrollBox child must not take its height from the parent. A percentage height, or `alignSelf: 'stretch'` with no content, collapses to `minHeight` after culling and re-entry. Give a divider node real content, or use the neighbor's `borderLeft`.
- `height` on a bordered ScrollBox includes the 2 border rows. Code that budgets in content lines must add them back.
- REPL's `ScrollKeybindingHandler` registers before any modal and owns the wheel, PgUp, PgDn and ctrl+home/end. A modal cannot claim them with `useInput`, and must publish a handle on `ModalContext.scrollRef` instead. Bare pager keys are not in that set.
- Re-pin scroll after any `conversationId` bump, and after async work that renders an intermediate empty range.
- Clear `scrollFollowBaseline` wherever you restore sticky scroll. A stale baseline parks the user short of the bottom until the next submit.
- Compare against `getFollowThreshold()` on downward scrolls only. An upward jump measured that way lands at the bottom.
- The renderer's follow bypasses `ScrollBoxHandle`, so it calls `notifyScrollListeners` on a microtask. Anything derived from "at the bottom" is otherwise stuck at the last React render.
- Treat `isSticky()` as authoritative for the jump-to-bottom pill, and clamp `dividerY` to the current `scrollHeight`. Content can end up shorter than the snapshot and strand the pill.
- The rendered message list is not append-only. `reorderMessagesInUI` moves a `tool_result` up beside its `tool_use`, so parallel calls that finish out of order insert a row before the tail, and a collapse or a streaming placeholder replaces a row in place. The memoized user-context row also holds index 0 steady, so a first-element check sees none of it.

### Input

- Apple Terminal strips shift from arrow keys, and splits `option+↑` into `escape` then `up`. Never put a required action behind a modified arrow key.
- The keybinding emitter runs before `dispatchKeyboardEvent`, so a DOM `onKeyDown` cannot pre-empt a registered keybinding. `CancelRequestHandler` claims escape during a query. Build layered escape semantics in the emitter layer.
- A click focuses the nearest ancestor with a numeric `tabIndex`. Keep one focusable root per dialog and track panel focus in component state. A click that drags becomes a selection and never fires `onClick`.

## Tool arguments

A strict schema forces a model to send `null` for an omitted optional field.
[src/utils/stripStrictNullInputs.ts](src/utils/stripStrictNullInputs.ts) removes
those placeholders only where the schema allows absence. Never strip a `null`
that the schema itself admits, because an MCP tool can mean something by it.
Never strip `""` on a required field, which is a value. Pass
`tool.inputJSONSchema ?? tool.inputSchema`, because a Zod passthrough hides
every MCP argument.

## WebUI

The browser UI attaches to a running session over a per-process Unix socket.
Everything is behind `feature('WEBUI')`.

- The socket keys on PID, never on session ID. `/resume` and `/clear` both change a process's session ID, and two processes can legitimately hold one session ID after an ownership takeover. The stable control target is `<pid>:<nonce>`; the nonce is what stops a recycled PID passing for the process a client was told about.
- `regenerateSessionId()` now emits `sessionSwitched`, so `/clear` reaches the same subscribers `/resume` does. The PID registry was already going stale without it. Anything new that indexes by session ID gets this for free; anything that assumed the signal meant "resume" specifically does not.
- A live transcript comes wholly through the socket. Splicing a JSONL snapshot to a socket tail would have to reconcile queued writes, later-mutated assistant messages, interleaved metadata records, DAG branches and `reorderMessagesInUI` order. Disk is only for sessions with no live process.
- Prompts go through the command queue, never `Mailbox`, which polls only when the REPL is idle. "Interrupt and send" is one enqueue at `now` priority; a cancel followed by a submit races.
- In headless, `enqueue()` does not start a turn. The stdin path calls `run()` after every enqueue, so any other producer must too.
- The browser permission surface is a fourth racer in `interactiveHandler.ts` on the existing `claim()` contract. A browser disconnect must never deny by omission: the broker holds the request and the terminal dialog stays answerable.
- `publishTranscript` must early-out on `hasSubscribers` before diffing. This runs on every transcript mutation in every interactive process, and almost every process is never attached to.
- A `WEBUI`-off build still has to resolve the generated client asset module, so the build writes an empty stub when the flag is off. Without it a fresh checkout cannot build.
- Do not use a CSP directive name as a "is the WebUI in this binary" marker. `highlight.js` ships a Content-Security-Policy grammar, so `frame-ancestors` is in every build.
- A gateway-spawned child needs a configured config home: provider settings, trust, and API-key approval. `claude web start` creates none of those, which is why the e2e suite seeds the directory with a tmux session first.

## Bash permissions

- There is one bash parser and no fallback. A command that the parser refuses is `too-complex`, which becomes a prompt, never a second opinion. The `shell-quote` path it replaced mis-parsed in ways it could not detect, so a fallback hands bypasses to adversarial input. Keep `shell-quote` in files that parse for display, completion or quoting.
- Strip wrappers only in [src/utils/bash/wrappers.ts](src/utils/bash/wrappers.ts), which fails closed on an unknown flag. A layer that strips a wrapper another layer keeps is exploitable in both directions.
- `sourceText` is the exact span, for exact rules, display and execution. `matchText` is the resolved argv, for prefix and wildcard rules. `sourceText` excludes redirects, so a text-only read-only check misses `> /tmp/evil`.
- `BashTool.isReadOnly` is a positive auto-approval. `extractMemories` and prompt speculation act on it without a prompt.
