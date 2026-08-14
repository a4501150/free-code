import { feature } from 'bun:bundle'

// Bugfix for corepack auto-pinning, which adds yarnpkg to peoples' package.jsons
// eslint-disable-next-line custom-rules/no-top-level-side-effects
process.env.COREPACK_ENABLE_AUTO_PIN = '0'

import { daemonMain } from '../daemon/main.js'
import { runDaemonWorker } from '../daemon/workerRegistry.js'
import { main as cliMain } from '../main.js'
import { setIsInteractive } from '../bootstrap/state.js'
import { getSystemPrompt } from '../constants/prompts.js'
import { getAllBaseTools } from '../tools.js'
import { withAgenticSystemPromptInvariants } from '../utils/agenticSystemPrompt.js'
import { asSystemPrompt } from '../utils/systemPromptType.js'
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
    // Render the interactive REPL variant: the session-specific guidance and
    // tool sections branch on these, and the default state is non-interactive
    // with no tools, which silently drops them from the dump.
    setIsInteractive(true)
    const modelIdx = args.indexOf('--model')
    const model = (modelIdx !== -1 && args[modelIdx + 1]) || getMainLoopModel()
    const prompt = await getSystemPrompt(getAllBaseTools(), model)
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log(
      withAgenticSystemPromptInvariants(asSystemPrompt(prompt)).join('\n'),
    )
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

  // `claude daemon` and `claude web` are one command when the WebUI is in the
  // build: the supervisor exists to host the server, so starting one without
  // the other is never what anyone wants. A WEBUI-off build has no gateway to
  // run, so `daemon` keeps its own bare lifecycle there.
  if (feature('DAEMON') && args[0] === 'daemon') {
    profileCheckpoint('cli_daemon_path')
    enableConfigs()
    initSinks()
    if (feature('WEBUI')) {
      const { webMain } = await import('../webui/cli.js')
      await webMain(args.slice(1))
    } else {
      await daemonMain(args.slice(1))
    }
    return
  }

  // Phase 0 gate for the WebUI: verifies the embedded client, the loopback
  // server, the WebSocket upgrade and the attach socket inside the compiled
  // binary. Dynamically imported so a WEBUI-off build never pulls the server
  // graph in.
  if (feature('WEBUI') && args[0] === '--webui-smoke') {
    const { runWebuiSmoke } = await import('../webui/smoke.js')
    process.exitCode = await runWebuiSmoke()
    return
  }

  // Fast-path for `claude web [subcommand]`: talks to the daemon supervisor,
  // which hosts the server so it outlives this terminal.
  if (feature('WEBUI') && args[0] === 'web') {
    profileCheckpoint('cli_web_path')
    enableConfigs()
    const { webMain } = await import('../webui/cli.js')
    await webMain(args.slice(1))
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
