/**
 * Resume ownership E2E tests.
 *
 * A session another live process already holds must not be adopted silently:
 * both processes would append to one transcript and share every store keyed on
 * the session ID, the task list included.
 *
 * The holder is faked by writing `<configDir>/sessions/<pid>.json` for the Bun
 * test runner itself. The runner stays alive for the whole test and is not the
 * CLI's own PID, so it is a valid holder from the child's point of view.
 *
 * These tests require `TEST_ENABLE_SESSION_PERSISTENCE=1` in the child env —
 * `tmux-helpers.ts` passes it through.
 */

import {
  describe,
  test as bunTest,
  expect,
  beforeAll,
  afterAll,
  afterEach,
  setDefaultTimeout,
} from 'bun:test'
setDefaultTimeout(180_000)

import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { MockAnthropicServer } from '../helpers/mock-server'
import { TmuxSession, createLoggingTest } from './tmux-helpers'

const PROJECT_ROOT = join(import.meta.dir, '..', '..')
const CLI_BINARY = join(PROJECT_ROOT, 'cli-dev')

const test = createLoggingTest(bunTest)

const DIALOG_TEXT = 'Session already open elsewhere'

function textTurn(text: string) {
  return {
    kind: 'success' as const,
    response: {
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 40, output_tokens: 15 },
    },
  }
}

describe('Resume session ownership', () => {
  let server: MockAnthropicServer
  let cwd: string | null = null
  let configDir: string | null = null
  let homeDir: string | null = null
  let headlessDirs: string[] = []

  beforeAll(async () => {
    server = new MockAnthropicServer()
    await server.start()
  })

  afterAll(() => {
    server.stop()
  })

  afterEach(async () => {
    const { rm } = await import('node:fs/promises')
    for (const d of [cwd, configDir, homeDir, ...headlessDirs]) {
      if (d) await rm(d, { recursive: true, force: true }).catch(() => {})
    }
    headlessDirs = []
    cwd = null
    configDir = null
    homeDir = null
    cachedProjectDir = null
  })

  // Discovered rather than derived: the cwd-to-directory sanitization lives in
  // the CLI and this test only ever creates one project.
  let cachedProjectDir: string | null = null
  async function projectDir(): Promise<string> {
    if (cachedProjectDir) return cachedProjectDir
    const root = join(configDir!, 'projects')
    const entries = await readdir(root)
    expect(entries).toHaveLength(1)
    cachedProjectDir = join(root, entries[0]!)
    return cachedProjectDir
  }

  async function transcripts(): Promise<string[]> {
    const entries = await readdir(await projectDir()).catch(
      () => [] as string[],
    )
    return entries.filter(f => f.endsWith('.jsonl')).sort()
  }

  /** Wait until a file stops growing, so size snapshots are not racy. */
  async function settle(path: string): Promise<number> {
    let last = -1
    for (let i = 0; i < 40; i++) {
      const size = (await stat(path)).size
      if (size === last) return size
      last = size
      await new Promise(r => setTimeout(r, 250))
    }
    return last
  }

  /** Run one real session so a transcript exists, and return its session ID. */
  async function primeSession(): Promise<string> {
    cwd = await mkdtemp(join(tmpdir(), 'claude-e2e-own-cwd-'))
    configDir = await mkdtemp(join(tmpdir(), 'claude-e2e-own-config-'))
    homeDir = await mkdtemp(join(tmpdir(), 'claude-e2e-own-home-'))

    server.reset([textTurn('First response')])
    const session = new TmuxSession({
      serverUrl: server.url,
      cwd,
      reuseConfigDir: configDir,
      reuseHomeDir: homeDir,
    })
    await session.start()
    await session.submitAndWaitForResponse('Initial prompt')
    await session.stop()

    const files = await transcripts()
    expect(files).toHaveLength(1)
    // stop() does not wait for the CLI's exit cleanup, which re-appends
    // last-prompt and mode. Let the file settle before anything snapshots it.
    await settle(join(await projectDir(), files[0]!))
    return files[0]!.replace(/\.jsonl$/, '')
  }

  /** Claim `sessionId` for this (live) test-runner process. */
  async function fakeHolder(sessionId: string): Promise<void> {
    const dir = join(configDir!, 'sessions')
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, `${process.pid}.json`),
      JSON.stringify({
        pid: process.pid,
        sessionId,
        cwd: cwd!,
        startedAt: Date.now() - 60_000,
        kind: 'interactive',
        entrypoint: 'cli',
      }),
    )
  }

  /** The session IDs the child CLI processes currently claim. */
  async function claimedSessionIds(): Promise<string[]> {
    const dir = join(configDir!, 'sessions')
    const files = await readdir(dir).catch(() => [] as string[])
    const ids: string[] = []
    for (const f of files) {
      if (!/^\d+\.json$/.test(f)) continue
      if (f === `${process.pid}.json`) continue
      const body = await readFile(join(dir, f), 'utf8').catch(() => '')
      const parsed = body ? (JSON.parse(body) as { sessionId?: string }) : null
      if (parsed?.sessionId) ids.push(parsed.sessionId)
    }
    return ids
  }

  async function startConflicting(
    additionalArgs: string[],
    readyText: string = DIALOG_TEXT,
  ): Promise<TmuxSession> {
    const session = new TmuxSession({
      serverUrl: server.url,
      cwd: cwd!,
      reuseConfigDir: configDir!,
      reuseHomeDir: homeDir!,
      additionalArgs,
      readyText,
    })
    await session.start()
    return session
  }

  test('--continue offers to fork, and forking leaves the held transcript alone', async () => {
    const held = await primeSession()
    await fakeHolder(held)
    const heldPath = join(await projectDir(), `${held}.jsonl`)
    const sizeBefore = (await stat(heldPath)).size

    server.reset([textTurn('Forked response')])
    const session = await startConflicting(['--continue'])

    const dialog = await session.waitForText(DIALOG_TEXT, 20_000)
    expect(dialog).toContain(String(process.pid))
    expect(dialog).toContain('Fork into a new session')

    // "Fork into a new session" is the first option.
    await session.sendKeys('Enter')
    await session.waitForText('for shortcuts', 30_000)
    await session.sendLine('Follow up')
    await session.waitForText('Forked response', 20_000)

    // The held transcript must not have grown, and a second one must exist.
    expect((await stat(heldPath)).size).toBe(sizeBefore)
    const files = await transcripts()
    expect(files).toHaveLength(2)
    expect(await claimedSessionIds()).not.toContain(held)

    await session.stop()
  })

  test('--continue can cancel, leaving the process gone and the transcript untouched', async () => {
    const held = await primeSession()
    await fakeHolder(held)
    const heldPath = join(await projectDir(), `${held}.jsonl`)
    const sizeBefore = (await stat(heldPath)).size

    server.reset([textTurn('should never be requested')])
    const session = await startConflicting(['--continue'])
    await session.waitForText(DIALOG_TEXT, 20_000)

    // Move to "Cancel and exit" and confirm.
    await session.sendKeys('Down')
    await session.sendKeys('Enter')

    // The CLI exits, so its registry entry disappears and it never claims
    // the held session.
    const deadline = Date.now() + 20_000
    let claimed = await claimedSessionIds()
    while (claimed.length > 0 && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 250))
      claimed = await claimedSessionIds()
    }
    expect(claimed).toEqual([])
    expect((await stat(heldPath)).size).toBe(sizeBefore)
    expect(await transcripts()).toHaveLength(1)

    await session.stop()
  })

  test('--continue can take over, and then both windows share the transcript', async () => {
    const held = await primeSession()
    await fakeHolder(held)
    const heldPath = join(await projectDir(), `${held}.jsonl`)
    const sizeBefore = (await stat(heldPath)).size

    server.reset([textTurn('Shared response')])
    const session = await startConflicting(['--continue'])
    await session.waitForText(DIALOG_TEXT, 20_000)

    // Move to "Resume anyway" and confirm.
    await session.sendKeys('Down')
    await session.sendKeys('Down')
    await session.sendKeys('Enter')
    await session.waitForText('for shortcuts', 30_000)
    await session.sendLine('Follow up')
    await session.waitForText('Shared response', 20_000)

    expect(await claimedSessionIds()).toContain(held)
    expect((await stat(heldPath)).size).toBeGreaterThan(sizeBefore)
    expect(await transcripts()).toHaveLength(1)

    await session.stop()
  })

  test('the picker shows the same dialog before adopting a held session', async () => {
    const held = await primeSession()
    await fakeHolder(held)

    server.reset([textTurn('Picked response')])
    // The picker renders first; the conflict dialog only follows a selection.
    const session = await startConflicting(['--resume'], 'Resume Session')

    // Select the only session in the picker, then fork out of the conflict.
    await session.sendKeys('Enter')
    const dialog = await session.waitForText(DIALOG_TEXT, 20_000)
    expect(dialog).toContain(String(process.pid))

    await session.sendKeys('Enter')
    await session.waitForText('for shortcuts', 30_000)
    expect(await claimedSessionIds()).not.toContain(held)

    await session.stop()
  })

  test('/resume can fork out of a held session into a third one', async () => {
    const held = await primeSession()
    await fakeHolder(held)
    const heldPath = join(await projectDir(), `${held}.jsonl`)
    const sizeBefore = (await stat(heldPath)).size

    // A live session of its own, so the fork target is neither this session
    // nor the held one.
    server.reset([textTurn('Live response'), textTurn('Forked response')])
    const session = new TmuxSession({
      serverUrl: server.url,
      cwd: cwd!,
      reuseConfigDir: configDir!,
      reuseHomeDir: homeDir!,
    })
    await session.start()
    await session.submitAndWaitForResponse('Live prompt')
    const [ownId] = await claimedSessionIds()
    expect(ownId).toBeDefined()
    expect(ownId).not.toBe(held)

    await session.sendLine(`/resume ${held}`)
    const dialog = await session.waitForText(DIALOG_TEXT, 20_000)
    expect(dialog).toContain(String(process.pid))

    // "Fork into a new session" is the first option.
    await session.sendKeys('Enter')
    await session.waitForText('for shortcuts', 30_000)

    const claimed = await claimedSessionIds()
    expect(claimed).toHaveLength(1)
    expect(claimed[0]).not.toBe(held)
    expect(claimed[0]).not.toBe(ownId)
    expect((await stat(heldPath)).size).toBe(sizeBefore)

    await session.stop()
  })

  test('headless resume refuses with exit 1, and --fork-session proceeds', async () => {
    const held = await primeSession()

    // The tmux-seeded config dir cannot host a headless run — print mode stalls
    // in it even with no resume at all. So build a config dir the way the other
    // headless E2E tests do, and move the primed transcript and the fake holder
    // into it.
    const apiKey = 'test-key-headless-ownership'
    const headlessConfig = await mkdtemp(join(tmpdir(), 'claude-e2e-own-hcfg-'))
    const headlessHome = await mkdtemp(join(tmpdir(), 'claude-e2e-own-hhome-'))
    headlessDirs.push(headlessConfig, headlessHome)
    await writeFile(join(headlessConfig, 'freecode.json'), JSON.stringify({}))
    await writeFile(
      join(headlessConfig, 'modelSettings.json'),
      JSON.stringify({
        providers: {
          'test-anthropic': {
            type: 'anthropic',
            baseUrl: server.url,
            auth: { active: 'apiKey', apiKey: { key: apiKey } },
            models: [{ id: 'claude-sonnet-4-20250514' }],
          },
        },
        defaultModel: 'test-anthropic:claude-sonnet-4-20250514',
      }),
    )
    const sourceProject = await projectDir()
    await cp(
      sourceProject,
      join(headlessConfig, 'projects', basename(sourceProject)),
      {
        recursive: true,
      },
    )
    await mkdir(join(headlessConfig, 'sessions'), { recursive: true })
    await writeFile(
      join(headlessConfig, 'sessions', `${process.pid}.json`),
      JSON.stringify({
        pid: process.pid,
        sessionId: held,
        cwd: cwd!,
        startedAt: Date.now() - 60_000,
        kind: 'interactive',
        entrypoint: 'cli',
      }),
    )

    const env = {
      PATH: process.env.PATH ?? '/usr/bin:/bin:/usr/local/bin',
      ANTHROPIC_API_KEY: apiKey,
      ANTHROPIC_BASE_URL: server.url,
      FREECODE_CONFIG_DIR: headlessConfig,
      CLAUDE_CONFIG_DIR: headlessConfig,
      HOME: headlessHome,
      TEST_ENABLE_SESSION_PERSISTENCE: '1',
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
      CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
      CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING: '1',
      CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1',
      CLAUDE_CODE_DISABLE_THINKING: '1',
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
      NODE_ENV: 'test',
      NO_COLOR: '1',
      DO_NOT_TRACK: '1',
    }
    const baseArgs = [
      '--print',
      '--bare',
      '--dangerously-skip-permissions',
      '--output-format',
      'text',
    ]

    async function runHeadless(extra: string[]) {
      const proc = Bun.spawn([CLI_BINARY, ...baseArgs, ...extra], {
        cwd: cwd!,
        env,
        stdout: 'pipe',
        stderr: 'pipe',
        stdin: 'pipe',
      })
      proc.stdin.end()
      const killer = setTimeout(() => proc.kill(), 60_000)
      const [exitCode, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ])
      clearTimeout(killer)
      return { exitCode, stdout, stderr }
    }

    server.reset([textTurn('should never be requested')])
    const refused = await runHeadless(['--resume', held, 'test prompt'])
    expect(refused.exitCode).toBe(1)
    expect(refused.stderr).toContain(held)
    expect(refused.stderr).toContain(String(process.pid))
    expect(refused.stderr).toContain('--fork-session')
    expect(server.getRequestLog()).toHaveLength(0)

    server.reset([textTurn('Forked headless response')])
    const forked = await runHeadless([
      '--resume',
      held,
      '--fork-session',
      'test prompt',
    ])
    expect(forked.exitCode).toBe(0)
    expect(forked.stdout).toContain('Forked headless response')
  })
})
