import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawn, spawnSync, type ChildProcess } from 'child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getLiveSessionHolders } from '../../src/utils/concurrentSessions.js'

// Only the registry reader is exercised here. checkResumeSessionOwnership is a
// three-line wrapper in sessionRestore.ts, and importing that module pulls the
// agent/cost/state graph into this shared test process for no extra coverage.

const TARGET = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'

let configDir: string
let sessionsDir: string
let previousConfigDir: string | undefined
let children: ChildProcess[] = []

// A PID that has certainly exited. Reuse within one test run is vanishingly
// unlikely, and the alternative (a hardcoded large number) is not portable.
function deadPid(): number {
  const result = spawnSync('true', [], { stdio: 'ignore' })
  if (!result.pid) throw new Error('could not spawn a throwaway process')
  return result.pid
}

function livePid(): number {
  const child = spawn('sleep', ['30'], { stdio: 'ignore' })
  children.push(child)
  if (!child.pid) throw new Error('could not spawn a live process')
  return child.pid
}

async function writeEntry(
  pid: number,
  body: Record<string, unknown> | string,
): Promise<void> {
  await writeFile(
    join(sessionsDir, `${pid}.json`),
    typeof body === 'string' ? body : JSON.stringify(body),
  )
}

function validEntry(
  pid: number,
  sessionId: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    pid,
    sessionId,
    cwd: '/tmp/project',
    startedAt: 1_700_000_000_000,
    kind: 'interactive',
    entrypoint: 'cli',
    ...extra,
  }
}

beforeEach(async () => {
  previousConfigDir = process.env.FREECODE_CONFIG_DIR
  configDir = await mkdtemp(join(tmpdir(), 'free-code-sessions-'))
  // getClaudeConfigHomeDir memoizes on the env var itself, so no cache reset.
  process.env.FREECODE_CONFIG_DIR = configDir
  sessionsDir = join(configDir, 'sessions')
  await mkdir(sessionsDir, { recursive: true })
})

afterEach(async () => {
  for (const child of children) child.kill()
  children = []
  if (previousConfigDir === undefined) delete process.env.FREECODE_CONFIG_DIR
  else process.env.FREECODE_CONFIG_DIR = previousConfigDir
  await rm(configDir, { recursive: true, force: true })
})

describe('getLiveSessionHolders', () => {
  test('returns a live process holding the session', async () => {
    const pid = livePid()
    await writeEntry(pid, validEntry(pid, TARGET, { name: 'other window' }))

    const holders = await getLiveSessionHolders(TARGET)

    expect(holders).toHaveLength(1)
    expect(holders[0]).toMatchObject({
      pid,
      sessionId: TARGET,
      cwd: '/tmp/project',
      kind: 'interactive',
      entrypoint: 'cli',
      name: 'other window',
    })
  })

  test('excludes this process, which holds the ID it is asking about', async () => {
    await writeEntry(process.pid, validEntry(process.pid, TARGET))

    expect(await getLiveSessionHolders(TARGET)).toEqual([])
  })

  test('ignores an entry whose body claims a different PID', async () => {
    const pid = livePid()
    await writeEntry(pid, validEntry(pid + 1, TARGET))

    expect(await getLiveSessionHolders(TARGET)).toEqual([])
  })

  test('ignores malformed JSON', async () => {
    const pid = livePid()
    await writeEntry(pid, '{not json')

    expect(await getLiveSessionHolders(TARGET)).toEqual([])
  })

  test('ignores entries with an invalid cwd, startedAt or kind', async () => {
    const a = livePid()
    const b = livePid()
    const c = livePid()
    await writeEntry(a, validEntry(a, TARGET, { cwd: 42 }))
    await writeEntry(b, validEntry(b, TARGET, { startedAt: 0 }))
    await writeEntry(c, validEntry(c, TARGET, { kind: 'nonsense' }))

    expect(await getLiveSessionHolders(TARGET)).toEqual([])
  })

  test('ignores a live holder of a different session', async () => {
    const pid = livePid()
    await writeEntry(pid, validEntry(pid, OTHER))

    expect(await getLiveSessionHolders(TARGET)).toEqual([])
  })

  test('ignores a dead PID and leaves its file in place', async () => {
    const pid = deadPid()
    await writeEntry(pid, validEntry(pid, TARGET))

    expect(await getLiveSessionHolders(TARGET)).toEqual([])
    // countConcurrentSessions owns sweeping; an ownership query must not
    // delete a file it merely failed to probe.
    expect(existsSync(join(sessionsDir, `${pid}.json`))).toBe(true)
  })

  test('ignores files that are not <pid>.json', async () => {
    const pid = livePid()
    await writeFile(
      join(sessionsDir, '2026-03-14_notes.md'),
      JSON.stringify(validEntry(pid, TARGET)),
    )

    expect(await getLiveSessionHolders(TARGET)).toEqual([])
  })

  test('orders multiple holders by start time, then PID', async () => {
    const first = livePid()
    const second = livePid()
    await writeEntry(first, validEntry(first, TARGET, { startedAt: 2000 }))
    await writeEntry(second, validEntry(second, TARGET, { startedAt: 1000 }))

    const holders = await getLiveSessionHolders(TARGET)

    expect(holders.map(h => h.pid)).toEqual([second, first])
  })

  test('returns nothing when the sessions directory does not exist', async () => {
    await rm(sessionsDir, { recursive: true, force: true })

    expect(await getLiveSessionHolders(TARGET)).toEqual([])
  })
})
