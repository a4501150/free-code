export const SKILL_MD = `---
name: verify
description: Verify a code change does what it should by running the app and exercising the behavior end-to-end.
---

# Verify

You are verifying that a specific code change produces the behavior the user
expected. This is a **functional/behavioral** check — drive the real app, observe
what happens, compare against the expected outcome. This is NOT a stand-in for
unit tests, typechecking, or linting (those belong to \`/build\` and \`/test\`).

## Goal

Produce a concrete PASS/FAIL verdict, backed by evidence (screenshots, pane
dumps, response bodies, log excerpts), for the change described by the user or
the recent conversation. If something fails, the reason must be specific enough
that the next agent can act on it without rerunning.

## Phase 1 — Discovery

1. Look for project-root verifier skills first:
   \`\`\`
   ls .claude/skills | grep -i verifier || true
   find . -maxdepth 3 -type d -name 'verifier-*' 2>/dev/null
   \`\`\`
   Each matching directory's \`SKILL.md\` is the authoritative recipe for that
   sub-project. When one clearly matches the change under test (web UI change
   → \`verifier-*-playwright\`, CLI change → \`verifier-*-cli\`, API change →
   \`verifier-*-api\`), load and follow it.

2. If no verifier skill matches, fall back to the inline defaults in Phase 2
   based on what the change touches.

3. If several verifier skills exist, pick the most specific one. When the
   change spans multiple areas (e.g. backend + frontend), run each applicable
   verifier in sequence and roll the results up.

## Phase 2 — Planning

Before driving the app, write down:

- **Change under test.** One sentence from the user's request or diff.
- **Entry point.** The exact dev server command, CLI binary, or API endpoint.
- **Ready signal.** What text/state confirms the entry point is up.
- **Steps.** An ordered list of concrete actions (click, type, curl).
- **Evidence per step.** What a passing run looks like (URL, element text,
  response status, stdout line).
- **Stop condition.** When to declare PASS vs FAIL vs inconclusive.

Present this plan and confirm before execution when the change is risky or
spans multiple sub-projects.

## Phase 3 — Execution

### Web UI (Playwright / Chrome MCP)

\`\`\`
# Start the dev server in a background shell
# Wait for the ready signal before proceeding
# Open the browser at the configured URL
# Drive the change: navigate, click, type, submit
# Capture a screenshot after each meaningful transition
\`\`\`

### CLI (Tmux)

\`\`\`
# Spawn a tmux session running the binary
# Send input; wait for prompts; capture pane dumps between steps
# Kill the session at the end
\`\`\`

### API / HTTP

\`\`\`
# Start the server in a background shell
# Hit each endpoint with curl / httpie; record status + body
# Validate each response against the expected shape
\`\`\`

## Phase 4 — Reporting

Emit a single report with this shape:

\`\`\`
Verification of: <change under test>

Step 1: <description>
  Expected: <…>
  Observed: <…>
  Result:   PASS | FAIL

Step 2: …

Summary: PASS (N/N steps) | FAIL (K of N steps failed)
Evidence: <paths to screenshots / pane dumps / logs>
\`\`\`

When the result is FAIL, include the most-specific line from logs/output that
explains why. Do not speculate about root causes beyond what the evidence
supports.

## Phase 5 — Cleanup

Always, even on failure:

- Kill dev servers and spawned processes.
- Close browser instances and tmux sessions.
- Delete temporary files created during the run.

## Phase 6 — Self-update

If verification fails because the verifier skill itself is outdated (wrong dev
server command, changed port, different ready signal, moved entry point) — not
because the feature under test is broken — offer to edit the matching
\`.claude/skills/verifier-*/SKILL.md\` file with a minimal, targeted fix.
Confirm with the user before writing.
`

export const SKILL_FILES: Record<string, string> = {
  'examples/cli.md': `# Example: verifying a CLI change with Tmux

This example shows how to verify a change to a terminal application (e.g. a
CLI binary that prints the current git branch with a custom prefix).

## Plan

- Change under test: \`status --prefix=branch:\` should print
  \`branch: <current-branch>\`.
- Entry point: \`./dist/my-cli status --prefix=branch:\`.
- Ready signal: none — the binary runs and exits.
- Steps:
  1. Build the binary.
  2. Run \`status --prefix=branch:\` in tmux.
  3. Observe stdout and exit code.
- Expected evidence: stdout contains \`branch: <branch-name>\` and exit code 0.

## Execution transcript

\`\`\`
$ bun run build
...
$ tmux new -d -s verify 'bash -c "./dist/my-cli status --prefix=branch: > /tmp/out.txt; echo EXIT=$? >> /tmp/out.txt"'
$ sleep 0.5
$ cat /tmp/out.txt
branch: trim-tool-prompt
EXIT=0
$ tmux kill-session -t verify
\`\`\`

## Report

\`\`\`
Verification of: status --prefix=branch: prints the current branch

Step 1: build
  Expected: bun run build exits 0
  Observed: exit 0, produced ./dist/my-cli
  Result:   PASS

Step 2: run status command
  Expected: stdout starts with "branch: " and exit 0
  Observed: "branch: trim-tool-prompt\\nEXIT=0"
  Result:   PASS

Summary: PASS (2/2 steps)
Evidence: /tmp/out.txt
\`\`\`
`,
  'examples/server.md': `# Example: verifying a server change with Playwright + curl

This example shows a combined HTTP + browser verification for a change that
adds a \`/api/health\` endpoint and surfaces a "healthy" badge on the
\`/status\` page.

## Plan

- Change under test: \`GET /api/health\` returns \`{ok: true}\`; \`/status\`
  page renders a green "healthy" badge when it does.
- Entry point: \`npm run dev\` on http://localhost:3000.
- Ready signal: stdout line "ready - started server on 0.0.0.0:3000".
- Steps:
  1. Start dev server in the background.
  2. curl \`/api/health\`; expect 200 + \`{"ok":true}\`.
  3. Open browser to \`/status\`; expect a visible "healthy" badge.
- Expected evidence: response body, screenshot of \`/status\` showing the
  badge.

## Execution transcript

\`\`\`
$ (npm run dev &) && tail -n0 -f nohup.out | sed '/ready - started server/q'
...
$ curl -s -o /tmp/health.json -w '%{http_code}\\n' http://localhost:3000/api/health
200
$ cat /tmp/health.json
{"ok":true}
# Browser: mcp__stealth-browser-mcp__navigate(url='http://localhost:3000/status')
# Browser: mcp__stealth-browser-mcp__take_screenshot(file_path='/tmp/status.png')
\`\`\`

## Report

\`\`\`
Verification of: /api/health endpoint + /status health badge

Step 1: GET /api/health
  Expected: 200 + {"ok":true}
  Observed: 200 + {"ok":true}
  Result:   PASS

Step 2: /status renders "healthy" badge
  Expected: green badge with text "healthy" visible in viewport
  Observed: see /tmp/status.png — badge present, text matches, color green
  Result:   PASS

Summary: PASS (2/2 steps)
Evidence: /tmp/health.json, /tmp/status.png
\`\`\`

## Cleanup

\`\`\`
$ pkill -f 'npm run dev' || true
# Close browser instance via mcp__stealth-browser-mcp__close_instance
\`\`\`
`,
}
