<p align="center">
  <img src="assets/screenshot.png" alt="free-code" width="720" />
</p>

<h1 align="center">free-code</h1>

<p align="center">
  <strong>The free build of Claude Code.</strong><br>
  All telemetry stripped. All guardrails removed. All experimental features unlocked.<br>
  One binary, zero callbacks home.
</p>

<p align="center">
  <a href="#quick-install"><img src="https://img.shields.io/badge/install-one--liner-blue?style=flat-square" alt="Install" /></a>
  <a href="https://github.com/paoloanzn/free-code/stargazers"><img src="https://img.shields.io/github/stars/paoloanzn/free-code?style=flat-square" alt="Stars" /></a>
  <a href="https://github.com/paoloanzn/free-code/issues"><img src="https://img.shields.io/github/issues/paoloanzn/free-code?style=flat-square" alt="Issues" /></a>
  <a href="https://github.com/paoloanzn/free-code/blob/main/FEATURES.md"><img src="https://img.shields.io/badge/features-66%20flags-orange?style=flat-square" alt="Feature Flags" /></a>
  <a href="#ipfs-mirror"><img src="https://img.shields.io/badge/IPFS-mirrored-teal?style=flat-square" alt="IPFS" /></a>
</p>

---

## Quick Install

```bash
curl -fsSL https://raw.githubusercontent.com/paoloanzn/free-code/main/install.sh | bash
```

Checks your system, installs Bun if needed, clones the repo, builds with all experimental features enabled, and symlinks `free-code` on your PATH.

Then run `free-code` and use the `/login` command to authenticate with your preferred model provider.

---

## Table of Contents

- [What is this](#what-is-this)
- [Model Providers](#model-providers)
- [Quick Install](#quick-install)
- [Requirements](#requirements)
- [Build](#build)
- [Usage](#usage)
- [Experimental Features](#experimental-features)
- [Project Structure](#project-structure)
- [Tech Stack](#tech-stack)
- [IPFS Mirror](#ipfs-mirror)
- [Contributing](#contributing)
- [License](#license)

---

## What is this

A clean, buildable fork of Anthropic's [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI -- the terminal-native AI coding agent. The upstream source became publicly available on March 31, 2026 through a source map exposure in the npm distribution.

This fork applies four categories of changes on top of that snapshot:

### Telemetry removed

The upstream binary phones home through OpenTelemetry/gRPC, Sentry error reporting, and custom event logging. In this build:

- All outbound telemetry endpoints are dead-code-eliminated or stubbed
- Remote feature flag system has been fully removed (all flags hardcoded or migrated to freecode.json)
- No crash reports, no usage analytics, no session fingerprinting

### Security-prompt guardrails removed

Anthropic injects system-level instructions into every conversation that constrain Claude's behavior beyond what the model itself enforces. These include hardcoded refusal patterns, injected "cyber risk" instruction blocks, and managed-settings security overlays pushed from Anthropic's servers.

This build strips those injections. The model's own safety training still applies -- this just removes the extra layer of prompt-level restrictions that the CLI wraps around it.

### React Compiler decompiled

The upstream source snapshot shipped with React Compiler output baked into every `.tsx` file — function bodies mangled with `_c()` cache arrays, `$[N]` memoization slots, and `t0` parameter renaming. This made the code nearly unreadable and uneditable.

This fork extracted the original source from inline base64 source maps embedded in each file, restoring all 517 `.tsx` files to clean, human-readable TypeScript/JSX. The React Compiler is available as an optional build step (`--react-compiler` flag) but is not used by default.

### Experimental features unlocked

Claude Code ships with 66 feature flags gated behind `bun:bundle` compile-time switches. Most are disabled in the public npm release. The `build:dev:full` build enables all 30 flags in the `fullExperimentalFeatures` set. See [Experimental Features](#experimental-features) below, or refer to [FEATURES.md](FEATURES.md) for the full audit.

---

## Model Providers

free-code supports **five API providers** out of the box. Set the corresponding environment variable to switch providers -- no code changes needed.

### Anthropic (Direct API) -- Default

Use Anthropic's first-party API directly.

| Model             | ID                  |
| ----------------- | ------------------- |
| Claude Opus 4.6   | `claude-opus-4-6`   |
| Claude Sonnet 4.6 | `claude-sonnet-4-6` |
| Claude Haiku 4.5  | `claude-haiku-4-5`  |

### OpenAI Codex

Use OpenAI's Codex models for code generation. Requires a Codex subscription.

| Model                       | ID              |
| --------------------------- | --------------- |
| GPT-5.3 Codex (recommended) | `gpt-5.3-codex` |
| GPT-5.4                     | `gpt-5.4`       |
| GPT-5.4 Mini                | `gpt-5.4-mini`  |

```bash
export CLAUDE_CODE_USE_OPENAI=1
free-code
```

### AWS Bedrock

Route requests through your AWS account via Amazon Bedrock.

```bash
export CLAUDE_CODE_USE_BEDROCK=1
export AWS_REGION="us-east-1"   # or AWS_DEFAULT_REGION
free-code
```

Uses your standard AWS credentials (environment variables, `~/.aws/config`, or IAM role). Models are mapped to Bedrock ARN format automatically (e.g., `us.anthropic.claude-opus-4-6-v1`).

| Variable                            | Purpose                           |
| ----------------------------------- | --------------------------------- |
| `CLAUDE_CODE_USE_BEDROCK`           | Enable Bedrock provider           |
| `AWS_REGION` / `AWS_DEFAULT_REGION` | AWS region (default: `us-east-1`) |
| `ANTHROPIC_BEDROCK_BASE_URL`        | Custom Bedrock endpoint           |
| `AWS_BEARER_TOKEN_BEDROCK`          | Bearer token auth                 |
| `CLAUDE_CODE_SKIP_BEDROCK_AUTH`     | Skip auth (testing)               |

### Google Cloud Vertex AI

Route requests through your GCP project via Vertex AI.

```bash
export CLAUDE_CODE_USE_VERTEX=1
free-code
```

Uses Google Cloud Application Default Credentials (`gcloud auth application-default login`). Models are mapped to Vertex format automatically (e.g., `claude-opus-4-6@latest`).

### Anthropic Foundry

Use Anthropic Foundry for dedicated deployments.

```bash
export CLAUDE_CODE_USE_FOUNDRY=1
export ANTHROPIC_FOUNDRY_API_KEY="..."
free-code
```

Supports custom deployment IDs as model names.

### Provider Selection Summary

| Provider            | Env Variable                | Auth Method                  |
| ------------------- | --------------------------- | ---------------------------- |
| Anthropic (default) | --                          | `ANTHROPIC_API_KEY` or OAuth |
| OpenAI Codex        | `CLAUDE_CODE_USE_OPENAI=1`  | OAuth via OpenAI             |
| AWS Bedrock         | `CLAUDE_CODE_USE_BEDROCK=1` | AWS credentials              |
| Google Vertex AI    | `CLAUDE_CODE_USE_VERTEX=1`  | `gcloud` ADC                 |
| Anthropic Foundry   | `CLAUDE_CODE_USE_FOUNDRY=1` | `ANTHROPIC_FOUNDRY_API_KEY`  |

---

## Requirements

- **Runtime**: [Bun](https://bun.sh) >= 1.3.11
- **OS**: macOS or Linux (Windows via WSL)
- **Auth**: An API key or OAuth login for your chosen provider

```bash
# Install Bun if you don't have it
curl -fsSL https://bun.sh/install | bash
```

---

## Build

```bash
git clone https://github.com/paoloanzn/free-code.git
cd free-code
bun install
bun run build
./cli
```

### Build Variants

| Command                  | Output               | Features                  | Description                     |
| ------------------------ | -------------------- | ------------------------- | ------------------------------- |
| `bun run build`          | `./cli`              | `VOICE_MODE` only         | Production-like binary          |
| `bun run build:dev`      | `./cli-dev`          | `VOICE_MODE` only         | Dev version stamp               |
| `bun run build:dev:full` | `./cli-dev`          | All 30 experimental flags | Full unlock build               |
| `bun run compile`        | `./dist/cli`         | `VOICE_MODE` only         | Alternative output path         |
| `bun run dev`            | _(runs from source)_ | `VOICE_MODE` only         | No compile step, slower startup |

### React Compiler (Optional)

Add `--react-compiler` to any build command to run the React Compiler pre-transform. This applies automatic memoization to `.tsx` components for potential render performance gains, but is not required — the terminal UI (Ink) is lightweight enough without it.

```bash
# Build with React Compiler memoization
bun run ./scripts/build.ts --react-compiler

# Combine with other flags
bun run ./scripts/build.ts --dev --feature-set=dev-full --react-compiler
```

The source files in `src/` are always clean, human-readable React — the compiler output goes to a temporary `.compiled-src/` directory and is never committed.

### Custom Feature Flags

Enable specific flags without the full bundle:

```bash
# Enable just ultraplan and ultrathink
bun run ./scripts/build.ts --feature=ULTRAPLAN --feature=ULTRATHINK

# Add a flag on top of the dev build
bun run ./scripts/build.ts --dev --feature=ULTRAPLAN
```

---

## Usage

```bash
# Interactive REPL (default)
./cli

# One-shot mode
./cli -p "what files are in this directory?"

# Specify a model
./cli --model claude-opus-4-6

# Run from source (slower startup)
bun run dev

# OAuth login
./cli /login
```

### Environment Variables Reference

| Variable                            | Purpose                                                          |
| ----------------------------------- | ---------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`                 | Anthropic API key                                                |
| `ANTHROPIC_AUTH_TOKEN`              | Auth token (alternative)                                         |
| `ANTHROPIC_MODEL`                   | Override default model                                           |
| `ANTHROPIC_BASE_URL`                | Custom API endpoint                                              |
| `CLAUDE_CODE_SUBAGENT_MODEL`        | Override model for all subagents (default: inherit parent model) |
| `CLAUDE_CODE_OAUTH_TOKEN`           | OAuth token via env                                              |
| `CLAUDE_CODE_API_KEY_HELPER_TTL_MS` | API key helper cache TTL                                         |

---

## Experimental Features

The `bun run build:dev:full` build enables all 30 flags in `fullExperimentalFeatures`. Highlights:

### Interaction & UI

| Flag              | Description                                                                   |
| ----------------- | ----------------------------------------------------------------------------- |
| `ULTRAPLAN`       | Multi-agent planning with Opus-class model (requires CCR, currently disabled) |
| `ULTRATHINK`      | Deep thinking mode -- type "ultrathink" to boost reasoning effort             |
| `VOICE_MODE`      | Push-to-talk voice input and dictation                                        |
| `TOKEN_BUDGET`    | Token budget tracking and usage warnings                                      |
| `HISTORY_PICKER`  | Interactive prompt history picker                                             |
| `MESSAGE_ACTIONS` | Message action entrypoints in the UI                                          |
| `QUICK_SEARCH`    | Prompt quick-search                                                           |
| `SHOT_STATS`      | Shot-distribution stats                                                       |

### Agents, Memory & Planning

| Flag                          | Description                                        |
| ----------------------------- | -------------------------------------------------- |
| `BUILTIN_EXPLORE_PLAN_AGENTS` | Built-in explore/plan agent presets                |
| `VERIFICATION_AGENT`          | Verification agent for task validation             |
| `AGENT_TRIGGERS`              | Local cron/trigger tools for background automation |
| `EXTRACT_MEMORIES`            | Post-query automatic memory extraction             |
| `COMPACTION_REMINDERS`        | Smart reminders around context compaction          |
| `CACHED_MICROCOMPACT`         | Cached microcompact state through query flows      |
| `TEAMMEM`                     | Team-memory files and watcher hooks                |

### Tools & Infrastructure

| Flag                           | Description                                    |
| ------------------------------ | ---------------------------------------------- |
| `BASH_CLASSIFIER`              | Classifier-assisted bash permission decisions  |
| `PROMPT_CACHE_BREAK_DETECTION` | Cache-break detection in compaction/query flow |

See [FEATURES.md](FEATURES.md) for the complete audit of all 66 flags, including broken flags with reconstruction notes.

---

## Project Structure

```
scripts/
  build.ts                # Build script with feature flag system

src/
  entrypoints/cli.tsx     # CLI entrypoint
  commands.ts             # Command registry (slash commands)
  tools.ts                # Tool registry (agent tools)
  QueryEngine.ts          # LLM query engine
  screens/REPL.tsx        # Main interactive UI (Ink/React)

  commands/               # /slash command implementations
  tools/                  # Agent tool implementations (Bash, Read, Edit, etc.)
  components/             # Ink/React terminal UI components
  hooks/                  # React hooks
  services/               # API clients, MCP, OAuth, analytics
    api/                  # API client + Codex fetch adapter
    oauth/                # OAuth flows (Anthropic + OpenAI)
  state/                  # App state store
  utils/                  # Utilities
    model/                # Model configs, providers, validation
  skills/                 # Skill system
  plugins/                # Plugin system
  voice/                  # Voice input
  tasks/                  # Background task management
```

---

## Tech Stack

|                       |                                                                 |
| --------------------- | --------------------------------------------------------------- |
| **Runtime**           | [Bun](https://bun.sh)                                           |
| **Language**          | TypeScript                                                      |
| **Terminal UI**       | React + [Ink](https://github.com/vadimdemedes/ink)              |
| **CLI Parsing**       | [Commander.js](https://github.com/tj/commander.js)              |
| **Schema Validation** | Zod v4                                                          |
| **Code Search**       | ripgrep (bundled)                                               |
| **Protocols**         | MCP, LSP                                                        |
| **APIs**              | Anthropic Messages, OpenAI Codex, AWS Bedrock, Google Vertex AI |

---

## IPFS Mirror

A full copy of this repository is permanently pinned on IPFS via Filecoin:

|             |                                                                                   |
| ----------- | --------------------------------------------------------------------------------- |
| **CID**     | `bafybeiegvef3dt24n2znnnmzcud2vxat7y7rl5ikz7y7yoglxappim54bm`                     |
| **Gateway** | https://w3s.link/ipfs/bafybeiegvef3dt24n2znnnmzcud2vxat7y7rl5ikz7y7yoglxappim54bm |

If this repo gets taken down, the code lives on.

---

## Contributing

Contributions are welcome. If you're working on restoring one of the broken feature flags, check the reconstruction notes in [FEATURES.md](FEATURES.md) first -- many are close to compiling and just need a small wrapper or missing asset.

1. Fork the repository
2. Create a feature branch (`git checkout -b feat/my-feature`)
3. Commit your changes (`git commit -m 'feat: add something'`)
4. Push to the branch (`git push origin feat/my-feature`)
5. Open a Pull Request

---

## License

The original Claude Code source is the property of Anthropic. This fork exists because the source was publicly exposed through their npm distribution. Use at your own discretion.
