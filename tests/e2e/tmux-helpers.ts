/**
 * tmux-based E2E Test Helpers
 *
 * Provides a TmuxSession class that manages a tmux session running the
 * interactive CLI. Tests can send keystrokes and capture screen output
 * to verify the full interactive user experience.
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
}

export class TmuxSession {
  private sessionName: string
  private configDir: string | null = null
  private homeDir: string | null = null
  private cwdDir: string | null = null // temp CWD when not specified
  private started = false
  private _serverUrl: string
  private _cwd: string
  private _useTempCwd: boolean
  private _width: number
  private _height: number
  private _additionalEnv: Record<string, string>
  private _additionalArgs: string[]

  constructor(options: TmuxSessionOptions) {
    this.sessionName = `claude_e2e_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    this._serverUrl = options.serverUrl
    this._cwd = options.cwd ?? '' // resolved in start()
    this._useTempCwd = !options.cwd
    this._width = options.width ?? 120
    this._height = options.height ?? 40
    this._additionalEnv = options.additionalEnv ?? {}
    this._additionalArgs = options.additionalArgs ?? []
  }

  /**
   * Start the tmux session with the CLI running inside.
   * Pre-seeds config to skip onboarding, trust dialog, and API key approval.
   */
  async start(): Promise<void> {
    // Create isolated temp dirs
    this.configDir = await mkdtemp(join(tmpdir(), 'claude-e2e-config-'))
    this.homeDir = await mkdtemp(join(tmpdir(), 'claude-e2e-home-'))
    if (this._useTempCwd) {
      this.cwdDir = await mkdtemp(join(tmpdir(), 'claude-e2e-cwd-'))
      this._cwd = this.cwdDir
    }

    // Pre-seed global config to skip all interactive dialogs.
    // On macOS, /var/folders is a symlink to /private/var/folders,
    // so we need to trust BOTH the symlink and resolved paths.
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

    // Build environment string
    const envVars: Record<string, string> = {
      ANTHROPIC_API_KEY: API_KEY,
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
      PATH: process.env.PATH ?? '/usr/bin:/bin:/usr/local/bin',
      ...this._additionalEnv,
    }

    const envString = Object.entries(envVars)
      .map(([k, v]) => `${k}=${shellEscape(v)}`)
      .join(' ')

    const cliArgs = ['--bare', ...this._additionalArgs].join(' ')

    // Kill any existing session with this name
    await exec(`tmux kill-session -t ${this.sessionName} 2>/dev/null || true`)

    // Create the tmux session (cd into CWD first to avoid project .claude/ interference)
    const cmd = `tmux new-session -d -s ${this.sessionName} -x ${this._width} -y ${this._height} "cd ${shellEscape(this._cwd)} && ${envString} ${CLI_BINARY} ${cliArgs}; sleep 30"`
    await exec(cmd)

    this.started = true

    // Wait for the REPL to be ready (look for the input prompt)
    await this.waitForText('for shortcuts', 15_000)
  }

  /**
   * Stop the tmux session and clean up.
   */
  async stop(): Promise<void> {
    if (this.started) {
      await exec(`tmux kill-session -t ${this.sessionName} 2>/dev/null || true`)
      this.started = false
    }
    if (this.configDir) {
      await rm(this.configDir, { recursive: true, force: true }).catch(() => {})
    }
    if (this.homeDir) {
      await rm(this.homeDir, { recursive: true, force: true }).catch(() => {})
    }
    if (this.cwdDir) {
      await rm(this.cwdDir, { recursive: true, force: true }).catch(() => {})
    }
  }

  /**
   * Send keystrokes to the tmux session.
   * Uses tmux send-keys which simulates real keyboard input.
   */
  async sendKeys(keys: string): Promise<void> {
    await exec(`tmux send-keys -t ${this.sessionName} ${shellEscape(keys)}`)
  }

  /**
   * Send a text string followed by Enter.
   * This simulates a user typing a prompt and pressing Enter.
   */
  async sendLine(text: string): Promise<void> {
    // Use send-keys with literal text then Enter
    await exec(
      `tmux send-keys -t ${this.sessionName} -l ${shellEscape(text)}`,
    )
    await exec(`tmux send-keys -t ${this.sessionName} Enter`)
  }

  /**
   * Send special keys (Enter, Escape, C-c, etc.)
   */
  async sendSpecialKey(key: string): Promise<void> {
    await exec(`tmux send-keys -t ${this.sessionName} ${key}`)
  }

  /**
   * Capture the current screen content from the tmux pane.
   * Returns all visible text on screen.
   */
  async capturePane(): Promise<string> {
    const result = await exec(
      `tmux capture-pane -t ${this.sessionName} -p`,
    )
    return result
  }

  /**
   * Capture screen and also include scrollback history.
   */
  async capturePaneWithHistory(lines = 1000): Promise<string> {
    const result = await exec(
      `tmux capture-pane -t ${this.sessionName} -p -S -${lines}`,
    )
    return result
  }

  /**
   * Wait until specific text appears on screen.
   * Polls every `interval` ms up to `timeout` ms.
   */
  async waitForText(
    text: string,
    timeout = 30_000,
    interval = 500,
  ): Promise<string> {
    const start = Date.now()
    while (Date.now() - start < timeout) {
      const screen = await this.capturePaneWithHistory()
      if (screen.includes(text)) {
        return screen
      }
      await sleep(interval)
    }
    // One final capture for the error message
    const finalScreen = await this.capturePaneWithHistory()
    throw new Error(
      `Timed out waiting for text "${text}" after ${timeout}ms.\nScreen content:\n${finalScreen}`,
    )
  }

  /**
   * Wait until a regex pattern matches the screen.
   */
  async waitForPattern(
    pattern: RegExp,
    timeout = 30_000,
    interval = 500,
  ): Promise<{ screen: string; match: RegExpMatchArray }> {
    const start = Date.now()
    while (Date.now() - start < timeout) {
      const screen = await this.capturePaneWithHistory()
      const match = screen.match(pattern)
      if (match) {
        return { screen, match }
      }
      await sleep(interval)
    }
    const finalScreen = await this.capturePaneWithHistory()
    throw new Error(
      `Timed out waiting for pattern ${pattern} after ${timeout}ms.\nScreen content:\n${finalScreen}`,
    )
  }

  /**
   * Wait until the input prompt is idle (ready for next input).
   * This indicates the CLI has finished processing and is waiting for user input.
   */
  async waitForPrompt(timeout = 30_000): Promise<string> {
    return this.waitForText('for shortcuts', timeout)
  }

  /**
   * Submit a prompt and wait for the response to complete.
   * Returns the screen content after the response is done.
   */
  async submitAndWaitForResponse(
    prompt: string,
    timeout = 30_000,
  ): Promise<string> {
    await this.sendLine(prompt)
    // Wait a moment for the CLI to start processing
    await sleep(500)
    // Wait until the prompt appears again (response is complete)
    return this.waitForPrompt(timeout)
  }
}

// --- Utilities ---

function shellEscape(str: string): string {
  // Use single quotes and escape any single quotes within
  return "'" + str.replace(/'/g, "'\\''") + "'"
}

async function exec(cmd: string): Promise<string> {
  const proc = Bun.spawn(['bash', '-c', cmd], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stdout = await new Response(proc.stdout).text()
  await proc.exited
  return stdout
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export { sleep }
