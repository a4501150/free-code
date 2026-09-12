# Feature Flags Audit

Audit date: 2026-09-12

Every subsystem that used to sit behind a compile-time flag is now compiled
into every build (`bun run build` and `bun run build:dev:full` are equivalent
feature-wise). Runtime activation is gated by CLI flags, settings, or context,
never by the build.

## Opt-in flags (4)

These remain gated by `feature(...)` and are on only when passed explicitly:
`--feature=NAME` (or `--feature NAME`).

- `BUDDY` — companion sprite, its speech-bubble notifications, and the `/buddy`
  command. The only importer of `src/buddy/` is `src/commands/buddy/buddy.ts`,
  which is not registered in `src/commands.ts`; the flag-gated modules
  (`prompt.ts`, `CompanionSprite.tsx`, `useBuddyNotification.tsx`) have no
  consumers at all. Enabling the flag currently has no effect.
- `DEDICATED_SEARCH_TOOLS` — enables dedicated search-tool behavior where
  referenced.
- `VERIFY_PLAN` — enables plan verification guidance and task/todo verification
  nudges.
- `WORKTREE_MODE` — enables worktree-mode behavior and the batch skill.

`--feature-set=dev-full` is still accepted by the build script but adds
nothing.

## Formerly-flagged subsystems (always compiled in)

Runtime activation columns state what actually controls behavior now.

| Subsystem                                                                                                                                                                                       | Runtime activation                                                                                         |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Daemon + WebUI (`src/daemon/`, `src/webui/`)                                                                                                                                                    | always on; `claude daemon`/`claude web` commands, per-session attach socket in every REPL/headless session |
| Assistant mode / proactive / brief (`src/assistant/`, `src/proactive/`, Brief/Sleep/SendUserFile/PushNotification tools, MCP channel notices)                                                   | `.freecode/agents/assistant.md`, `--assistant`, `--proactive`, `--brief`, `defaultView: 'chat'`, `/brief`  |
| Coordinator mode (`src/coordinator/`, `worker` agent, task-list automation)                                                                                                                     | `coordinatorMode` setting, `--tasks`, persisted session mode                                               |
| Voice mode                                                                                                                                                                                      | `voiceEnabled` setting + OAuth; `/voice`                                                                   |
| Scheduled tasks (`CronCreate`/`CronDelete`/`CronList`, `/loop`)                                                                                                                                 | `scheduledTasksEnabled` setting (default on)                                                               |
| Memory extraction / team memory / agent memory snapshots                                                                                                                                        | `autoMemoryEnabled`, `memoryExtraction`, project snapshot state                                            |
| Prompt cache break detection, MCP rich output, message actions, history picker, hook prompts, PowerShell auto mode, connector-text, ultrathink, streamlined output, unattended retry, hard fail | see each module; env/CLI where noted                                                                       |

## Useful entry points

- Feature-aware build logic: `scripts/build.ts`
- Feature-gated command imports: `src/commands.ts`
- Feature-gated tool imports: `src/tools.ts`
- Feature-gated CLI entry paths: `src/entrypoints/cli.tsx`
