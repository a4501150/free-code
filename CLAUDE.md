# CLAUDE.md

Only what the code cannot tell you: hidden couplings, external system behavior,
silent failures, and deliberate decisions. If reading the relevant file answers
it, it does not belong here.

Build, configuration, testing and layout live in [docs/](docs/).

## Build and test

- E2E tests run the compiled `./cli-dev`. Rebuild with `bun run build:dev:full` after every source edit, or they pass against stale code.
- Unit files share one process, and `mock.module` is global and permanent for it. [tests/unit/autoCompactThreshold.test.ts](tests/unit/autoCompactThreshold.test.ts) stubs `getInitialSettings`, so a later file that writes `freecode.json` reads the stub and fails only in the suite. Gate such a test on an env var the code reads before settings. Module-level `memoize` leaks the same way.
- Read the mock server's request log for bodies, ordering and tool results. Capture the tmux pane only for rendered output, because ANSI contaminates anything parsed from it.
- `TmuxSession` disables prompt suggestions, whose hidden calls would consume mock responses. A test that re-enables them must queue the extra requests.
- Reset a mock server only after the previous turn is idle.

## Providers

A provider type does not imply an auth method. Bedrock and Gemini acquire
credentials themselves, so no single boundary owns auth. Gate Anthropic-platform
metadata and headers to Anthropic-type providers, because elsewhere they churn
the cache key for nothing.

### External API behavior

None of this is discoverable from our code:

- A first-party request without `metadata.user_id` gets a 429.
- The 1P API rejects a non-Haiku request without the `CLISyspromptPrefix` block.
- The attribution block's `cch` field hashes the whole body, so it changes every request. A cache breakpoint there can never hit.
- The API allows four cache breakpoints and hard-400s on a fifth.
- Bedrock rejects an assistant turn whose signed blocks were edited or reordered. Removing an intervening `toolUse` is enough.
- Bedrock Converse returns 400 for the header-only `claude-code-*` betas. Only identifiers Converse documents may travel in the body.
- DeepSeek V4 returns 400 unless the reasoning field a response used is echoed back in that same field. Other OpenAI-compatible endpoints ignore it, and some reject an unknown name, so never guess it.

### Reasoning

- Reasoning continuation data is provider-specific and not portable. A `ProviderType` missing from the predicate table loses all reasoning in silence. `vertex` and `foundry` alias the `anthropic` entry.
- Gemini signs a whole Part, so a signature rides on text and tool_use blocks too. Never move one between blocks.

### Stream events

A `stream_event` leaving [src/services/api/claude.ts](src/services/api/claude.ts)
carries domain types, so extended thinking is `reasoning`, never `thinking`.
`DomainStreamEvent.content_block` widens to `{ type: string }`, so a comparison
against a wire type typechecks and silently never matches. Use
[src/types/domainGuards.ts](src/types/domainGuards.ts).

## System prompt and cache prefix

The prefix order is `tools`, then `system`, then `messages`.

- Keep the system prompt byte-identical across sessions and projects, so a fresh session in a new directory reads the prefix instead of writing it. Session facts (cwd, model, git status, scratchpad path) belong in the prepended user-context message. [tests/unit/staticSystemPrompt.test.ts](tests/unit/staticSystemPrompt.test.ts) guards this.
- Tool-derived variation is free, because a change to the tools block already invalidates everything after it.
- The memory prompt may name directories but must not interpolate paths, which would cost a per-project prefix. Agent memory is the exception, because a subagent has no environment block.
- Three of the four breakpoints are in use, at three change frequencies. Keep the fourth as headroom, and do not spend it on the 20-block cache lookback: real tool loops exceed that on a negligible share of turns, and the miss costs one cache write the next turn repairs.
- The tail marker belongs on the last element of `filteredTools`, because server tools are appended later.
- Do not reintroduce global cache scope. It was removed because the shared entry only pays off for byte-identical preambles at a scale this fork does not have.
- The attribution fingerprint depends on the first API user message. Do not add per-turn content ahead of it, do not reshape the user-context prepend, and do not drop the `getUserContext` memoization in [src/context.ts](src/context.ts). Clear its caches only at compact, clear, or a prompt injection change.
- An output-style body must stay byte-stable, because the default style sits in the cached prefix. Never substitute `${CLAUDE_PLUGIN_ROOT}` and never render a source path beside the name.

## Context attachments

- `getAttachmentMessages` runs per tool-loop iteration, not per user turn, and everything it yields stays in the conversation forever. An attachment with a stable predicate duplicates on every tool call and accelerates the compaction it warns about.
- Put standing policy in the cached prefix instead. Guidance about one tool belongs in that tool's description; only cross-cutting policy belongs in [src/constants/prompts.ts](src/constants/prompts.ts). Reserve an attachment for news.
- For a once-per-window guard, test the transcript, not session state. Compaction replaces the history and re-arms the guard with no reset hook.
- Never count `AssistantMessage` objects as turns. Streaming emits one per content block, so one response with three parallel tool calls advances such a counter by four. Count human turns, or responses keyed by `message.id`.
- Prefer a trigger that decays. A gate a session satisfies forever fires forever.

## Injected context in the UI

- Reminder text and the CLAUDE.md user-context block do not exist in the transcript. [src/components/Messages.tsx](src/components/Messages.tsx) rebuilds both at render time. Leave the request path alone, and keep `formatUserContextMessageContent` byte-identical to what `prependUserContext` sends.
- `isVirtual` is not an escape hatch. `transformMessagesForExternalTranscript` promotes such a row to a real message on persist, so on resume it becomes the first API user message and breaks the fingerprint.
- `shouldHideAttachmentInUI` and the unseen-divider filter in [src/components/FullscreenLayout.tsx](src/components/FullscreenLayout.tsx) must agree, or the divider anchors to a row the transcript then skips.

## Subagents

- `TasksV2Store` must call `getMainTaskListId()`. `setTimeout` inherits the subagent `AsyncLocalStorage` scope, so `getTaskListId()` reads another agent's directory.
- `createSubagentContext` nulls every parent UI callback. Route anything the UI must show onto `LocalAgentTaskState` through an explicit `runAgent` callback.
- Nine call sites invoke `runAgent`, but only the three loops owning a retained `LocalAgentTaskState` call `appendRetainedAgentMessage`. A new loop backing a drill-down must call it, or that transcript renders empty.
- The live Agent card is `AgentProgressLine` through `GroupedAgentToolUseView`. `renderToolUseProgressMessage` serves only the non-grouped and slash-command paths, so changing one alone looks like no change at all.
- The drill-down swaps data rather than mounting a screen, so ScrollBox stays alive and `conversationId` does not change. Keep the key on `Messages`, because sidechains reuse the leader's UUIDs and the transcripts would collide in the height cache and in React keys. Guard transcript-scoped props on `viewedAgentTask`, not `viewedTeammateTask`, which excludes local agents.

## Sessions and resume

- A session ID is not exclusive. Two live processes can interleave writes into one transcript and share `~/.freecode/tasks/<sessionId>/`.
- `getLiveSessionHolders` is read-only and fails open on purpose, because `isProcessRunning` reports false for a PID it cannot probe.
- Four paths adopt a session and a check in one covers none of the others: `processResumedConversation`, `ResumeConversation.onSelect`, `REPL.resume`, `loadInitialMessages`. Only the first, second and fourth share `loadConversationForResume` and its `beforeResumeSideEffects` hook.
- `gracefulShutdownSync` only schedules the exit and returns. Throw `ResumeCancelledError` after it, or the process adopts the session it just refused.
- A mid-session fork is `'ownership_fork'`, not `'fork'`. `'fork'` means one conversation with a new ID, so it skips the content reconstruction that messages from another session need.
- Neither fork flavor writes its own transcript. `useLogMessages` re-records the array when the first message UUID changes.

## Config and hooks

- Per-project config lives in `.claude/` or `.freecode/`, and `.freecode/` wins. Use [src/utils/projectConfigPaths.ts](src/utils/projectConfigPaths.ts).
- `modelSettings.json` merges after `freecode.json` and `SettingsSchema` passes unknown keys through, so a general key there would outrank `freecode.json`. The reader filters raw JSON to `MODEL_SETTINGS_KEYS` before validation, so a bad key cannot take the provider config down with it.
- `areAllHooksDisabled()` gates settings, plugin and session-derived hooks separately, so a missed check re-enables that one channel in silence. `hasWorktreeCreateHook()` must mirror the filtering.
- Every path that executes a hook re-checks workspace trust independently. A new execution channel that skips the gate is a silent bypass.

## Terminal UI

- A ScrollBox child must not take its height from the parent. A percentage height, or `alignSelf: 'stretch'` with no content, collapses to `minHeight` after culling and re-entry. Give a divider node real content, or use the neighbor's `borderLeft`.
- REPL's `ScrollKeybindingHandler` registers before any modal and owns the wheel, PgUp, PgDn and ctrl+home/end. A modal cannot claim them with `useInput` and must publish a handle on `ModalContext.scrollRef`. Bare pager keys are not in that set.
- Re-pin scroll after any `conversationId` bump and after async work that renders an intermediate empty range, and clear `scrollFollowBaseline` wherever you restore sticky scroll. A stale baseline parks the user short of the bottom until the next submit. Do not add a second re-pin keyed on message count, which also fires during ordinary streaming.
- Compare against `getFollowThreshold()` on downward scrolls only. An upward jump measured that way lands at the bottom.
- The rendered message list is not append-only. `reorderMessagesInUI` moves a `tool_result` up beside its `tool_use`, a collapse or streaming placeholder replaces a row in place, and the memoized user-context row holds index 0 steady, so a first-element check sees none of it.
- Apple Terminal strips shift from arrow keys and splits `option+↑` into `escape` then `up`. Never put a required action behind a modified arrow key.
- The keybinding emitter runs before `dispatchKeyboardEvent`, so a DOM `onKeyDown` cannot pre-empt a registered keybinding. `CancelRequestHandler` claims escape during a query. Build layered escape semantics in the emitter layer.
- A click focuses the nearest ancestor with a numeric `tabIndex`, so keep one focusable root per dialog and track panel focus in state. A click that drags becomes a selection and never fires `onClick`.

## Tool arguments

A strict schema forces a model to send `null` for an omitted optional field, and
[src/utils/stripStrictNullInputs.ts](src/utils/stripStrictNullInputs.ts) removes
those placeholders. Never strip a `null` the schema itself admits, because an MCP
tool can mean something by it. Pass `tool.inputJSONSchema ?? tool.inputSchema`,
because a Zod passthrough hides every MCP argument.

## Edit anchors

An anchor resolves by content, not position, so an anchor held across an earlier
edit still works. That is what makes a second Edit to one file possible without a
second Read, and it is the property `str_replace` had for free.

Do not widen `HASH_LEN` to buy a higher resolution rate. Measured over `src/`,
38.5% of non-blank lines share a 3-character hash with another line in their own
file, and 37.7% still do at 4 characters: the rate is genuine duplicate text, not
hash collisions. A fourth character recovers almost nothing and charges one
character on every line of every Read. Those duplicates are what the sibling-shift
rule in `applyHashlineEdits` exists for, because a range ending on `}` can never
be placed alone.

## WebUI

The browser UI attaches to a running session over a per-process Unix socket.
Everything is behind `feature('WEBUI')`.

- The socket keys on PID, never session ID: `/resume` and `/clear` both change a process's session ID, and two processes can legitimately hold one after a takeover. The control target is `<pid>:<nonce>`, and the nonce stops a recycled PID passing for the process a client was told about.
- The session list is one row per session, not per process, because a takeover leaves two live PIDs on one session ID. `groupLiveHolders` elects a primary — attachable first, then a terminal over a `daemon-worker`, then newest — and reports the rest as `holders`. `stoppablePid` is separate from the primary, or a stuck gateway child becomes unreachable the moment a terminal outranks it.
- A holder counts as attachable only when its descriptor agrees with the registry on both PID and session ID. `switchSession` rewrites the descriptor asynchronously, so for a moment one session ID pairs with another session's socket.
- `regenerateSessionId()` emits `sessionSwitched`, so `/clear` reaches the same subscribers `/resume` does. Code that assumed the signal meant "resume" specifically is wrong.
- A live transcript comes wholly through the socket. Splicing a JSONL snapshot to a socket tail would have to reconcile queued writes, later-mutated assistant messages, interleaved metadata, DAG branches and `reorderMessagesInUI` order. Disk serves only sessions with no live process.
- Prompts go through the command queue, never `Mailbox`, which polls only when the REPL is idle. "Interrupt and send" is one enqueue at `now` priority; a cancel followed by a submit races.
- In headless, `enqueue()` does not start a turn. The stdin path calls `run()` after every enqueue, so any other producer must too.
- The browser permission surface is a fourth racer in `interactiveHandler.ts` on the existing `claim()` contract. A disconnect must never deny by omission: the broker holds the request and the terminal dialog stays answerable.
- A gateway-spawned child needs a configured config home: provider settings, trust and API-key approval. `claude web start` creates none of those, which is why the e2e suite seeds the directory with a tmux session first.
- A rebuild does not reach a running gateway, whose supervisor is a separate long-lived process spawning sessions from its own `process.execPath`. Both `web restart` and a `web stop` plus `web start` replace it, but only `restart` asks the tunnel for the previous hostname, so only `restart` keeps a URL already open on a phone alive. The provider may refuse that hostname.
- An exception while handling an attach request kills that connection silently: the child still accepts later connections and reads their lines but never answers, looking alive and idle. A browser can connect the instant the socket exists, so every binding an attach callback reads must be declared before attach starts.
- A browser resume must wait for a descriptor whose `sessionId` equals the one requested. `loadInitialMessages` resumes before attach starts, so no descriptor carries the pre-resume ID, and accepting the first would return 200 for a child that then exits — which is what a missing session or a holder conflict looks like. Take the working directory from the recorded session, never the client.
- Do not pass `--fork-session` on resume. Without it print mode readopts the original session ID, which lets the session list drop the duplicate history row.
- The registry cannot tell a gateway child from a terminal on its own. `CLAUDE_CODE_WEBUI_ATTACH` carries the gateway PID, and the predicate also requires `process.ppid` to match, because every descendant inherits the variable and a bare flag would let a `claude` started by the Bash tool claim the same identity. The answer is latched at load: the gateway can exit and reparent the child, which must not retract the identity.

### Browser client

- An off-screen panel is not a closed one. The session drawer and instrument sheet need `visibility: hidden` on top of the transform or zero height, or they keep their place in the tab order and in hit testing while invisible.
- The instrument panels are one DOM tree that CSS reshapes into a sheet or a column. Never render one of two copies behind a JavaScript media query: crossing the breakpoint would unmount the panel and discard the pending-model state that stops the control snapping back.
- Mobile form controls must stay at 16px or larger, because iOS Safari zooms on focus below that and does not zoom back. Chromium will not open a window under 500px, so no in-browser check can reach 390px or prove iOS keyboard behavior.
- The client bundle has no zod and must keep none. Every import from `protocol/attachSchemas.ts` is type-only; importing a constant would pull the schema library into a phone's download for one number.
- The same rule binds harder for `gateway/`, which the client imports types from. Those modules reach `fs` and `os`, so a value import does not shrink a bundle, it breaks one. Duplicate the handful of lines instead.
- The page's CSP allows `img-src 'self' data:` and nothing else. A `blob:` URL is refused, and building one needs a `fetch` of a `data:` URL that `connect-src` refuses in turn. Set a data URL straight onto the `img`.
- The client follows a session, not a process. It tracks `activeSessionId` beside `activeKey` and re-attaches when a holder ends, so a takeover or a restart keeps the transcript on screen. `process_gone` is a gateway frame and not an `AttachEventBody`, because no process is left to have emitted it, and `useGateway` forwards only `type === 'event'` to the store.
- A follow must exclude process keys already known dead. The list is a five-second poll behind, so it still advertises the process that just ended, and attaching there answers `attach_failed` and never delivers a snapshot: the view strands on an empty transcript with a composer that cannot send. `chooseFollowTarget` also distinguishes "no row yet" from "the session is history", because both look like an absent live row during the gap.
- Clearing `activeKey` in React is not enough to stop watching a process. `connectGateway` remembers the key so it can re-attach after a reconnect, so a dead one needs `detach()`.

### Interactive tools in the browser

- `AskUserQuestion` and `ExitPlanMode` always return `ask`, and the terminal answers by allowing with an enriched `updatedInput`, not a boolean. A bare allow runs the tool with `answers: {}`, telling the model the user answered nothing.
- An approval must drop `plan` from `ExitPlanMode`'s input, because the tool reads the plan from disk when absent and otherwise reports "Approved Plan (edited by user)" for a plan nobody edited. The browser cannot send the terminal's empty object, which the bridges read as "use the original".
- A browser allow carries no `PermissionUpdate[]`. A mode change rides its own `set_permission_mode` request sent first, and one socket delivers them in order, reproducing the terminal ordering where the mode lands before the tool runs.
- `persist` is session-scoped on purpose. The terminal's "don't ask again" writes a durable rule to disk, and this surface is reachable from the internet behind one password.

## Bash permissions

- There is one bash parser and no fallback. A command it refuses is `too-complex`, which becomes a prompt, never a second opinion. The `shell-quote` path it replaced mis-parsed in ways it could not detect, and a fallback hands bypasses to adversarial input. Keep `shell-quote` for display, completion and quoting only.
- Resolve a command for a security decision only through [src/utils/bash/wrappers.ts](src/utils/bash/wrappers.ts), which fails closed on an unknown flag. A narrower regex stripper survives in `bashPermissions.ts` to widen rule matching and must never decide. A layer that strips a wrapper another layer keeps is exploitable both ways.
- `sourceText` excludes redirects, so a read-only check that reads it alone misses `> /tmp/evil`.
- `BashTool.isReadOnly` is a positive auto-approval. `extractMemories` and prompt speculation act on it without a prompt.
