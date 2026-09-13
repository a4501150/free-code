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
- **Experimental features are unlocked.** Every subsystem ships compiled into every build and is activated at runtime by a setting or a CLI flag — see [Features](#features) below.

## Build and test

Requires [Bun](https://bun.sh) 1.4.2 or later, macOS or Linux (WSL on Windows),
and an API key or OAuth login for your provider.

```bash
bun install
bun run build            # ./cli
bun run dev              # run src/ straight, no compile step
bun run typecheck && bun run test:unit
bun run test:e2e         # needs a fresh ./cli-dev and tmux on PATH
bun run format           # prettier
```

`bun run build` and `bun run build:dev:full` are feature-equivalent; the latter
only stamps a dev version and skips minification. The executable is not
self-contained: `vendor/ripgrep/`, `vendor/search-tools/` and
`vendor/agent-browser/` sidecars are copied beside it and must move with it.

### Opt-in feature flags

Four subsystems stay behind compile-time `feature(...)` checks. Enable them by
passing `--feature=NAME` to the build script (unknown names are silently
ignored, so typos become dead flags):

| Flag                     | Effect                                                                                   |
| ------------------------ | ---------------------------------------------------------------------------------------- |
| `BUDDY`                  | Companion sprite and `/buddy` command. Currently a no-op: its modules have no consumers. |
| `DEDICATED_SEARCH_TOOLS` | Restores the dedicated search tools in place of the generic Bash channel.                |
| `VERIFY_PLAN`            | Plan verification guidance and task/todo verification nudges.                            |
| `WORKTREE_MODE`          | Worktree-mode behavior and the batch skill.                                              |

```bash
bun run ./scripts/build.ts --feature=VERIFY_PLAN --feature=WORKTREE_MODE
```

## Quick start

```bash
./cli                                    # interactive REPL
./cli -p "what files are in this dir?"   # one-shot, non-interactive
./cli -p --output-format json "..."      # single JSON result (also: stream-json)
./cli --model claude-opus-4-6            # pick a model
./cli -c                               # continue the most recent session
./cli -r                               # pick a session to resume
./cli --add-dir ../shared-lib          # give the agent another working directory
./cli --permission-mode plan           # start in plan mode
./cli --dangerously-skip-permissions   # no prompts; sandbox assumed
./cli --tasks                          # coordinator mode with the task list
./cli --help                           # the full option list
```

Subcommands: `web` (start/status/restart the browser session UI), `daemon`,
`mcp` (add/list server), `auth`, `plugin`, `config`, `agents`, `auto-mode`.

### Features

Subsystems that need runtime activation rather than a build flag:

- **Assistant / proactive mode** — `assistant.enabled` and `assistant.proactive` settings, or `--assistant`, `--proactive`, `--brief`.
- **Coordinator mode** — `coordinatorMode` setting or `--tasks`.
- **Voice mode** — `voiceEnabled` setting + OAuth; `/voice`.
- **Scheduled tasks** (`CronCreate`/`CronList`, `/loop`) — `scheduledTasksEnabled` setting, on by default.
- **Memory extraction** — `autoMemoryEnabled` setting.

## Configuration

The config home is `~/.freecode` (`FREECODE_CONFIG_DIR` overrides; the legacy
`CLAUDE_CONFIG_DIR` is honored as a fallback). It holds two files, and the
split is strict:

- `freecode.json` — every general setting: permissions, hooks, `env`, feature toggles like `assistant.enabled`, `voiceEnabled`, `scheduledTasksEnabled`.
- `modelSettings.json` — providers and model routing only (`providers`, `defaultModel`, `defaultSubagentModel`, `modelOverrides`, ...). Keys outside that set are dropped before validation, so a stray general key here cannot take the provider config down — and cannot shadow `freecode.json` either.

Per-project settings live in `.freecode/freecode.json` (committed, shared) and
`.freecode/freecode.local.json` (gitignored, personal). The legacy
`.claude/freecode.json` path is still read.

Precedence, lowest to highest: user → project → local → `--settings
<file-or-json>` on the command line.

## Browser session UI

```bash
./cli web start --tunnel none   # loopback only
./cli web status                # URL and tunnel state
./cli web restart               # reload after a rebuild, keeping the URL
```

The first run asks for a password without echo. Anyone holding that password can
approve a command that runs on your machine — treat it like an SSH key. The
gateway lives inside the daemon, binds `127.0.0.1`, and the tunnel is the only
public path. After a rebuild, `web restart` keeps the hostname the tunnel handed
out before, so a URL already open on a phone keeps working. A terminal session
is attachable only if its process came from a build with the webui compiled in.

By default the cloudflared tunnel is a quick tunnel: no account, a random
`*.trycloudflare.com` URL per start. To pin a hostname on your own zone, add a
`tunnel` block to `~/.freecode/freecode.json`:

```json
{
  "tunnel": {
    "provider": "cloudflare",
    "config": {
      "url": "https://code.example.com",
      "apikey": "<Cloudflare API token>",
      "accountTag": "<account id>",
      "zoneTag": "<optional; looked up from the hostname when absent>"
    }
  }
}
```

`apikey` is an API token (Bearer), not the global API key: it needs
"Cloudflare Tunnel: Edit" on the account and "DNS: Edit" on the zone (plus
"Zone: Read" if `zoneTag` is omitted). The tunnel, its DNS record and its
ingress are created or refreshed through the API on every start, and
`cloudflared tunnel run --token` serves the static URL from then on.

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

1. Read [CLAUDE.md](CLAUDE.md). It records the constraints that code alone does
   not state and that cause bugs when ignored.
2. Run `bun run typecheck` and `bun run test:unit`; run `bun run test:e2e` after
   `bun run build:dev:full`, because the e2e suite runs the compiled binary.
3. Run `bun run format`.
4. Open a pull request.

## License

The original Claude Code source is the property of Anthropic. This fork exists
because the source was exposed through their npm distribution. Use at your own
discretion.
