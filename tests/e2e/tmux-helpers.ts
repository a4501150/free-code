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
 * - Seeded freecode.json (memory, checkpointing, auto-connect and friends
 *   are off via settings keys, not env flags)
 *
 * Tmux pane output is piped to a log file: waitForText/waitForPattern poll
 * its (ANSI-stripped) tail — an in-process file read — while screen-shape
 * and state assertions use capture-pane. The full log is dumped on timeout
 * for debugging.
 */

import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, setDefaultTimeout } from 'bun:test'
import { MODEL_SETTINGS_KEYS } from '../../src/utils/settings/modelSettingsKeys'
import { MockAnthropicServer } from '../helpers/mock-server'
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
  /**
   * Launch on the hosted path (wire viewer over an in-process sessiond),
   * the default `claude` startup. Without this the harness injects
   * `--classic` so REPL-pixel assertions keep exercising the in-process
   * screen they were written against.
   */
  hostedTui?: boolean
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
  private _hostedTui: boolean
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
    // The hosted cutover made the wire viewer the default startup; pane
    // assertions written against the in-process REPL opt into `--classic`
    // by default here. A leading subcommand (attach, web, doctor…) is left
    // alone — hosted/classic is a REPL-path fork, not a subcommand flag.
    // E2E_MODE=hosted flips the default for every file unchanged — the
    // dual-mode matrix runs the same scenarios against the hosted viewer.
    this._hostedTui = options.hostedTui ?? process.env.E2E_MODE === 'hosted'
    const extraArgs = options.additionalArgs ?? []
    this._additionalArgs =
      !this._hostedTui && (extraArgs[0]?.startsWith('-') ?? true)
        ? ['--classic', ...extraArgs]
        : extraArgs
    // Without an explicit statusLine, the embedded default script runs, which
    // suppresses the `? for shortcuts` hint that readyText matches by default.
    // Default-seeded settings; caller options.settings wins (spread after).
    this._settings = {
      statusLine: { type: 'off' },
      backgroundTasksEnabled: false,
      autoMemoryEnabled: false,
      claudeMdEnabled: false,
      promptSuggestionEnabled: false,
      fileCheckpointingEnabled: false,
      thinkingEnabled: false,
      terminalTitleEnabled: false,
      ...options.settings,
    }
    this._reuseConfigDir = options.reuseConfigDir
    this._reuseHomeDir = options.reuseHomeDir
    // Pane-parity made the hosted viewer's idle footer the classic's
    // `? for shortcuts`, so both paths can wait on the same marker.
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

    // The log name is unique per session: resume tests reuse the config dir
    // across sessions, and a shared name would append to the previous
    // session's log — whose stale frames contain readyText, making the
    // log-based ready-wait match before the new CLI has even booted.
    this.logFile = join(this.configDir, `tmux-output-${this.sessionName}.log`)

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

    // The assistant is default-on for the gateway; e2e homes opt out unless
    // a test enables it explicitly — an unrequested assistant child adds a
    // session row and writes its resume pointer into the temp config home.
    if (effectiveSettings.assistant === undefined) {
      effectiveSettings.assistant = { enabled: false }
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

    // Kill any existing session with this name (name collisions from a
    // previous run are tolerated)
    await runTmux(['kill-session', '-t', this.sessionName], {
      tolerateFailure: true,
    })

    // Create the tmux session. `env -i` wipes the child env so only the keys
    // listed in `envVars` are visible to the CLI process — this is what
    // prevents host-level Anthropic env vars from polluting the test.
    // The pane command is one argv element; tmux itself runs it via sh -c.
    const paneCommand = `cd ${shellEscape(this._cwd)} && env -i ${envString} ${this._cliBinary} ${cliArgs}; sleep 30`
    await runTmux([
      'new-session',
      '-d',
      '-s',
      this.sessionName,
      '-x',
      String(this._width),
      '-y',
      String(this._height),
      paneCommand,
    ])

    this.started = true

    // Pipe pane output to log file — the tail is what waitForText/waitForPattern
    // poll, and the full file is dumped when a wait times out.
    await runTmux([
      'pipe-pane',
      '-t',
      this.sessionName,
      '-o',
      `cat >> ${shellEscape(this.logFile!)}`,
    ])

    // Wait for the REPL to be ready. Generous timeout: under parallel
    // e2e runs the compiled CLI can take a while to boot under CPU
    // contention.
    await this.waitForText(this._readyText, 60_000)
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
      // tmux kill-session only SIGHUPs the pane's process group, and the CLI
      // neither treats SIGHUP as fatal nor drops an in-flight turn — a
      // lingering turn keeps firing requests into the shared mock server and
      // poisons the next test's FIFO queue. Hard-kill the pane's process
      // group (the pane command runs as its own group leader).
      let panePids: string[] = []
      try {
        const out = await runTmux([
          'list-panes',
          '-t',
          this.sessionName,
          '-F',
          '#{pane_pid}',
        ])
        panePids = out.trim().split('\n').filter(Boolean)
      } catch {
        // Session already gone — nothing to escalate.
      }
      await runTmux(['kill-session', '-t', this.sessionName], {
        tolerateFailure: true,
      })
      for (const pid of panePids) {
        await killGroup(pid)
      }
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
    await runTmux(['send-keys', '-t', this.sessionName, keys])
  }

  async sendText(text: string): Promise<void> {
    await runTmux(['send-keys', '-t', this.sessionName, '-l', text])
  }

  async sendLine(text: string): Promise<void> {
    await this.sendText(text)
    await this.sendSpecialKey('Enter')
  }

  async sendSpecialKey(key: string): Promise<void> {
    await runTmux(['send-keys', '-t', this.sessionName, key])
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

  /**
   * Scroll the wheel `count` times at (col, row), 1-indexed like SGR.
   *
   * Button 64 is wheel-up, 65 is wheel-down. A wheel event is a press with no
   * release, so only one byte sequence per notch.
   */
  async sendMouseWheel(
    direction: 'up' | 'down',
    col: number,
    row: number,
    count = 1,
  ): Promise<void> {
    const button = direction === 'up' ? 64 : 65
    for (let i = 0; i < count; i++) {
      await this.sendText(`\x1b[<${button};${col};${row}M`)
    }
  }

  // ── Output ─────────────────────────────────────────────────

  async capturePane(): Promise<string> {
    return runTmux(['capture-pane', '-t', this.sessionName, '-p'])
  }

  /** ANSI-sensitive capture (-e keeps SGR escapes): text-only captures
   *  cannot see color/attribute differences, which are parity bugs too. */
  async capturePaneAnsi(): Promise<string> {
    return exec(`tmux capture-pane -t ${this.sessionName} -p -e`)
  }

  async capturePaneWithHistory(lines = 1000): Promise<string> {
    return runTmux([
      'capture-pane',
      '-t',
      this.sessionName,
      '-p',
      '-S',
      `-${lines}`,
    ])
  }

  // ── Waiting ────────────────────────────────────────────────

  /**
   * Last LOG_TAIL_BYTES of the pane log, ANSI-stripped. This is the raw byte
   * stream (including intermediate in-place frames), so it is only used for
   * "did this text get rendered" checks — never for screen-shape or state
   * assertions, which must use capturePane/waitForScreen.
   */
  private async readLogTail(): Promise<string> {
    if (!this.logFile) {
      throw new Error('Session not started — no pane log yet')
    }
    try {
      const file = Bun.file(this.logFile)
      const size = file.size
      if (size === 0) return ''
      const start = Math.max(0, size - LOG_TAIL_BYTES)
      return stripAnsi(await file.slice(start).text())
    } catch {
      // Log file not created yet (nothing rendered)
      return ''
    }
  }

  /**
   * Wait for text to appear in the rendered output. Polls the pane log tail
   * (already piped by start()) instead of spawning capture-pane — an
   * in-process file read per poll rather than two process spawns. Crash
   * detection runs on the stripped tail: a panic that scrolled out of the
   * visible pane still lands in the log.
   */
  async waitForText(
    text: string,
    timeout = 30_000,
    interval = 50,
  ): Promise<string> {
    return waitFor(
      () => this.readLogTail(),
      tail => {
        detectCrash(tail)
        return tail.includes(text)
      },
      {
        timeoutMs: timeout,
        intervalMs: interval,
        description: `text "${text}"`,
        onTimeout: async () => {
          await this.dumpLog()
          const tail = await this.readLogTail().catch(() => '')
          return `Recent pane output:\n${tail}`
        },
      },
    )
  }

  async waitForPattern(
    pattern: RegExp,
    timeout = 30_000,
    interval = 50,
  ): Promise<{ screen: string; match: RegExpMatchArray }> {
    const screen = await waitFor(
      () => this.readLogTail(),
      tail => {
        detectCrash(tail)
        return tail.match(pattern) !== null
      },
      {
        timeoutMs: timeout,
        intervalMs: interval,
        description: `pattern ${pattern}`,
        onTimeout: async () => {
          await this.dumpLog()
          const tail = await this.readLogTail().catch(() => '')
          return `Recent pane output:\n${tail}`
        },
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

  /**
   * Wait until the CLI is idle (ready for next input).
   *
   * Pane-based, NOT log-based: the readyText footer is re-emitted to the raw
   * stream on every idle render since the session's first frame, so the log
   * tail always contains it — only the live pane shows whether the CLI is
   * idle *right now*.
   */
  async waitForPrompt(timeout = 30_000): Promise<string> {
    return this.waitForScreen(screen => screen.includes(this._readyText), {
      timeoutMs: timeout,
      intervalMs: 50,
      description: 'idle prompt',
    })
  }

  // ── Permission handling ────────────────────────────────────

  /**
   * Wait for either a permission dialog or the idle prompt, whichever appears
   * first. If a permission dialog appears, approve it by pressing Enter and
   * then wait for the pane to change before returning, so a caller that
   * loops back into this method cannot re-match the dialog it just approved.
   * Returns 'approved' if a dialog was handled, 'idle' if the prompt returned.
   *
   * Polls the CURRENT pane only, never history: summary lines like
   * "Ran 1 bash command" from earlier turns stay in scrollback, and matching
   * them there reports a busy CLI as idle mid-chain.
   *
   * An idle report is debounced: the CLI renders an idle-looking frame in
   * the gap between a tool result and the next turn's busy frame (no footer
   * once the spinner takes over), so 'idle' is only returned once it holds
   * across ~150ms of consecutive frames. Any dialog or busy frame during
   * that window resumes the wait instead.
   */
  async waitForPermissionOrIdle(
    timeout = 30_000,
    interval = 50,
  ): Promise<'approved' | 'idle'> {
    const deadline = Date.now() + timeout
    for (;;) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        await this.dumpLog()
        throw new Error(
          `Timed out waiting for permission dialog or idle prompt after ${timeout}ms.\nScreen content:\n${await this.capturePane()}`,
        )
      }
      const screen = await waitFor(
        () => this.capturePane(),
        screen => getPermissionOrIdleState(screen, this._readyText) !== null,
        {
          timeoutMs: remaining,
          intervalMs: interval,
          description: 'permission dialog or idle prompt',
          onTimeout: async () => {
            await this.dumpLog()
            const finalScreen = await this.capturePane()
            return `Screen content:\n${finalScreen}`
          },
        },
      )
      const result = getPermissionOrIdleState(screen, this._readyText)
      if (result === null) {
        throw new Error(
          'Permission or idle state matched during wait but not after capture',
        )
      }
      if (result === 'approved') {
        await this.waitForPaneChangeAfter('approval Enter', remaining)
        continue
      }
      // result === 'idle': debounce before reporting it (see docstring).
      let idleSince = Date.now()
      for (;;) {
        await sleep(50)
        const recheck = getPermissionOrIdleState(
          await this.capturePane(),
          this._readyText,
        )
        if (recheck !== 'idle') {
          // Transient idle frame — the turn resumed (busy or a new dialog).
          break
        }
        if (Date.now() - idleSince >= 150) {
          return 'idle'
        }
        if (Date.now() >= deadline) {
          return 'idle'
        }
      }
    }
  }

  /**
   * Press Enter on whatever is showing and wait until the current pane
   * leaves the exact pre-Enter state. Any processed Enter produces a
   * re-render (dialog collapse, busy frame, response), so this replaces the
   * old fixed sleep and cannot fire early on a stale frame.
   */
  private async waitForPaneChangeAfter(
    description: string,
    timeout = 30_000,
  ): Promise<void> {
    const before = await this.capturePane()
    await this.sendSpecialKey('Enter')
    await this.waitForScreen(screen => screen !== before, {
      currentPaneOnly: true,
      timeoutMs: timeout,
      intervalMs: 25,
      description: `${description} to take effect`,
    })
  }

  /**
   * Send a key and wait until the pane leaves the exact pre-key state —
   * the event-driven replacement for fixed pacing sleeps between navigation
   * keystrokes (PageUp/PageDown/arrow keys). Any processed key that alters
   * the screen re-renders, so this fires as soon as the key took effect.
   * Throws on timeout, so only use it for keys expected to change the
   * screen; a key the UI ignores (e.g. scrolling past the top) would hang
   * until the timeout.
   */
  async sendKeyAndAwaitRender(key: string, timeout = 10_000): Promise<void> {
    const before = await this.capturePane()
    await this.sendSpecialKey(key)
    await this.waitForScreen(screen => screen !== before, {
      currentPaneOnly: true,
      timeoutMs: timeout,
      intervalMs: 25,
      description: `key ${key} to take effect`,
    })
  }

  /**
   * Submit a prompt and auto-approve any permission dialogs until the CLI
   * returns to idle. Handles both auto-approved (safe) and prompted
   * (dangerous) tool executions.
   *
   * Sleep-free: submission is detected by waiting for the pane to leave the
   * pre-submit snapshot (the input line clears, so a completed turn can
   * never look like the snapshot) instead of a fixed delay.
   *
   * This is the main test helper for tool-using prompts.
   *
   * @param prompt The user prompt to submit
   * @param timeout Total timeout for the entire operation
   */
  async submitAndApprove(prompt: string, timeout = 60_000): Promise<string> {
    await this.submitPrompt(prompt)

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
   * Type a prompt, wait for the input line to actually show it, then submit
   * and wait for the submission to take effect. Two snapshots bound each
   * transition:
   *
   *  1. `pre` (before typing) — the echo wait ends when the pane leaves the
   *     pre-typing state; Enter is not sent until then, so the CLI cannot
   *     have processed it early.
   *  2. `typed` (with the prompt in the input line) — the submit wait ends
   *     when the pane leaves that state. Submitting always clears the input
   *     line, so even a turn that completes between polls leaves a pane
   *     different from `typed`. This is what prevents the first
   *     permission-or-idle poll from matching the stale idle footer before
   *     the turn has started (the reason the old code slept 500ms).
   */
  private async submitPrompt(prompt: string): Promise<void> {
    const pre = await this.capturePane()
    await this.sendText(prompt)
    await this.waitForScreen(screen => screen !== pre, {
      currentPaneOnly: true,
      timeoutMs: 10_000,
      intervalMs: 25,
      description: 'typed prompt to be echoed',
    })
    const typed = await this.capturePane()
    await this.sendSpecialKey('Enter')
    await this.waitForScreen(screen => screen !== typed, {
      currentPaneOnly: true,
      timeoutMs: 10_000,
      intervalMs: 25,
      description: 'prompt submission to take effect',
    })
  }

  /**
   * Submit a prompt that expects no tool use (text-only response).
   * Just sends the prompt and waits for the idle prompt to return.
   */
  async submitAndWaitForResponse(
    prompt: string,
    timeout = 30_000,
  ): Promise<string> {
    await this.submitPrompt(prompt)
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

/**
 * Standard e2e file wiring, replacing the beforeAll/afterAll/afterEach
 * prologue repeated in every suite: one mock Anthropic server for the file,
 * plus session tracking — every session started via startSession() is
 * stopped in afterEach, even when a test fails mid-way, and a test may
 * start several sessions.
 *
 * Must be called synchronously inside describe() so the hooks register on
 * that suite. Files needing extra mock servers (OpenAI, Codex) own those in
 * their own beforeAll/afterAll and pass the URL via startSession's
 * serverUrl override or the TmuxSession settings.
 */
export function setupE2ESuite(): {
  server: MockAnthropicServer
  startSession: (
    options?: Omit<TmuxSessionOptions, 'serverUrl'> & { serverUrl?: string },
  ) => Promise<TmuxSession>
} {
  const server = new MockAnthropicServer()
  const sessions: TmuxSession[] = []
  beforeAll(async () => {
    await server.start()
  })
  afterAll(() => {
    server.stop()
  })
  afterEach(async () => {
    await Promise.all(sessions.splice(0).map(session => session.stop()))
  })
  return {
    server,
    async startSession(options = {}) {
      const { serverUrl, ...rest } = options
      const session = new TmuxSession({
        ...rest,
        serverUrl: serverUrl ?? server.url,
      })
      sessions.push(session)
      await session.start()
      return session
    },
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
    screen.includes('bash commands') ||
    // A live/pinned monitor replaces the `for shortcuts` hint with the
    // task pill, so an otherwise-idle CLI with a monitor never matches
    // readyText — the pill itself is the idle marker.
    screen.includes('monitor · ↓ to manage')
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

/**
 * Run tmux with an argv array — no shell involved. Every keystroke and
 * screen poll goes through here (the hottest spawn path in the suite), and
 * skipping the `bash -c` wrapper halves the per-call cost (~27ms → ~14ms).
 */
async function runTmux(
  args: string[],
  opts: { tolerateFailure?: boolean } = {},
): Promise<string> {
  const proc = Bun.spawn(['tmux', ...args], { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited
  if (proc.exitCode !== 0 && !opts.tolerateFailure) {
    throw new Error(
      `tmux ${args.join(' ')} failed (exit ${proc.exitCode}): ${stderr.trim()}`,
    )
  }
  return stdout
}

/**
 * Hard-kill a process group (negative pid). Failure means it is already
 * gone — tolerated by design.
 */
async function killGroup(pid: string): Promise<void> {
  const proc = Bun.spawn(['kill', '-KILL', `-${pid}`], {
    stdout: 'ignore',
    stderr: 'ignore',
  })
  await proc.exited
}

/**
 * Strip ANSI escape sequences (SGR, cursor movement, OSC, charset) from raw
 * pane output. Sequences can sit mid-word, so the stripped stream reassembles
 * the visible text.
 */
const ANSI_PATTERN = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g
function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '')
}

/**
 * How many bytes of the pane log waitForText/waitForPattern consider "recent".
 * Comparable to the old 1000-line history window (~120KB); deliberately
 * generous so text rendered a few turns ago still matches.
 */
const LOG_TAIL_BYTES = 256 * 1024

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
      if (!Bun.which('tmux')) {
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
