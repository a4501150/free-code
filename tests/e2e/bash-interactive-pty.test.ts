/**
 * Interactive PTY e2e for bash-mode `!` commands.
 *
 * Every `!` command runs under a PTY (controlling tty) feeding a headless
 * xterm emulator, so password-style prompts work: the pane must show the
 * boxed terminal panel with the child's `read -s` prompt rendered through
 * the VT screen, typed keystrokes must reach the child through the panel,
 * and the finished transcript must carry the CRLF-normalized output.
 * Escape must tree-kill a stuck interactive run.
 */

import { describe, test as bunTest, expect, setDefaultTimeout } from 'bun:test'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { TmuxSession, createLoggingTest, setupE2ESuite } from './tmux-helpers'

setDefaultTimeout(120_000)
const test = createLoggingTest(bunTest)

/**
 * Bash-mode lines are sent as text + settle + Enter, NOT sendLine: a
 * multi-char insertion that starts with `!` takes the mode-switch branch in
 * PromptInput (onModeChange + buffer push + set), and an Enter arriving on
 * the heels of that batch (sendLine waits 150ms) can land before the submit
 * path sees the committed state, leaving the line stuck. 400ms is the
 * settle the pane probes were verified against.
 */
async function sendBashLine(session: TmuxSession, line: string): Promise<void> {
  await session.sendText(line)
  await new Promise(r => setTimeout(r, 400))
  await session.sendSpecialKey('Enter')
}

/** The session transcript that recorded one of this suite's commands. */
async function findTranscript(
  configDir: string | null,
  marker: string,
): Promise<string> {
  if (!configDir) throw new Error('no configDir')
  const projectsDir = join(configDir, 'projects')
  const dirs = await readdir(projectsDir, { withFileTypes: true })
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue
    const files = await readdir(join(projectsDir, dir.name))
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue
      const path = join(projectsDir, dir.name, file)
      const text = await readFile(path, 'utf-8').catch(() => '')
      if (text.includes(marker)) return path
    }
  }
  throw new Error(`no transcript containing ${JSON.stringify(marker)}`)
}

describe('Bash interactive PTY', () => {
  const { server, startSession } = setupE2ESuite()
  let session: TmuxSession

  test('a password prompt under `!` is visible, answerable, and recorded', async () => {
    session = await startSession()
    server.reset([])

    await sendBashLine(
      session,
      `! bash -c 'read -s -p "Pass: " p; echo "got $p"'`,
    )

    // Wait for the panel to mount BEFORE matching the prompt: 'Pass:'
    // alone can match the command text in the pane from submit time, and
    // keys typed before the panel's useInput mounts are lost. The boxed
    // border is the panel's stable marker.
    await session.waitForScreen(
      screen => screen.includes('╭') && screen.includes('Esc kill'),
      { description: 'interactive panel mounted', timeoutMs: 30_000 },
    )
    // The child's prompt must render in the VT screen before we type.
    await session.waitForScreen(screen => screen.includes('Pass:'), {
      description: 'read -s prompt visible',
      timeoutMs: 30_000,
    })

    // Typed keys must go to the child, not the (hidden) input box.
    await session.sendText('hunter2')
    await session.sendSpecialKey('Enter')

    await session.waitForScreen(screen => screen.includes('exit 0'), {
      description: 'command completed after the typed password',
      timeoutMs: 30_000,
    })

    // The transcript records the run with CRLF normalized to LF. The
    // capture file keeps the raw CRLF bytes — the WebUI terminal replays
    // them — so assert against the transcript's normalized copy.
    const transcript = await readFile(
      await findTranscript(session.configDirPath, '<bash-input>'),
      'utf-8',
    )
    expect(transcript).toContain('<bash-input>')
    expect(transcript).toContain('got hunter2')
    expect(transcript).not.toContain('got hunter2\r')
  })

  test('Escape tree-kills a stuck interactive run', async () => {
    session = await startSession()
    server.reset([])

    await sendBashLine(session, `! sleep 30`)

    // The interactive panel mounts and takes the DOM focus; the prompt
    // stays painted below it but receives no keys while the run is live.
    await session.waitForScreen(
      screen => screen.includes('╭') && screen.includes('Esc kill'),
      { description: 'interactive panel mounted', timeoutMs: 30_000 },
    )

    await session.sendSpecialKey('Escape')

    // The run dies and the box comes back. An interrupted bash submission
    // restores its text into the box in bash mode — the box shows the `!`
    // marker and mode hint instead of the ❯ glyph, so assert on the hint.
    await session.waitForScreen(screen => screen.includes('for bash mode'), {
      description: 'prompt box restored after kill',
      timeoutMs: 30_000,
    })
    // And the sleep is actually gone — no zombie behind the TUI. The
    // args-anchored grep cannot match its own bash -c wrapper.
    const procs = Bun.spawnSync({
      cmd: ['bash', '-c', `ps -eo args= | grep -c '^sleep 30$' || true`],
    })
    expect(procs.stdout.toString().trim()).toBe('0')
  })

  test('cursor-addressed output renders inside the panel grid', async () => {
    session = await startSession()
    server.reset([])

    // Draw at panel-grid row 4, col 6 (CUP), then hold the run open so the
    // panel stays mounted long enough to capture. The marker is assembled
    // from fragments so the echoed command text can never satisfy the
    // wait. A raw byte-passthrough would address the REAL pane's row 4 —
    // the line index plus the leading-space column prove the bytes went
    // through the emulator's screen buffer instead.
    await sendBashLine(
      session,
      `! printf '\\033[2J\\033[4;6H''MAR''KER'; sleep 15`,
    )

    await session.waitForScreen(
      screen => screen.includes('╭') && screen.includes('Esc kill'),
      { description: 'interactive panel mounted', timeoutMs: 30_000 },
    )
    const screen = await session.waitForScreen(s => s.includes('MARKER'), {
      description: 'positioned MARKER visible',
      timeoutMs: 30_000,
      currentPaneOnly: true,
    })
    const lines = screen.split('\n')
    const markerIndex = lines.findIndex(l => l.includes('MARKER'))
    // The panel starts well below the pane's row 3 (where a passthrough
    // CUP would land): input echo + margin + top border + 3 grid rows.
    expect(markerIndex).toBeGreaterThanOrEqual(6)
    // marginLeft(2) + '│' + 5 columns into the grid row.
    expect(lines[markerIndex]).toMatch(/^ {2}│ {5}MARKER/)

    await session.sendSpecialKey('Escape')
    await session.waitForScreen(s => s.includes('for bash mode'), {
      description: 'prompt box restored after kill',
      timeoutMs: 30_000,
    })
  })

  test('a backgrounded interactive run does not pollute the next panel', async () => {
    session = await startSession({
      settings: { backgroundTasksEnabled: true },
    })
    server.reset([])

    // A run that keeps printing after being backgrounded. The marker is
    // assembled from fragments so the echoed command text never satisfies
    // a screen match — only the child's actual output can.
    await sendBashLine(
      session,
      `! for i in $(seq 50); do echo POL''LUTE-$i; sleep 0.2; done`,
    )
    await session.waitForScreen(
      screen => screen.includes('╭') && screen.includes('Esc kill'),
      { description: 'first interactive panel mounted', timeoutMs: 30_000 },
    )
    await session.waitForScreen(screen => screen.includes('POLLUTE-'), {
      description: 'first run is printing',
      timeoutMs: 30_000,
    })

    // Ctrl+B backgrounds the run (the e2e default disables background
    // tasks, hence the settings above); its PTY stays alive and printing.
    // Backgrounding is a normal completion — no interrupt-restore, so wait
    // for the panel to clear instead of a bash-mode box hint.
    await session.sendSpecialKey('C-b')
    await session.waitForScreen(s => !s.includes('Esc kill'), {
      description: 'panel cleared after backgrounding',
      timeoutMs: 30_000,
      currentPaneOnly: true,
    })

    // A second interactive run gets a fresh panel. Without the foreground
    // gate, the backgrounded run's onOutput kept feeding appendPtyScreenDelta,
    // and its POLLUTE lines would render inside the NEW panel.
    await sendBashLine(session, `! echo SEC''OND; sleep 15`)
    await session.waitForScreen(
      screen => screen.includes('╭') && screen.includes('Esc kill'),
      { description: 'second interactive panel mounted', timeoutMs: 30_000 },
    )
    const screen = await session.waitForScreen(s => s.includes('SECOND'), {
      description: 'second run output visible',
      timeoutMs: 30_000,
      currentPaneOnly: true,
    })
    // The backgrounded run's completion notification legitimately carries
    // its output tail into the transcript — the assertion is that no
    // POLLUTE line rendered INSIDE the new panel (panel rows start with '│').
    expect(screen).not.toMatch(/│ *POLLUTE/)

    await session.sendSpecialKey('Escape')
    await session.waitForScreen(s => s.includes('for bash mode'), {
      description: 'prompt box restored after kill',
      timeoutMs: 30_000,
    })
  })
})
