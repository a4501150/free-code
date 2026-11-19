/**
 * Interactive PTY e2e for bash-mode `!` commands.
 *
 * Every `!` command runs under a PTY (controlling tty), so password-style
 * prompts work: the pane must show the child's `read -s` prompt, typed
 * keystrokes must reach the child through the InteractiveBashProgress
 * view, and the finished transcript must carry the CRLF-normalized output.
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

    // Wait for the interactive view to mount BEFORE matching the prompt:
    // 'Pass:' alone can match the command text in the pane from submit
    // time, and keys typed before the view's useInput mounts are lost.
    await session.waitForScreen(screen => screen.includes('Interactive'), {
      description: 'interactive view mounted',
      timeoutMs: 30_000,
    })
    // The child's prompt must render in the live view before we type.
    // tmux captures trim trailing whitespace, so assert on 'Pass:' —
    // the prompt itself has no newline and rides the partial last line.
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

    // The interactive view owns the screen with the prompt input hidden.
    await session.waitForScreen(screen => screen.includes('Interactive'), {
      description: 'interactive view mounted',
      timeoutMs: 30_000,
    })

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
})
