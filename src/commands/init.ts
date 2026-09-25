import type { Command } from '../commands.js'
import { maybeMarkProjectOnboardingComplete } from '../projectOnboardingState.js'

const INIT_PROMPT = `Analyze this codebase and write an AGENTS.md file that future instances of Claude Code (and any other coding agent reading the repo) working in this repository will read.

The one design rule: AGENTS.md contains only facts the agent cannot reliably infer from the repo — put it another way, keep only what its absence would turn into an error or a silent bug. The file is injected into every session, so keep it short, and prefer exact commands and hard constraints over architecture essays. Anything a future instance can figure out on its own goes stale and wastes context.

What can earn a place (include only categories with real findings):
1. One or two sentences of purpose, plus the boundaries that are expensive to get wrong — the "big picture" a future instance cannot get from reading any single file (e.g., "the upload service reads files raw; do not go through the API layer").
2. Copy-pasteable commands with flags: install, dev, build, lint, typecheck, running a single test. Map each package manager or tool to its corresponding commands (npm, pnpm, yarn, bun, cargo, make, etc.). Example: \`pnpm test -- path/to/file\`, not "use the test suite".
3. Non-obvious tool choices, only when several options look plausible (pnpm not npm, Python 3.12, uv, podman).
4. Hard never/always rules: "never edit generated/", "never commit .env", "ask before running migrations or deploys", "don't claim tests passed unless you ran them".
5. Pointers, not dumps: "Frontend rules: packages/web/AGENTS.md. Data model: docs/data-model.md." — or \`@path/to/import\` to pull a file in on demand instead of inlining it.

Where to look:
- Commands used more than once, such as how to build, lint, and run tests. Include how to run a single test.
- Read the CI configuration and note the commands it runs — those are authoritative.
- For monorepos, note the workspace layout and per-package commands.
- List every Makefile target, not just the obvious ones.
- Mention real-world use cases only when genuinely non-obvious.
- If there are Cursor rules (in .cursor/rules/ or .cursorrules), GitHub Copilot rules (in .github/copilot-instructions.md), existing .freecode/rules/ (or legacy .claude/rules/), or similar from other assistants, include the important parts.

What to cut:
- Obvious instructions like "Provide helpful error messages to users", "Write unit tests for all new utilities", or "Never include sensitive information (API keys, tokens) in code or commits".
- File-by-file structure or component lists that can be easily discovered.
- Generic development practices.
- Commands obvious from manifest files (a standard "npm test", "cargo test", "pytest").
- Details that change frequently — point at the source or \`@path/to/import\` it so the future instance always reads the current version.
- Do not make up sections such as "Project Overview", "Project Administration", "Testing Procedures", "Tips for Development", "Support and Documentation" unless expressly present in another file you read.

Usage notes:
- Check first whether AGENTS.md and/or CLAUDE.md already exist at the repo root. Either way, AGENTS.md is the final home for the content:
  - If neither exists, write the new file to AGENTS.md.
  - If one or both exist, read what is there first, suggest improvements to it — fill in the missing pieces, flag what is outdated or bloated, and do not repeat what is already there — and write the single improved result to AGENTS.md. If CLAUDE.md is a real file, fold the important parts of its content in too.
  - If the existing file is just a stub pointing at other files, only improve those target files.
- When the content is final, make CLAUDE.md a relative symlink pointing at AGENTS.md by running \`ln -sf AGENTS.md CLAUDE.md\` in the repo root (skip if CLAUDE.md is already that symlink). Never leave CLAUDE.md as a second copy of the content. If symlinks are unsupported on this platform, instead write CLAUDE.md containing exactly one line: \`@AGENTS.md\`.
- Be specific: "Use 2-space indentation in TypeScript" is better than "Format code properly."
- Be sure to prefix the file with the following text:

\`\`\`
# AGENTS.md

This file provides guidance to AI coding agents (including Claude Code) when working with code in this repository.
\`\`\``

const command = {
  type: 'prompt',
  name: 'init',
  get description() {
    return 'Initialize a new AGENTS.md file with codebase documentation (CLAUDE.md becomes a symlink to it)'
  },
  contentLength: 0, // Dynamic content
  progressMessage: 'analyzing your codebase',
  source: 'builtin',
  async getPromptForCommand() {
    maybeMarkProjectOnboardingComplete()

    return [
      {
        type: 'text',
        text: INIT_PROMPT,
      },
    ]
  },
} satisfies Command

export default command
