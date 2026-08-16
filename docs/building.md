# Building

The build script is [scripts/build.ts](../scripts/build.ts). It compiles the
source into one executable with `bun build --compile`.

## Requirements

- [Bun](https://bun.sh) 1.3.11 or later. `package.json` pins the package manager and sets the engine minimum.
- macOS or Linux. Use WSL on Windows.

```bash
curl -fsSL https://bun.sh/install | bash
git clone https://github.com/paoloanzn/free-code.git
cd free-code
bun install
bun run build
./cli
```

## Package scripts

| Script                   | Command                                         |
| ------------------------ | ----------------------------------------------- |
| `bun run build`          | `scripts/build.ts`                              |
| `bun run build:dev`      | `scripts/build.ts --dev`                        |
| `bun run build:dev:full` | `scripts/build.ts --dev --feature-set=dev-full` |
| `bun run compile`        | `scripts/build.ts --compile`                    |
| `bun run dev`            | `src/entrypoints/cli.tsx` directly              |
| `bun run test`           | `test:unit`, then `test:e2e`                    |
| `bun run test:unit`      | `bun test tests/unit/`                          |
| `bun run test:e2e`       | `bun test tests/e2e/ --timeout 120000`          |
| `bun run typecheck`      | `tsc --noEmit`                                  |
| `bun run format`         | `prettier --write .`                            |

See [testing.md](testing.md) for the test commands.

## Output paths

`--compile` and `--dev` combine into four output paths.

| Flags             | Output           |
| ----------------- | ---------------- |
| none              | `./cli`          |
| `--dev`           | `./cli-dev`      |
| `--compile`       | `./dist/cli`     |
| `--compile --dev` | `./dist/cli-dev` |

The name `--compile` is misleading. Every build calls `bun build --compile`. The
flag only moves the output into `dist/`.

A `--dev` build stamps the version with the date, the time and the short commit
hash. It also embeds the last 20 commit subjects.

## Build flags

The script accepts seven flags:

- `--compile`
- `--dev`
- `--react-compiler`
- `--feature-set dev-full` and `--feature-set=dev-full`
- `--feature NAME` and `--feature=NAME`

Four parsing behaviors can surprise you:

- `--feature` can repeat. Each occurrence adds one flag.
- A feature name is not validated. A typo becomes a flag that no code reads.
- `dev-full` is the only feature set that has a name. There is no `--feature-set=default`.
- An unknown argument is ignored without a message. An unknown `--feature-set` value is also ignored.

## Feature flags

The source references 29 compile-time flags through `feature(...)`. The build
turns them into `bun build --define` values.

| Set         | Count   | How to get it              |
| ----------- | ------- | -------------------------- |
| Default     | 10      | Every build includes these |
| dev-full    | 15 more | `--feature-set=dev-full`   |
| Manual-only | 4       | `--feature=NAME`           |

A default build has 10 flags. A dev-full build has 25, because the two lists do
not overlap. No build variant enables all 29.

[FEATURES.md](../FEATURES.md) holds the per-flag audit. It is the only authority
on what each flag does.

Enable a manual-only flag directly:

```bash
bun run ./scripts/build.ts --feature=WORKTREE_MODE --feature=DEDICATED_SEARCH_TOOLS
bun run ./scripts/build.ts --dev --feature=VERIFY_PLAN
```

## Running from source

`bun run dev` starts `src/entrypoints/cli.tsx` without a build step.

Be careful with it. It does not run the build script, so it supplies none of the
10 default `--feature` values. Feature-gated behavior therefore differs from
`bun run build`. Use it to iterate on code that no flag gates. Build a binary to
test anything that a flag gates.

## React Compiler

Add `--react-compiler` to apply automatic memoization to `.tsx` components.

```bash
bun run ./scripts/build.ts --react-compiler
bun run ./scripts/build.ts --dev --feature-set=dev-full --react-compiler
```

The step copies `src/` into `.compiled-src/` and runs Babel there. The checked-in
files stay clean. `.compiled-src/` is git-ignored.

The terminal UI does not need it. Treat it as an experiment.

## Bundled search tools

After the compile step, the build copies two directories beside the executable:

- `vendor/ripgrep/` — ripgrep binaries for Darwin, Linux and Windows.
- `vendor/search-tools/` — `bfs` and `ugrep` assets. This directory is git-ignored, because `scripts/searchTools.ts` downloads it.

The executable is therefore not self-contained. Move the sidecar directories with
it.

At run time the CLI prefers a system `rg` when one is available. Set
`USE_BUILTIN_RIPGREP=1` to force the bundled copy. See
[src/utils/ripgrep.ts](../src/utils/ripgrep.ts).

## The WebUI asset stub

The browser client compiles into `src/webui/generated/assets.ts`, which is
git-ignored.

When the `WEBUI` flag is off, the build writes an empty stub to that path. The
module must resolve either way, or a fresh clone cannot build.
