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
 * - Temp FREECODE_CONFIG_DIR/CLAUDE_CONFIG_DIR and HOME (no real user config)
 * - CLAUDE_CODE_DISABLE_* flags (no background tasks, memory, etc.)
 *
 * Tmux pane output is piped to a log file and dumped on timeout for debugging.
 */

import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setDefaultTimeout } from 'bun:test'
import { MODEL_SETTINGS_KEYS } from '../../src/utils/settings/modelSettingsKeys'
import { sleep, waitFor, type WaitForOptions } from '../helpers/wait-helpers'

// E2E tests run through tmux and need generous timeouts. Each test file
// should call setDefaultTimeout explicitly (bun's parallel workers don't
// reliably inherit module-level side effects). This fallback catches any
// new file that forgets.
setDefaultTimeout(120_000)

const PROJECT_ROOT = join(import.meta.dir, '..', '..')
const CLI_BINARY = join(PROJECT_ROOT, 'cli-dev')

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
   * Override the CLI binary path. Defaults to ./cli-dev (the dev-full build).
   * Use ./cli for tests that need the production feature set.
   */
  cliBinary?: string
  /** Settings to seed (model keys go to modelSettings.json, rest to freecode.json) */
  settings?: Record<string, unknown>
  /**
   * Pre-existing config dir to reuse (skips mkdtemp and does NOT rewrite
   * freecode.json). Used by resume/continue tests that need transcript
   * files on disk to persist across a session restart.
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

    // Pre-seed global config to skip trust dialogs.
    const resolvedCwd = await realpath(this._cwd)
    const trustEntry = { hasTrustDialogAccepted: true }
    const projects: Record<string, { hasTrustDialogAccepted: boolean }> = {
      [this._cwd]: trustEntry,
    }
    if (resolvedCwd !== this._cwd) {
      projects[resolvedCwd] = trustEntry
    }

    const state = {
      customApiKeyResponses: {
        approved: [TRUNCATED_KEY],
        rejected: [],
      },
      projects,
    }

    // Config is split across three files:
    //   freecode.json      — general settings (autoMode, permissions, etc.)
    //   modelSettings.json  — provider/model configuration
    //   state.json          — runtime state (trust, API key approvals, etc.)
    // Write freecode.json so the migration prompt dialog does not fire at
    // startup; the state-machine key is "freecode.json exists".
    //
    // If the test didn't provide explicit providers, auto-generate one from
    // the mock server URL so the CLI has a working provider config.
    const effectiveSettings = { ...this._settings }
    if (!effectiveSettings.providers) {
      effectiveSettings.providers = {
        'test-anthropic': {
          type: 'anthropic',
          baseUrl: this._serverUrl,
          auth: { active: 'apiKey', apiKey: { key: API_KEY } },
          models: [{ id: 'claude-sonnet-4-20250514' }],
        },
      }
      if (!effectiveSettings.defaultModel) {
        effectiveSettings.defaultModel =
          'test-anthropic:claude-sonnet-4-20250514'
      }
    }

    // Split model keys into modelSettings.json, keep the rest in freecode.json.
    const modelSettings: Record<string, unknown> = {}
    const generalSettings: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(effectiveSettings)) {
      if (MODEL_SETTINGS_KEYS.has(key)) {
        modelSettings[key] = value
      } else {
        generalSettings[key] = value
      }
    }

    await writeFile(
      join(this.configDir, 'freecode.json'),
      JSON.stringify(generalSettings, null, 2),
    )
    if (Object.keys(modelSettings).length > 0) {
      await writeFile(
        join(this.configDir, 'modelSettings.json'),
        JSON.stringify(modelSettings, null, 2),
      )
    }
    await writeFile(
      join(this.configDir, 'state.json'),
      JSON.stringify(state, null, 2),
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
      FREECODE_CONFIG_DIR: this.configDir,
      CLAUDE_CONFIG_DIR: this.configDir,
      HOME: this.homeDir,
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
      CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
      CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING: '1',
      CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1',
      CLAUDE_CODE_DISABLE_THINKING: '1',
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
      CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: '0',
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

  /**
   * Left-click at (col, row), 1-indexed like the SGR wire format.
   *
   * Press then release with no motion in between — that is what the app turns
   * into a DOM click (a drag becomes a text selection instead and suppresses
   * onClick). Sent as literal bytes because `tmux send-keys -M` forwards an
   * existing tmux mouse event rather than synthesizing one at coordinates.
   */
  async sendMouseClick(col: number, row: number): Promise<void> {
    await this.sendText(`\x1b[<0;${col};${row}M`)
    await this.sendText(`\x1b[<0;${col};${row}m`)
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
    return this.waitForScreen(screen => screen.includes(text), {
      timeoutMs: timeout,
      intervalMs: interval,
      description: `text "${text}"`,
    })
  }

  async waitForPattern(
    pattern: RegExp,
    timeout = 30_000,
    interval = 100,
  ): Promise<{ screen: string; match: RegExpMatchArray }> {
    const screen = await this.waitForScreen(
      screen => screen.match(pattern) !== null,
      {
        timeoutMs: timeout,
        intervalMs: interval,
        description: `pattern ${pattern}`,
      },
    )
    const match = screen.match(pattern)
    if (!match) {
      throw new Error(
        `Pattern ${pattern} matched during wait but not after capture`,
      )
    }
    return { screen, match }
  }

  async waitForScreen(
    predicate: (screen: string) => boolean,
    options: WaitForOptions & {
      historyLines?: number
      currentPaneOnly?: boolean
    } = {},
  ): Promise<string> {
    return waitFor(
      () =>
        options.currentPaneOnly
          ? this.capturePane()
          : this.capturePaneWithHistory(options.historyLines),
      screen => {
        detectCrash(screen)
        return predicate(screen)
      },
      {
        ...options,
        onTimeout: async () => {
          await this.dumpLog()
          const finalScreen = options.currentPaneOnly
            ? await this.capturePane()
            : await this.capturePaneWithHistory(options.historyLines)
          const extra = options.onTimeout
            ? await options.onTimeout()
            : undefined
          return [extra, `Screen content:\n${finalScreen}`]
            .filter(Boolean)
            .join('\n')
        },
      },
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
    return waitFor(
      () => this.capturePaneWithHistory(),
      screen => getPermissionOrIdleState(screen, this._readyText) !== null,
      {
        timeoutMs: timeout,
        intervalMs: interval,
        description: 'permission dialog or idle prompt',
        onTimeout: async () => {
          await this.dumpLog()
          const finalScreen = await this.capturePaneWithHistory()
          return `Screen content:\n${finalScreen}`
        },
      },
    ).then(async screen => {
      const result = getPermissionOrIdleState(screen, this._readyText)
      if (result === 'approved') {
        await this.sendSpecialKey('Enter')
        await sleep(300)
      }
      if (!result) {
        throw new Error(
          'Permission or idle state matched during wait but not after capture',
        )
      }
      return result
    })
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

export async function withTmuxSession<T>(
  options: TmuxSessionOptions,
  fn: (session: TmuxSession) => Promise<T>,
): Promise<T> {
  const session = new TmuxSession(options)
  await session.start()
  try {
    return await fn(session)
  } finally {
    await session.stop()
  }
}

function getPermissionOrIdleState(
  screen: string,
  readyText: string,
): 'approved' | 'idle' | null {
  if (
    screen.includes('Do you want to proceed?') ||
    screen.includes('Do you want to make this edit') ||
    screen.includes('Do you want to create') ||
    screen.includes('Do you want to run') ||
    screen.includes('Do you want to allow')
  ) {
    return 'approved'
  }

  if (screen.includes(readyText)) {
    return 'idle'
  }

  if (
    screen.includes('Started in background.') ||
    screen.includes('Ran 1 bash command') ||
    screen.includes('bash commands')
  ) {
    return 'idle'
  }

  return null
}

// --- Crash detection ---

const CRASH_PATTERNS = [
  /^(ReferenceError|TypeError|SyntaxError|RangeError|URIError|EvalError): .+/m,
  /\bpanic: .+/m,
  /\bSegmentation fault\b/m,
  /\bAborted \(core dumped\)\b/m,
] as const

function detectCrash(screen: string): void {
  for (const pattern of CRASH_PATTERNS) {
    const match = screen.match(pattern)
    if (match) {
      throw new Error(
        `CLI crashed during test:\n  ${match[0]}\n\nFull screen:\n${screen}`,
      )
    }
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

export { sleep }

/**
 * Coordinates of `needle` in a captured pane, in the 1-indexed form
 * sendMouseClick expects. Points at the needle itself because a click on a
 * blank cell is deliberately ignored (see ScrollBox/VirtualMessageList).
 */
export function findTextCell(
  pane: string,
  needle: string,
): { col: number; row: number } | null {
  const rows = pane.split('\n')
  for (let i = 0; i < rows.length; i++) {
    const col = rows[i]!.indexOf(needle)
    if (col === -1) continue
    return { col: col + 1, row: i + 1 }
  }
  return null
}

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
