<p align="center">
  <img src="assets/screenshot.png" alt="free-code" width="720" />
</p>

<h1 align="center">free-code</h1>

<p align="center">
  <strong>The free build of Claude Code.</strong><br>
  Telemetry off. Prompt guardrails stripped. Experimental features unlocked.
</p>

---

## Quick Install

```bash
curl -fsSL https://raw.githubusercontent.com/paoloanzn/free-code/main/install.sh | bash
```

The script checks your system, installs Bun if it is missing, clones the repo,
runs `bun run build:dev:full`, and links `free-code` onto your PATH. Then run
`free-code` and use `/login` to authenticate with your provider.

## What is this

A clean, buildable fork of Anthropic's
[Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI, the
terminal-native AI coding agent, rebuilt from the source that became public on
2026-03-31 through a source map exposure in the npm distribution. Four
categories of change on top of that snapshot:

- **Telemetry is off.** `logOTelEvent` is an empty function and nothing leaves the machine; the remote feature-flag engine is gone, so every flag is a compile-time switch or a local setting. Two honest caveats: dead exporter code and one remote config fetch in `src/services/api/grove.ts` still exist — read before trusting a claim of total silence.
- **Prompt guardrails are stripped.** The cyber-risk instruction block and the managed-settings/MDM overlay are deleted, so no server can push a rule into your session. One permissive reminder survives after some file reads (it says the model may analyze malware). The model's own safety training still applies.
- **React Compiler output is decompiled.** The shipped snapshot had memo-cache artifacts baked into every `.tsx`; the original source was recovered from the inline source maps. The compiler is now an optional build step, off by default.
- **Experimental features are unlocked.** 25 of the 29 compile-time flags ship in the dev-full build; [FEATURES.md](FEATURES.md) audits each one.

## Build and test

Requires [Bun](https://bun.sh) 1.4.2 or later, macOS or Linux (WSL on Windows),
and an API key or OAuth login for your provider.

```bash
bun install
bun run build            # ./cli — the 10 default flags
bun run build:dev:full   # ./cli-dev — 25 flags, incl. WEBUI
bun run dev              # run src/ straight, WITHOUT the default feature flags
bun run typecheck && bun run test:unit
bun run test:e2e         # needs a fresh ./cli-dev and tmux on PATH
bun run format           # prettier
```

The executable is not self-contained: `vendor/ripgrep/` and
`vendor/search-tools/` sidecars are copied beside it and must move with it.

```bash
./cli                                  # interactive REPL
./cli -p "what files are in this dir?" # one-shot
./cli --model claude-opus-4-6          # pick a model
```

### Browser session UI

`WEBUI` is a dev-full flag, so this needs `./cli-dev`:

```bash
./cli-dev web start --tunnel none   # loopback only
./cli-dev web status                # URL and tunnel state
./cli-dev web restart               # reload after a rebuild, keeping the URL
```

The first run asks for a password without echo. Anyone holding that password can
approve a command that runs on your machine — treat it like an SSH key. The
gateway lives inside the daemon, binds `127.0.0.1`, and the tunnel is the only
public path. After a rebuild, `web restart` keeps the hostname the tunnel handed
out before, so a URL already open on a phone keeps working. A terminal session
is attachable only if its process came from a `WEBUI` build.

## Tech stack

Bun, TypeScript, React 19 on a repository-local terminal renderer
(`react-reconciler`) with a pure-TypeScript Yoga port — no native build step.
Browser UI is React 19 and hand-written CSS over `Bun.serve`. Commander, Zod v4,
ripgrep/bfs/ugrep, MCP and LSP. Providers: Anthropic, OpenAI Responses and Chat
Completions, Bedrock, Vertex, Foundry, Gemini.

## IPFS Mirror

A full copy of this repository is pinned on IPFS through Filecoin. If this repo
is taken down, the code lives on.

|             |                                                                                   |
| ----------- | --------------------------------------------------------------------------------- |
| **CID**     | `bafybeiegvef3dt24n2znnnmzcud2vxat7y7rl5ikz7y7yoglxappim54bm`                     |
| **Gateway** | https://w3s.link/ipfs/bafybeiegvef3dt24n2znnnmzcud2vxat7y7rl5ikz7y7yoglxappim54bm |

## Contributing

1. Read [CLAUDE.md](CLAUDE.md). It records the couplings and external behavior
   that the code cannot state.
2. Check [FEATURES.md](FEATURES.md) before you touch flag-gated behavior.
3. Run `bun run typecheck` and `bun run test:unit`; run `bun run test:e2e` after
   `bun run build:dev:full`, because the e2e suite runs the compiled binary.
4. Run `bun run format`.
5. Open a pull request.

## License

The original Claude Code source is the property of Anthropic. This fork exists
because the source was exposed through their npm distribution. Use at your own
discretion.
