import { feature } from 'bun:bundle'

// Bugfix for corepack auto-pinning, which adds yarnpkg to peoples' package.jsons
// eslint-disable-next-line custom-rules/no-top-level-side-effects
process.env.COREPACK_ENABLE_AUTO_PIN = '0'

import * as bg from '../cli/bg.js'
import { selfHostedRunnerMain } from '../self-hosted-runner/main.js'
import { templatesMain } from '../cli/handlers/templateJobs.js'
import { daemonMain } from '../daemon/main.js'
import { runDaemonWorker } from '../daemon/workerRegistry.js'
import { main as cliMain } from '../main.js'
import { getSystemPrompt } from '../constants/prompts.js'
import { enableConfigs } from '../utils/config.js'
import { startCapturingEarlyInput } from '../utils/earlyInput.js'
import { getMainLoopModel } from '../utils/model/model.js'
import { exitWithError } from '../utils/process.js'
import { initSinks } from '../utils/sinks.js'
import { profileCheckpoint } from '../utils/startupProfiler.js'
import { execIntoTmuxWorktree } from '../utils/worktree.js'
import { isWorktreeModeEnabled } from '../utils/worktreeModeEnabled.js'

/**
 * Bootstrap entrypoint - checks for special flags before loading the full CLI.
 * All imports are now static — the prior lazy-import scheme meant to keep
 * --version fast has been removed as part of the lazy-import elimination
 * refactor.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2)

  // Fast-path for --version/-v: zero module loading needed
  if (
    args.length === 1 &&
    (args[0] === '--version' || args[0] === '-v' || args[0] === '-V')
  ) {
    // MACRO.VERSION is inlined at build time
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log(`${MACRO.VERSION} (Claude Code)`)
    return
  }

  profileCheckpoint('cli_entry')

  // Fast-path for --dump-system-prompt: output the rendered system prompt and exit.
  // Used by prompt sensitivity evals to extract the system prompt at a specific commit.
  // Ant-only: eliminated from external builds via feature flag.
  if (feature('DUMP_SYSTEM_PROMPT') && args[0] === '--dump-system-prompt') {
    profileCheckpoint('cli_dump_system_prompt_path')
    enableConfigs()
    const modelIdx = args.indexOf('--model')
    const model = (modelIdx !== -1 && args[modelIdx + 1]) || getMainLoopModel()
    const prompt = await getSystemPrompt([], model)
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log(prompt.join('\n'))
    return
  }

  // Fast-path for `--daemon-worker=<kind>` (internal — supervisor spawns this).
  // Must come before the daemon subcommand check: spawned per-worker, so
  // perf-sensitive. No enableConfigs(), no analytics sinks at this layer —
  // workers are lean. If a worker kind needs configs/auth (assistant will),
  // it calls them inside its run() fn.
  if (feature('DAEMON') && args[0] === '--daemon-worker') {
    await runDaemonWorker(args[1])
    return
  }

  // Fast-path for `claude daemon [subcommand]`: long-running supervisor.
  if (feature('DAEMON') && args[0] === 'daemon') {
    profileCheckpoint('cli_daemon_path')
    enableConfigs()
    initSinks()
    await daemonMain(args.slice(1))
    return
  }

  // Fast-path for `claude ps|logs|attach|kill` and `--bg`/`--background`.
  // Session management against the ~/.claude/sessions/ registry.
  if (
    feature('BG_SESSIONS') &&
    (args[0] === 'ps' ||
      args[0] === 'logs' ||
      args[0] === 'attach' ||
      args[0] === 'kill' ||
      args.includes('--bg') ||
      args.includes('--background'))
  ) {
    profileCheckpoint('cli_bg_path')
    enableConfigs()
    switch (args[0]) {
      case 'ps':
        await bg.psHandler(args.slice(1))
        break
      case 'logs':
        await bg.logsHandler(args[1])
        break
      case 'attach':
        await bg.attachHandler(args[1])
        break
      case 'kill':
        await bg.killHandler(args[1])
        break
      default:
        await bg.handleBgFlag(args)
    }
    return
  }

  // Fast-path for template job commands.
  if (
    feature('TEMPLATES') &&
    (args[0] === 'new' || args[0] === 'list' || args[0] === 'reply')
  ) {
    profileCheckpoint('cli_templates_path')
    await templatesMain(args)
    // process.exit (not return) — mountFleetView's Ink TUI can leave event
    // loop handles that prevent natural exit.
    // eslint-disable-next-line custom-rules/no-process-exit
    process.exit(0)
  }

  // Fast-path for `claude self-hosted-runner`: headless self-hosted-runner
  // targeting the SelfHostedRunnerWorkerService API (register + poll; poll IS
  // heartbeat). feature() must stay inline for build-time dead code elimination.
  if (feature('SELF_HOSTED_RUNNER') && args[0] === 'self-hosted-runner') {
    profileCheckpoint('cli_self_hosted_runner_path')
    await selfHostedRunnerMain(args.slice(1))
    return
  }

  // Fast-path for --worktree --tmux: exec into tmux before loading full CLI
  const hasTmuxFlag = args.includes('--tmux') || args.includes('--tmux=classic')
  if (
    hasTmuxFlag &&
    (args.includes('-w') ||
      args.includes('--worktree') ||
      args.some(a => a.startsWith('--worktree=')))
  ) {
    profileCheckpoint('cli_tmux_worktree_fast_path')
    enableConfigs()
    if (isWorktreeModeEnabled()) {
      const result = await execIntoTmuxWorktree(args)
      if (result.handled) {
        return
      }
      // If not handled (e.g., error), fall through to normal CLI
      if (result.error) {
        exitWithError(result.error)
      }
    }
  }

  // Redirect common update flag mistakes to the update subcommand
  if (
    args.length === 1 &&
    (args[0] === '--update' || args[0] === '--upgrade')
  ) {
    process.argv = [process.argv[0]!, process.argv[1]!, 'update']
  }

  // --bare: set SIMPLE early so gates fire during module eval / commander
  // option building (not just inside the action handler).
  if (args.includes('--bare')) {
    process.env.CLAUDE_CODE_SIMPLE = '1'
  }

  // No special flags detected, load and run the full CLI
  startCapturingEarlyInput()
  profileCheckpoint('cli_before_main_import')
  profileCheckpoint('cli_after_main_import')
  await cliMain()
  profileCheckpoint('cli_after_main_complete')
}

// eslint-disable-next-line custom-rules/no-top-level-side-effects
void main()
