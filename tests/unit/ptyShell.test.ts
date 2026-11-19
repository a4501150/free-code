/**
 * Interactive PTY executor tests. These drive spawnPtyChild directly (the
 * raw node-pty addon + our EAGAIN-tolerant read loop), which is the piece
 * Bun's broken tty.ReadStream wrapper cannot be trusted with
 * (oven-sh/bun#29112). The full exec()-level integration is covered by the
 * TUI e2e suite.
 */
import { describe, expect, test } from 'bun:test'
import {
  getPtyHandle,
  isPtySupported,
  registerPtyHandle,
  spawnPtyChild,
  unregisterPtyHandle,
  type PtyChildProcess,
} from '../../src/utils/shell/ptyShell.js'
import { createBashShellProvider } from '../../src/utils/shell/bashProvider.js'

const wait = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5000,
): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout')
    await wait(20)
  }
}

function spawn(
  command: string,
  opts: { onOutput?: (d: string) => void } = {},
): {
  child: PtyChildProcess
  output: () => string
  closed: Promise<{ code: number; signal: number }>
} {
  let out = ''
  let resolveClosed!: (v: { code: number; signal: number }) => void
  const closedPromise = new Promise<{ code: number; signal: number }>(r => {
    resolveClosed = r
  })
  const child = spawnPtyChild({
    file: '/bin/bash',
    args: ['-c', command],
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', TERM: 'xterm-256color' },
    cwd: '/tmp',
    cols: 80,
    rows: 24,
    onOutput: bytes => {
      const chunk = bytes.toString('utf8')
      out += chunk
      opts.onOutput?.(chunk)
    },
    onClosed: (code, signal) => resolveClosed({ code, signal }),
  })
  return { child, output: () => out, closed: closedPromise }
}

describe.skipIf(!isPtySupported())('spawnPtyChild', () => {
  test('runs a command and reports its exit code', async () => {
    const { child, output, closed } = spawn('echo hello; exit 7')
    const result = await closed
    expect(result.code).toBe(7)
    expect(result.signal).toBe(0)
    expect(output()).toContain('hello\r\n')
    expect(child.pid).toBeGreaterThan(0)
  })

  test('gives the child a controlling tty — password prompts work', async () => {
    const { child, output, closed } = spawn(
      'if [ -t 0 ]; then echo IS_TTY; else echo NO_TTY; fi; read -s -p "Pass: " p; echo "got $p"',
    )
    await waitFor(() => output().includes('IS_TTY'))
    expect(output()).not.toContain('NO_TTY')
    await waitFor(() => output().includes('Pass: '))
    child.pty.write('hunter2\r')
    const result = await closed
    expect(result.code).toBe(0)
    expect(output()).toContain('got hunter2')
  })

  test('resizes the terminal', async () => {
    const { child, output, closed } = spawn(
      'stty size; sleep 0.3; stty size; echo done',
    )
    await waitFor(() => output().includes('24 80'))
    child.pty.resize(120, 40)
    const result = await closed
    expect(result.code).toBe(0)
    expect(output()).toContain('40 120')
    expect(output()).toContain('done')
  })

  test('streams long-running output over time', async () => {
    const { output, closed } = spawn(
      'echo start; for i in 1 2 3; do echo tick$i; sleep 0.15; done; echo end',
    )
    await waitFor(() => output().includes('tick1'))
    expect(output()).not.toContain('end') // still running
    const result = await closed
    expect(result.code).toBe(0)
    expect(output()).toContain('end')
  })

  test('kill terminates the child and the loop reports EIO close', async () => {
    const { child, closed } = spawn('echo start; sleep 30')
    await wait(200)
    child.kill('SIGKILL')
    const result = await closed
    expect(result.signal).toBe(9)
  })

  test('registry maps task ids to live handles', () => {
    registerPtyHandle('test-task-1', { write: () => {}, resize: () => {} })
    expect(getPtyHandle('test-task-1')).toBeDefined()
    unregisterPtyHandle('test-task-1')
    expect(getPtyHandle('test-task-1')).toBeUndefined()
  })
})

describe.skipIf(!isPtySupported())('bash provider interactive mode', () => {
  test('interactive mode skips the </dev/null stdin injection', async () => {
    const provider = await createBashShellProvider('/bin/bash', {
      skipSnapshot: true,
    })
    const plain = await provider.buildExecCommand(
      'sudo journalctl --vacuum-time=2h',
      { id: 'i1' },
    )
    expect(plain.commandString).toContain('< /dev/null')

    const interactive = await provider.buildExecCommand(
      'sudo journalctl --vacuum-time=2h',
      { id: 'i2', interactive: true },
    )
    expect(interactive.commandString).not.toContain('< /dev/null')
    // The rest of the prefix chain (pipefail, eval, cwd tracking) stays.
    expect(interactive.commandString).toContain('eval')
    expect(interactive.commandString).toContain('pwd -P')
  })
})
