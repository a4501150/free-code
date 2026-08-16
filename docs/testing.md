# Testing

```bash
bun run test:unit    # 79 files
bun run test:e2e     # 28 files, needs a build and tmux
bun run test         # unit, then e2e
bun run typecheck    # tsc --noEmit
bun run format       # prettier --write .
```

`bun run test` does not typecheck and does not format. Run those yourself.

## Layout

| Path               | Holds                                                   |
| ------------------ | ------------------------------------------------------- |
| `tests/unit/`      | 79 test files that import source directly               |
| `tests/e2e/`       | 28 test files that drive a compiled binary through tmux |
| `tests/helpers/`   | 7 modules: mock servers, fixture builders, wait helpers |
| `tests/preload.ts` | Placeholder `MACRO.*` values                            |

## The preload

`bunfig.toml` loads `tests/preload.ts` into every test process.

`MACRO.VERSION` and its siblings are build-time defines that
[scripts/build.ts](../scripts/build.ts) supplies. Source read from a test would
throw `ReferenceError` without them. The preload supplies the same shape with
placeholder values.

## End-to-end tests

Build first. The suite runs the compiled binary, not `src/`:

```bash
bun run build:dev:full
bun run test:e2e
```

Two prerequisites are easy to miss:

- **The binary must be current.** The default target is `./cli-dev`, from `bun run build:dev:full`. If you edit source and do not rebuild, the tests pass against old code. A test that needs the production feature set passes `cliBinary: './cli'` instead.
- **`tmux` must be on `PATH`.** The harness checks once and fails fast with an install hint.

Each test starts the CLI inside its own tmux session, under `env -i` with a
temporary `HOME`, config directory and working directory. No credential and no
setting from your machine reaches a test.

A mock server replaces the provider, so no test needs a real API key. There are
mock servers for Anthropic, Codex and OpenAI.

### Reading the result

Read the mock server's request log to assert on request bodies, ordering and
tool results. Capture the tmux pane to assert on what the user sees. Do not read
a request body out of the pane, because ANSI output contaminates the text.

Reset a mock server only after the previous turn goes idle. A reset during a
live turn races the requests still in flight.

`TmuxSession` sets `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=0`. Suggestions would
otherwise consume queued mock responses invisibly. A test that turns them back on
must queue the extra responses.

## Unit tests

Unit tests are fast and need no build.

One trap deserves attention. Bun runs the files in one process, and
`mock.module` is global and permanent for that process.
`tests/unit/autoCompactThreshold.test.ts` stubs `getInitialSettings`, so a later
file that writes a real `freecode.json` reads the stub instead. Such a test
passes on its own and fails in the suite.

Gate that kind of test on an environment variable that the code reads before
settings. Module-level `memoize` leaks across files the same way.
