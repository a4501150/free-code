<p align="center">
  <img src="assets/screenshot.png" alt="free-code" width="720" />
</p>

<h1 align="center">free-code</h1>

<p align="center">
  <strong>The free build of Claude Code.</strong><br>
  Telemetry off. Prompt guardrails stripped. Experimental features unlocked.
</p>

<p align="center">
  <a href="#quick-install"><img src="https://img.shields.io/badge/install-one--liner-blue?style=flat-square" alt="Install" /></a>
  <a href="https://github.com/paoloanzn/free-code/stargazers"><img src="https://img.shields.io/github/stars/paoloanzn/free-code?style=flat-square" alt="Stars" /></a>
  <a href="https://github.com/paoloanzn/free-code/issues"><img src="https://img.shields.io/github/issues/paoloanzn/free-code?style=flat-square" alt="Issues" /></a>
  <a href="FEATURES.md"><img src="https://img.shields.io/badge/features-29%20flags-orange?style=flat-square" alt="Feature Flags" /></a>
  <a href="#ipfs-mirror"><img src="https://img.shields.io/badge/IPFS-mirrored-teal?style=flat-square" alt="IPFS" /></a>
</p>

---

## Quick Install

```bash
curl -fsSL https://raw.githubusercontent.com/paoloanzn/free-code/main/install.sh | bash
```

The script checks your system, installs Bun if it is missing, clones the repo,
runs `bun run build:dev:full`, and links `free-code` onto your PATH.

Then run `free-code` and use `/login` to authenticate with your provider.

## Documentation

| Document                                       | Covers                                                      |
| ---------------------------------------------- | ----------------------------------------------------------- |
| [docs/building.md](docs/building.md)           | Build variants, output paths, feature flags, React Compiler |
| [docs/configuration.md](docs/configuration.md) | Providers, models, settings files, environment variables    |
| [docs/testing.md](docs/testing.md)             | Unit and end-to-end tests, and what the e2e suite needs     |
| [docs/architecture.md](docs/architecture.md)   | The source tree and how the parts fit                       |
| [FEATURES.md](FEATURES.md)                     | The per-flag audit                                          |

---

## What is this

A clean, buildable fork of Anthropic's
[Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI, the
terminal-native AI coding agent. The upstream source became public on
2026-03-31 through a source map exposure in the npm distribution.

This fork applies four categories of change on top of that snapshot.

### Telemetry is off

The upstream binary reports through OpenTelemetry, Sentry and custom event
logging. Here:

- `logOTelEvent` is an empty function, and `initSinks` attaches only a local error log. Nothing leaves the machine.
- The remote feature-flag engine is gone. Every flag is now a compile-time switch or a local setting.

Two honest qualifications. The OpenTelemetry packages stay declared in
`package.json`, and `src/utils/telemetry/bigqueryExporter.ts` still holds a
network exporter that no code constructs. `src/services/api/grove.ts` still
fetches one remote configuration. Read the code before you trust a claim of
total silence.

### Prompt guardrails are stripped

Anthropic injects instructions that constrain the model beyond its own training:
hardcoded refusal patterns, a cyber-risk instruction block and a
managed-settings security overlay pushed from their servers.

- `CYBER_RISK_INSTRUCTION` is now an empty string.
- The managed-settings, MDM and remote-policy code is deleted, so no server can push a rule into your session.

One reminder still fires after some file reads, and it is worth knowing that it
is permissive rather than restrictive: it tells the model that it may analyze
malware. It is skipped for models priced at $5/Mtok or more. See
`src/tools/FileReadTool/FileReadTool.ts`.

The model's own safety training still applies. This removes the layer the CLI
wrapped around it, nothing more.

### React Compiler output is decompiled

The snapshot shipped React Compiler output baked into every `.tsx` file:
`_c()` cache arrays, `$[N]` memoization slots, `t0` parameter renaming. The code
was close to unreadable.

This fork recovered the original source from the inline base64 source maps in
each file. The 515 `.tsx` files in `src/` are clean, human-readable TSX. The
React Compiler is now an optional build step and is off by default.

### Experimental features are unlocked

The source gates 29 features behind `bun:bundle` compile-time switches.

| Set                  | Flags  | Build                    |
| -------------------- | ------ | ------------------------ |
| Default              | 10     | `bun run build`          |
| Default and dev-full | 25     | `bun run build:dev:full` |
| Manual-only          | 4 more | `--feature=NAME`         |

No single build enables all 29. The four manual-only flags stay off unless you
name them. [FEATURES.md](FEATURES.md) audits each one.

---

## Requirements

- [Bun](https://bun.sh) 1.3.11 or later
- macOS or Linux. Use WSL on Windows.
- An API key or an OAuth login for your provider

## Build

```bash
git clone https://github.com/paoloanzn/free-code.git
cd free-code
bun install
bun run build
./cli
```

`bun run build` writes `./cli` with the 10 default flags.
`bun run build:dev:full` writes `./cli-dev` with 25. Full detail is in
[docs/building.md](docs/building.md).

## Usage

```bash
./cli                                  # interactive REPL
./cli -p "what files are in this dir?" # one-shot
./cli --model claude-opus-4-6          # pick a model
./cli /login                           # OAuth login
```

### Browser session UI

`WEBUI` is a dev-full flag, so this needs `./cli-dev`.

```bash
./cli-dev web start --tunnel none   # loopback only
./cli-dev web start                 # public URL through a tunnel
./cli-dev web status                # URL and tunnel state
./cli-dev web url                   # print the URL with a QR code
./cli-dev web restart               # reload after a rebuild, keeping the URL
./cli-dev web stop
```

The first run asks for a password without echo. Read this before you set one:
anyone holding that password can approve a command that runs on your machine.
Treat it like an SSH key, not a login.

The gateway lives inside the daemon, so it outlives the terminal. It binds
`127.0.0.1`, and the tunnel is the only public path.

After a rebuild, run `web restart`. Both `web restart` and a `web stop` and
`web start` pair pick up the new binary, but only `restart` asks the tunnel for
the hostname it used before, so a URL already open on a phone keeps working. The
provider can refuse, in which case the new URL is printed.

The browser lists live sessions from your terminals, sessions the gateway
started, and past sessions from disk. A terminal session is attachable only if
its process came from a `WEBUI` build. Windows is not supported.

---

## Tech Stack

|                 |                                                                                    |
| --------------- | ---------------------------------------------------------------------------------- |
| **Runtime**     | [Bun](https://bun.sh)                                                              |
| **Language**    | TypeScript                                                                         |
| **Terminal UI** | React 19 on a repository-local terminal renderer built on `react-reconciler`       |
| **Layout**      | A pure-TypeScript Yoga port, so there is no native build step                      |
| **Browser UI**  | React 19 and hand-written CSS, served by `Bun.serve`                               |
| **CLI parsing** | Commander, through `@commander-js/extra-typings`                                   |
| **Validation**  | Zod v4                                                                             |
| **Search**      | ripgrep, with `bfs` and `ugrep` alongside                                          |
| **Protocols**   | MCP and LSP                                                                        |
| **Providers**   | Anthropic, OpenAI Responses and Chat Completions, Bedrock, Vertex, Foundry, Gemini |

---

## IPFS Mirror

A full copy of this repository is pinned on IPFS through Filecoin.

|             |                                                                                   |
| ----------- | --------------------------------------------------------------------------------- |
| **CID**     | `bafybeiegvef3dt24n2znnnmzcud2vxat7y7rl5ikz7y7yoglxappim54bm`                     |
| **Gateway** | https://w3s.link/ipfs/bafybeiegvef3dt24n2znnnmzcud2vxat7y7rl5ikz7y7yoglxappim54bm |

If this repo is taken down, the code lives on.

---

## Contributing

Contributions are welcome.

1. Read [CLAUDE.md](CLAUDE.md). It records the couplings and external behavior that the code cannot state.
2. Check [FEATURES.md](FEATURES.md) before you touch flag-gated behavior, so you know whether the flag is default, dev-full or manual-only.
3. Run `bun run typecheck` and `bun run test:unit`. Run `bun run test:e2e` after `bun run build:dev:full`, because the e2e suite runs the compiled binary.
4. Run `bun run format`.
5. Open a pull request.

## License

The original Claude Code source is the property of Anthropic. This fork exists
because the source was exposed through their npm distribution. Use at your own
discretion.
