/**
 * tmux-based E2E Test Helpers
 *
 * Provides a TmuxSession class that manages a tmux session running the
 * interactive CLI. Tests can send keystrokes and capture screen output
 * to verify the full interactive user experience.
 *
 * The CLI runs WITHOUT --bare mode so all tools are registered naturally.
 * No special permission flags — uses the real default permission mode.
 * Test isolation is achieved through env variables:
 * - Temp CLAUDE_CONFIG_DIR and HOME (no real user config)
 * - CLAUDE_CODE_DISABLE_* flags (no background tasks, memory, etc.)
 *
 * Tmux pane output is piped to a log file and dumped on timeout for debugging.
 */

import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PROJECT_ROOT = join(import.meta.dir, '..', '..')
const CLI_BINARY = join(PROJECT_ROOT, 'cli')

// API key used in all E2E tests
const API_KEY = 'test-key-e2e-integration-99'
// Last 20 chars of the API key (normalizeApiKeyForConfig takes .slice(-20))
const TRUNCATED_KEY = 'y-e2e-integration-99'

export interface TmuxSessionOptions {
  serverUrl: string
  cwd?: string
  width?: number
  height?: number
  additionalEnv?: Record<string, string>
  /** Extra CLI args to append */
  additionalArgs?: string[]
  /**
   * Override the CLI binary path. Defaults to ./cli (the standard build).
   * Use ./cli-dev for tests that need full experimental features compiled in
   * (e.g., TRANSCRIPT_CLASSIFIER for auto-mode classifier flows).
   */
  cliBinary?: string
  /** Project-level settings to write to settings.json */
  settings?: Record<string, unknown>
  /**
   * Pre-existing config dir to reuse (skips mkdtemp and does NOT rewrite
   * .claude.json / settings.json). Used by resume/continue tests that need
   * transcript files on disk to persist across a session restart.
   */
  reuseConfigDir?: string
  /** Pre-existing HOME dir to reuse. Pairs with `reuseConfigDir`. */
  reuseHomeDir?: string
  /**
   * Override the text waitForPrompt matches on. Needed when a custom
   * `statusLine` is configured in settings — the default `? for shortcuts`
   * hint is suppressed by PromptInputFooter when a user statusline is
   * installed, so tests need a different idle marker.
   */
  readyText?: string
}

export class TmuxSession {
  private sessionName: string
  private configDir: string | null = null
  private homeDir: string | null = null
  private cwdDir: string | null = null
  private logFile: string | null = null
  private started = false
  private _serverUrl: string
  private _cwd: string
  private _useTempCwd: boolean
  private _width: number
  private _height: number
  private _additionalEnv: Record<string, string>
  private _additionalArgs: string[]
  private _settings: Record<string, unknown>
  private _reuseConfigDir?: string
  private _reuseHomeDir?: string
  private _readyText: string
  private _cliBinary: string
  /**
   * True when configDir/homeDir come from the caller (via reuseConfigDir /
   * reuseHomeDir) and must NOT be deleted by stop().
   */
  private _ownsDirs = true

  constructor(options: TmuxSessionOptions) {
    this.sessionName = `claude_e2e_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    this._serverUrl = options.serverUrl
    this._cwd = options.cwd ?? ''
    this._useTempCwd = !options.cwd
    this._width = options.width ?? 120
    this._height = options.height ?? 40
    this._additionalEnv = options.additionalEnv ?? {}
    this._additionalArgs = options.additionalArgs ?? []
    this._settings = options.settings ?? {}
    this._reuseConfigDir = options.reuseConfigDir
    this._reuseHomeDir = options.reuseHomeDir
    this._readyText = options.readyText ?? 'for shortcuts'
    this._cliBinary = options.cliBinary ?? CLI_BINARY
  }

  /** Get the temp CWD path (only valid after start()) */
  get cwd(): string {
    return this._cwd
  }

  /** Get the config dir path (only valid after start()) */
  get configDirPath(): string | null {
    return this.configDir
  }

  /**
   * Start the tmux session with the CLI running inside.
   * Pre-seeds config to skip onboarding, trust dialog, and API key approval.
   * Pipes tmux pane output to a log file for debugging.
   */
  async start(): Promise<void> {
    // Fail fast with an actionable error if tmux is missing, instead of
    // letting the eventual `waitForText` time out 30s later with no signal
    // about why. Cached at module scope — invoked exactly once per process.
    await ensureTmuxAvailable()

    // Create isolated temp dirs, or reuse caller-provided ones (used by the
    // resume/continue tests that need the transcript to survive a restart).
    if (this._reuseConfigDir) {
      this.configDir = this._reuseConfigDir
      this._ownsDirs = false
    } else {
      this.configDir = await mkdtemp(join(tmpdir(), 'claude-e2e-config-'))
    }
    if (this._reuseHomeDir) {
      this.homeDir = this._reuseHomeDir
      this._ownsDirs = false
    } else {
      this.homeDir = await mkdtemp(join(tmpdir(), 'claude-e2e-home-'))
    }
    if (this._useTempCwd) {
      this.cwdDir = await mkdtemp(join(tmpdir(), 'claude-e2e-cwd-'))
      this._cwd = this.cwdDir
    }

    this.logFile = join(this.configDir, 'tmux-output.log')

    // Pre-seed global config to skip onboarding and trust dialogs.
    const resolvedCwd = await realpath(this._cwd)
    const trustEntry = { hasTrustDialogAccepted: true }
    const projects: Record<string, { hasTrustDialogAccepted: boolean }> = {
      [this._cwd]: trustEntry,
    }
    if (resolvedCwd !== this._cwd) {
      projects[resolvedCwd] = trustEntry
    }

    const config = {
      numStartups: 10,
      hasCompletedOnboarding: true,
      theme: 'dark',
      preferredNotifChannel: 'notifications_disabled',
      verbose: false,
      autoCompactEnabled: false,
      customApiKeyResponses: {
        approved: [TRUNCATED_KEY],
        rejected: [],
      },
      projects,
    }
    await writeFile(
      join(this.configDir, '.claude.json'),
      JSON.stringify(config, null, 2),
    )

    // freecode.json — defaults to empty to prevent MCP server loading from project config.
    // Tests can pass custom settings via the `settings` option.
    // Write freecode.json (not settings.json) so the migration prompt dialog
    // does not fire at startup; the state-machine key is "freecode.json exists".
    await writeFile(
      join(this.configDir, 'freecode.json'),
      JSON.stringify(this._settings, null, 2),
    )

    // Build environment string.
    //
    // We launch the child CLI under `env -i ...` (below) so the child process
    // only sees exactly the variables listed here. Without this, host-level
    // `ANTHROPIC_*` / `CLAUDE_CODE_*` env vars leak into the child and
    // corrupt provider / tier-routing tests that rely on settings-driven
    // configuration.
    const envVars: Record<string, string> = {
      ANTHROPIC_API_KEY: API_KEY,
      ANTHROPIC_AUTH_TOKEN: '', // unset to avoid auth conflict
      ANTHROPIC_BASE_URL: this._serverUrl,
      CLAUDE_CONFIG_DIR: this.configDir,
      HOME: this.homeDir,
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
      CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
      CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING: '1',
      CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1',
      CLAUDE_CODE_DISABLE_THINKING: '1',
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
      NO_COLOR: '1',
      DO_NOT_TRACK: '1',
      NODE_ENV: 'test',
      // Enables the cross-session transcript persistence path that
      // resume-context.test.ts drives via `--continue`.
      TEST_ENABLE_SESSION_PERSISTENCE: '1',
      // Stabilizes cursor-positioning escape sequences under tmux so pane
      // captures are deterministic across hosts with different TERMs.
      TERM: process.env.TERM ?? 'screen-256color',
      PATH: process.env.PATH ?? '/usr/bin:/bin:/usr/local/bin',
      ...this._additionalEnv,
    }

    const envString = Object.entries(envVars)
      .map(([k, v]) => `${k}=${shellEscape(v)}`)
      .join(' ')

    // No --bare: all tools registered. No permission flags: real permission pipeline.
    const cliArgs = [...this._additionalArgs].join(' ')

    // Kill any existing session with this name
    await exec(`tmux kill-session -t ${this.sessionName} 2>/dev/null || true`)

    // Create the tmux session. `env -i` wipes the child env so only the keys
    // listed in `envVars` are visible to the CLI process — this is what
    // prevents host-level Anthropic env vars from polluting the test.
    const cmd = `tmux new-session -d -s ${this.sessionName} -x ${this._width} -y ${this._height} "cd ${shellEscape(this._cwd)} && env -i ${envString} ${this._cliBinary} ${cliArgs}; sleep 30"`
    await exec(cmd)

    this.started = true

    // Pipe pane output to log file for debugging
    await exec(
      `tmux pipe-pane -t ${this.sessionName} -o 'cat >> ${shellEscape(this.logFile!)}'`,
    )

    // Wait for the REPL to be ready
    await this.waitForText(this._readyText, 30_000)
  }

  /**
   * Stop the tmux session and clean up.
   *
   * Skips deletion of caller-provided reuseConfigDir / reuseHomeDir so the
   * files produced during the first run (e.g. transcript .jsonl) remain on
   * disk for a subsequent `--continue` session.
   */
  async stop(): Promise<void> {
    if (this.started) {
      await exec(`tmux kill-session -t ${this.sessionName} 2>/dev/null || true`)
      this.started = false
    }
    if (this._ownsDirs) {
      if (this.configDir) {
        await rm(this.configDir, { recursive: true, force: true }).catch(
          () => {},
        )
      }
      if (this.homeDir) {
        await rm(this.homeDir, { recursive: true, force: true }).catch(() => {})
      }
    }
    if (this.cwdDir) {
      await rm(this.cwdDir, { recursive: true, force: true }).catch(() => {})
    }
  }

  /**
   * Dump the tmux pane log to stdout for debugging.
   * Automatically called on waitForText timeout.
   */
  async dumpLog(): Promise<void> {
    if (!this.logFile) return
    try {
      const log = await Bun.file(this.logFile).text()
      // biome-ignore lint/suspicious/noConsole: intentional debug output
      console.log(
        `\n=== tmux log (${this.sessionName}) ===\n${log}\n=== end ===\n`,
      )
    } catch {
      // Log file might not exist yet
    }
  }

  // ── Input ──────────────────────────────────────────────────

  async sendKeys(keys: string): Promise<void> {
    await exec(`tmux send-keys -t ${this.sessionName} ${shellEscape(keys)}`)
  }

  async sendText(text: string): Promise<void> {
    await exec(`tmux send-keys -t ${this.sessionName} -l ${shellEscape(text)}`)
  }

  async sendLine(text: string): Promise<void> {
    await this.sendText(text)
    await exec(`tmux send-keys -t ${this.sessionName} Enter`)
  }

  async sendSpecialKey(key: string): Promise<void> {
    await exec(`tmux send-keys -t ${this.sessionName} ${key}`)
  }

  // ── Output ─────────────────────────────────────────────────

  async capturePane(): Promise<string> {
    return exec(`tmux capture-pane -t ${this.sessionName} -p`)
  }

  async capturePaneWithHistory(lines = 1000): Promise<string> {
    return exec(`tmux capture-pane -t ${this.sessionName} -p -S -${lines}`)
  }

  // ── Waiting ────────────────────────────────────────────────

  async waitForText(
    text: string,
    timeout = 30_000,
    interval = 100,
  ): Promise<string> {
    const start = Date.now()
    while (Date.now() - start < timeout) {
      const screen = await this.capturePaneWithHistory()
      if (screen.includes(text)) return screen
      await sleep(interval)
    }
    await this.dumpLog()
    const finalScreen = await this.capturePaneWithHistory()
    throw new Error(
      `Timed out waiting for text "${text}" after ${timeout}ms.\nScreen content:\n${finalScreen}`,
    )
  }

  async waitForPattern(
    pattern: RegExp,
    timeout = 30_000,
    interval = 100,
  ): Promise<{ screen: string; match: RegExpMatchArray }> {
    const start = Date.now()
    while (Date.now() - start < timeout) {
      const screen = await this.capturePaneWithHistory()
      const match = screen.match(pattern)
      if (match) return { screen, match }
      await sleep(interval)
    }
    await this.dumpLog()
    const finalScreen = await this.capturePaneWithHistory()
    throw new Error(
      `Timed out waiting for pattern ${pattern} after ${timeout}ms.\nScreen content:\n${finalScreen}`,
    )
  }

  /** Wait until the CLI is idle (ready for next input). */
  async waitForPrompt(timeout = 30_000): Promise<string> {
    return this.waitForText(this._readyText, timeout)
  }

  // ── Permission handling ────────────────────────────────────

  /**
   * Wait for either a permission dialog or the idle prompt, whichever appears first.
   * If a permission dialog appears, approve it by pressing Enter.
   * Returns 'approved' if a dialog was handled, 'idle' if the prompt returned.
   */
  async waitForPermissionOrIdle(
    timeout = 30_000,
    interval = 100,
  ): Promise<'approved' | 'idle'> {
    const start = Date.now()
    while (Date.now() - start < timeout) {
      const screen = await this.capturePaneWithHistory()
      // Check for permission dialog (various prompts)
      if (
        screen.includes('Do you want to proceed?') ||
        screen.includes('Do you want to make this edit') ||
        screen.includes('Do you want to create') ||
        screen.includes('Do you want to run') ||
        screen.includes('Do you want to allow')
      ) {
        // Press Enter to accept the default "Yes" option
        await this.sendSpecialKey('Enter')
        await sleep(300)
        return 'approved'
      }
      // Check for idle prompt
      if (screen.includes(this._readyText)) {
        return 'idle'
      }
      await sleep(interval)
    }
    await this.dumpLog()
    const finalScreen = await this.capturePaneWithHistory()
    throw new Error(
      `Timed out waiting for permission dialog or idle prompt after ${timeout}ms.\nScreen content:\n${finalScreen}`,
    )
  }

  /**
   * Submit a prompt and auto-approve any permission dialogs until the CLI
   * returns to idle. Handles both auto-approved (safe) and prompted (dangerous)
   * tool executions.
   *
   * This is the main test helper for tool-using prompts.
   *
   * @param prompt The user prompt to submit
   * @param timeout Total timeout for the entire operation
   */
  async submitAndApprove(prompt: string, timeout = 60_000): Promise<string> {
    await this.sendLine(prompt)
    await sleep(500)

    // Keep approving permission dialogs until the CLI returns to idle
    while (true) {
      const result = await this.waitForPermissionOrIdle(timeout)
      if (result === 'idle') {
        return this.capturePaneWithHistory()
      }
      // result === 'approved': loop back to check for more dialogs
    }
  }

  /**
   * Submit a prompt that expects no tool use (text-only response).
   * Just sends the prompt and waits for the idle prompt to return.
   */
  async submitAndWaitForResponse(
    prompt: string,
    timeout = 30_000,
  ): Promise<string> {
    await this.sendLine(prompt)
    await sleep(500)
    return this.waitForPrompt(timeout)
  }
}

// --- Utilities ---

function shellEscape(str: string): string {
  return "'" + str.replace(/'/g, "'\\''") + "'"
}

async function exec(cmd: string): Promise<string> {
  const proc = Bun.spawn(['bash', '-c', cmd], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  // Drain both streams concurrently. Reading both is required to avoid
  // deadlock when the child writes more than the pipe buffer to either
  // stream before we read.
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited
  if (proc.exitCode !== 0) {
    throw new Error(
      `command failed (exit ${proc.exitCode}): ${cmd}\n` +
        (stderr ? `stderr: ${stderr.trim()}\n` : '') +
        (stdout ? `stdout: ${stdout.trim()}\n` : ''),
    )
  }
  return stdout
}

/**
 * Verifies tmux is on PATH before starting any session. Throws with a
 * platform-appropriate install hint if missing — fail-fast in 50ms instead
 * of a 30s `waitForText` timeout with no actionable signal.
 *
 * Cached at module scope so a multi-test e2e run only invokes
 * `command -v tmux` once. Re-throws the cached rejection on subsequent
 * calls so every test in the run reports the same clear error.
 */
let _tmuxCheck: Promise<void> | null = null
async function ensureTmuxAvailable(): Promise<void> {
  if (!_tmuxCheck) {
    _tmuxCheck = (async () => {
      const proc = Bun.spawn(
        ['bash', '-c', 'command -v tmux >/dev/null 2>&1'],
        { stdout: 'ignore', stderr: 'ignore' },
      )
      await proc.exited
      if (proc.exitCode !== 0) {
        const hint =
          process.platform === 'darwin'
            ? 'brew install tmux'
            : process.platform === 'linux'
              ? 'apt-get install tmux  (or your distro equivalent: dnf, pacman, apk, …)'
              : 'see https://github.com/tmux/tmux'
        throw new Error(
          `E2E tests require tmux but it was not found in PATH.\n` +
            `  Install: ${hint}\n`,
        )
      }
    })()
  }
  return _tmuxCheck
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export { sleep }

/**
 * Wraps bun's `test()` to log each test name and result to stdout,
 * so output is visible when captured by non-TTY tools (e.g. CI, Bash tool).
 */
export function createLoggingTest(bunTest: typeof import('bun:test').test) {
  return function loggedTest(name: string, fn: () => Promise<void>) {
    bunTest(name, async () => {
      const start = Date.now()
      try {
        await fn()
        const elapsed = Date.now() - start
        // biome-ignore lint/suspicious/noConsole: intentional test output
        console.log(`  PASS  ${name} (${elapsed}ms)`)
      } catch (e) {
        const elapsed = Date.now() - start
        // biome-ignore lint/suspicious/noConsole: intentional test output
        console.log(`  FAIL  ${name} (${elapsed}ms)`)
        throw e
      }
    })
  }
}
