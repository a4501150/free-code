import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test as bunTest,
} from 'bun:test'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { textResponse } from '../helpers/fixture-builders'
import { MockAnthropicServer } from '../helpers/mock-server'
import { waitForRequestCount } from '../helpers/mock-server-wait'
import { waitFor } from '../helpers/wait-helpers'
import { createLoggingTest, sleep, TmuxSession } from './tmux-helpers'

setDefaultTimeout(180_000)
const test = createLoggingTest(bunTest)

const CLI = join(import.meta.dir, '..', '..', 'cli-dev')
const PASSWORD = 'a-long-enough-password'

type Dirs = { config: string; home: string }

async function makeDirs(): Promise<Dirs> {
  return {
    config: await mkdtemp(join(tmpdir(), 'webui-gw-config-')),
    home: await mkdtemp(join(tmpdir(), 'webui-gw-home-')),
  }
}

function env(dirs: Dirs): Record<string, string> {
  return {
    ...process.env,
    FREECODE_CONFIG_DIR: dirs.config,
    CLAUDE_CONFIG_DIR: dirs.config,
    HOME: dirs.home,
  } as Record<string, string>
}

async function runCli(
  dirs: Dirs,
  args: string[],
  stdin?: string,
): Promise<string> {
  const proc = Bun.spawn([CLI, ...args], {
    env: env(dirs),
    stdin: stdin === undefined ? 'ignore' : new TextEncoder().encode(stdin),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited
  return out + err
}

/** A logged-in HTTP + WebSocket client, the way a browser would arrive. */
class GatewayClient {
  cookie = ''
  csrf = ''
  constructor(readonly baseUrl: string) {}

  async login(password: string): Promise<number> {
    const response = await fetch(`${this.baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    })
    if (response.ok) {
      const setCookie = response.headers.get('set-cookie') ?? ''
      this.cookie = setCookie.split(';')[0] ?? ''
      this.csrf = ((await response.json()) as { csrf: string }).csrf
    }
    return response.status
  }

  async sessions(): Promise<{
    sessions: Array<{
      processKey?: string
      sessionId: string
      live: boolean
      attachable: boolean
      owned: boolean
      pid?: number
      stoppablePid?: number
      holders: number
    }>
  }> {
    const response = await fetch(`${this.baseUrl}/api/sessions`, {
      headers: { cookie: this.cookie },
    })
    return response.json() as never
  }

  async directories(
    path: string,
    hidden = true,
  ): Promise<{
    status: number
    body: {
      base: string
      parent: string | null
      entries: { name: string; path: string }[]
    }
  }> {
    const query = new URLSearchParams({ path, hidden: hidden ? '1' : '0' })
    const response = await fetch(`${this.baseUrl}/api/directories?${query}`, {
      headers: { cookie: this.cookie },
    })
    return { status: response.status, body: (await response.json()) as never }
  }

  async restart(csrf = this.csrf): Promise<number> {
    const response = await fetch(`${this.baseUrl}/api/restart`, {
      method: 'POST',
      headers: {
        cookie: this.cookie,
        origin: this.baseUrl,
        'x-freecode-csrf': csrf,
      },
    })
    return response.status
  }

  openSocket(): Promise<{
    socket: WebSocket
    frames: Record<string, unknown>[]
  }> {
    const frames: Record<string, unknown>[] = []
    const socket = new WebSocket(`${this.baseUrl.replace('http', 'ws')}/ws`, {
      headers: { cookie: this.cookie, origin: this.baseUrl },
    } as never)
    socket.addEventListener('message', event => {
      frames.push(JSON.parse(String(event.data)))
    })
    return new Promise((resolve, reject) => {
      socket.addEventListener('open', () => resolve({ socket, frames }))
      socket.addEventListener('error', () => reject(new Error('ws error')))
    })
  }
}

async function waitForAttachablePid(configDir: string): Promise<number> {
  return waitFor(
    async () => {
      try {
        const files = await readdir(join(configDir, 'attach'))
        const descriptor = files.find(f => /^\d+\.json$/.test(f))
        return descriptor ? parseInt(descriptor.slice(0, -5), 10) : 0
      } catch {
        return 0
      }
    },
    pid => pid > 0,
    { description: 'a session to become attachable', timeoutMs: 30_000 },
  )
}

describe('WebUI gateway', () => {
  let server: MockAnthropicServer
  let session: TmuxSession | undefined
  /** A second terminal, for the test that adopts a session the gateway holds. */
  let takeover: TmuxSession | undefined
  let dirs: Dirs
  let baseUrl = ''

  beforeAll(async () => {
    server = new MockAnthropicServer()
    await server.start()
  })

  afterAll(() => {
    server.stop()
  })

  afterEach(async () => {
    if (takeover) {
      await takeover.stop()
      takeover = undefined
    }
    if (session) {
      await session.stop()
      session = undefined
    }
    if (dirs) {
      await runCli(dirs, ['web', 'stop'])
      await runCli(dirs, ['daemon', 'stop'])
      await rm(dirs.config, { recursive: true, force: true })
      await rm(dirs.home, { recursive: true, force: true })
    }
  })

  async function startGateway(): Promise<void> {
    dirs = await makeDirs()
    const output = await runCli(
      dirs,
      ['web', 'start', '--tunnel', 'none', '--password-stdin'],
      PASSWORD,
    )
    const match = /http:\/\/127\.0\.0\.1:\d+/.exec(output)
    if (!match) throw new Error(`no gateway URL in output:\n${output}`)
    baseUrl = match[0]
  }

  test('survives the terminal that started it and refuses bad credentials', async () => {
    await startGateway()

    // A separate process sees it, which is the point of hosting it in the
    // daemon rather than the foreground.
    const status = await runCli(dirs, ['web', 'status'])
    expect(status).toContain(baseUrl)

    const client = new GatewayClient(baseUrl)
    expect(await client.login('not-the-password')).toBe(401)

    const unauthenticated = await fetch(`${baseUrl}/api/sessions`)
    expect(unauthenticated.status).toBe(401)

    const badOrigin = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://evil.example',
      },
      body: JSON.stringify({ password: PASSWORD }),
    })
    expect(badOrigin.status).toBe(403)

    expect(await client.login(PASSWORD)).toBe(200)
    expect(client.csrf.length).toBeGreaterThan(10)
  })

  test('rejects a websocket upgrade without a session cookie', async () => {
    await startGateway()
    const failed = await new Promise<boolean>(resolve => {
      const socket = new WebSocket(`${baseUrl.replace('http', 'ws')}/ws`)
      socket.addEventListener('open', () => {
        socket.close()
        resolve(false)
      })
      socket.addEventListener('error', () => resolve(true))
      socket.addEventListener('close', () => resolve(true))
    })
    expect(failed).toBe(true)
  })

  test('browses host directories and refuses a bad working directory', async () => {
    await startGateway()
    const client = new GatewayClient(baseUrl)

    // The listing names host directories, so it is behind the same login.
    expect((await fetch(`${baseUrl}/api/directories`)).status).toBe(401)
    expect(await client.login(PASSWORD)).toBe(200)

    const project = join(dirs.home, 'project')
    await mkdir(join(project, 'nested'), { recursive: true })
    await mkdir(join(dirs.home, '.dotted'))
    await writeFile(join(dirs.home, 'notes.txt'), 'not a directory')

    // A read needs no CSRF header, exactly as the session list does not.
    const listing = await client.directories(`${dirs.home}/`)
    expect(listing.status).toBe(200)
    expect(listing.body.base).toBe(dirs.home)
    expect(listing.body.parent).toBe(dirname(dirs.home))
    const names = listing.body.entries.map(entry => entry.name)
    expect(names).toContain('project')
    expect(names).toContain('.dotted')
    expect(names).not.toContain('notes.txt')
    expect(listing.body.entries.find(e => e.name === 'project')?.path).toBe(
      project,
    )

    const visible = await client.directories(`${dirs.home}/`, false)
    expect(visible.body.entries.map(entry => entry.name)).not.toContain(
      '.dotted',
    )

    // A half-typed name filters the parent instead of failing.
    const filtered = await client.directories(join(dirs.home, 'pro'))
    expect(filtered.body.entries.map(entry => entry.name)).toEqual(['project'])

    expect((await client.directories('relative/path')).status).toBe(400)
    expect((await client.directories('//server/share/')).status).toBe(403)
    expect((await client.directories(`${dirs.home}/nowhere/`)).status).toBe(404)

    // A working directory is checked before spawn, so each of these answers
    // with its own reason rather than a raw errno from the child.
    const start = async (cwd: string) =>
      fetch(`${baseUrl}/api/sessions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: client.cookie,
          'x-freecode-csrf': client.csrf,
        },
        body: JSON.stringify({ cwd }),
      })

    const relative = await start('project')
    expect(relative.status).toBe(400)
    expect(((await relative.json()) as { error: string }).error).toBe(
      'cwd_not_absolute',
    )

    const missing = await start(join(dirs.home, 'nowhere'))
    expect(missing.status).toBe(404)
    expect(((await missing.json()) as { error: string }).error).toBe(
      'cwd_not_found',
    )

    const file = await start(join(dirs.home, 'notes.txt'))
    expect(file.status).toBe(422)
    expect(((await file.json()) as { error: string }).error).toBe(
      'cwd_not_directory',
    )
  })

  test('lists a live terminal session and drives it over the websocket', async () => {
    await startGateway()

    server.reset([textResponse('Reply for the browser.')])
    // The session must share the gateway's config home, or they look at
    // different attach directories.
    session = new TmuxSession({
      serverUrl: server.url,
      reuseConfigDir: dirs.config,
      reuseHomeDir: dirs.home,
    })
    await session.start()
    await waitForAttachablePid(dirs.config)

    const client = new GatewayClient(baseUrl)
    expect(await client.login(PASSWORD)).toBe(200)

    const listed = await waitFor(
      () => client.sessions(),
      value => value.sessions.some(s => s.live && s.attachable),
      { description: 'the live session to appear in the list' },
    )
    const live = listed.sessions.find(s => s.live && s.attachable)!
    expect(live.processKey).toMatch(/^\d+:/)
    expect(live.holders).toBe(1)

    const { socket, frames } = await client.openSocket()
    try {
      socket.send(
        JSON.stringify({
          type: 'attach',
          processKey: live.processKey,
          csrf: client.csrf,
        }),
      )

      await waitFor(
        () => frames,
        list => list.some(f => f.type === 'attached'),
        { description: 'the attach acknowledgement' },
      )
      await waitFor(
        () => frames,
        list =>
          list.some(
            f =>
              f.type === 'event' &&
              (f.event as { kind: string }).kind === 'snapshot',
          ),
        { description: 'the session snapshot' },
      )

      const snapshot = frames.find(
        f =>
          f.type === 'event' &&
          (f.event as { kind: string }).kind === 'snapshot',
      )!
      const meta = (snapshot.event as { meta: { sessionEpoch: number } }).meta

      socket.send(
        JSON.stringify({
          type: 'command',
          id: 'c1',
          body: {
            kind: 'submit',
            commandId: crypto.randomUUID(),
            content: 'a prompt sent through the gateway',
            delivery: 'next',
            sessionEpoch: meta.sessionEpoch,
          },
        }),
      )

      const log = await waitForRequestCount(server, 1, {
        description: 'the gateway-submitted prompt reaching the API',
      })
      expect(JSON.stringify(log[0]!.body.messages)).toContain(
        'a prompt sent through the gateway',
      )
    } finally {
      socket.close()
    }
  })

  test('refuses a websocket attach with a bad csrf token', async () => {
    await startGateway()

    server.reset([textResponse('unused')])
    session = new TmuxSession({
      serverUrl: server.url,
      reuseConfigDir: dirs.config,
      reuseHomeDir: dirs.home,
    })
    await session.start()
    await waitForAttachablePid(dirs.config)

    const client = new GatewayClient(baseUrl)
    await client.login(PASSWORD)
    const listed = await waitFor(
      () => client.sessions(),
      value => value.sessions.some(s => s.attachable),
      { description: 'the live session to appear' },
    )
    const live = listed.sessions.find(s => s.attachable)!

    const { socket, frames } = await client.openSocket()
    try {
      socket.send(
        JSON.stringify({
          type: 'attach',
          processKey: live.processKey,
          csrf: 'forged',
        }),
      )
      await sleep(500)
      expect(frames.some(f => f.code === 'bad_csrf')).toBe(true)
      expect(frames.some(f => f.type === 'attached')).toBe(false)
    } finally {
      socket.close()
    }
  })

  test('starts, drives and stops a gateway-owned session', async () => {
    dirs = await makeDirs()
    server.reset([textResponse('Reply from a gateway-owned session.')])

    // Seed the config home the way a real install is: the tmux harness writes
    // provider settings, trust and API-key approval. A spawned child needs all
    // three, and `web start` alone writes none of them.
    session = new TmuxSession({
      serverUrl: server.url,
      reuseConfigDir: dirs.config,
      reuseHomeDir: dirs.home,
    })
    await session.start()
    const workdir = session.cwd

    const started = await runCli(
      dirs,
      ['web', 'start', '--tunnel', 'none', '--password-stdin'],
      PASSWORD,
    )
    const match = /http:\/\/127\.0\.0\.1:\d+/.exec(started)
    if (!match) throw new Error(`no gateway URL:\n${started}`)
    baseUrl = match[0]

    const client = new GatewayClient(baseUrl)
    expect(await client.login(PASSWORD)).toBe(200)

    // The child inherits the gateway's env, so it points at the mock server
    // and the same isolated config home.
    const created = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: client.cookie,
        'x-freecode-csrf': client.csrf,
      },
      body: JSON.stringify({ cwd: workdir }),
    })
    if (created.status !== 200) {
      throw new Error(
        `create failed: ${created.status} ${await created.text()}`,
      )
    }
    expect(created.status).toBe(200)
    const { session: child } = (await created.json()) as {
      session: { pid: number; processKey: string }
    }
    expect(child.processKey).toMatch(/^\d+:/)

    const { socket, frames } = await client.openSocket()
    try {
      socket.send(
        JSON.stringify({
          type: 'attach',
          processKey: child.processKey,
          csrf: client.csrf,
        }),
      )
      const snapshot = await waitFor(
        () => frames,
        list =>
          list.some(
            f =>
              f.type === 'event' &&
              (f.event as { kind: string }).kind === 'snapshot',
          ),
        { description: 'the child session snapshot' },
      )
      const meta = (
        snapshot.find(
          f =>
            f.type === 'event' &&
            (f.event as { kind: string }).kind === 'snapshot',
        )!.event as { meta: { sessionEpoch: number } }
      ).meta

      socket.send(
        JSON.stringify({
          type: 'command',
          id: 'c1',
          body: {
            kind: 'submit',
            commandId: crypto.randomUUID(),
            content: 'a prompt for the owned session',
            delivery: 'next',
            sessionEpoch: meta.sessionEpoch,
          },
        }),
      )

      const log = await waitForRequestCount(server, 1, {
        description: 'the owned session reaching the API',
      })
      expect(JSON.stringify(log[0]!.body.messages)).toContain(
        'a prompt for the owned session',
      )
    } finally {
      socket.close()
    }

    // Re-attach after a full detach, which a browser does on every reload.
    // Note this does not deterministically catch the temporal-dead-zone fault
    // that once broke it, because that depended on startup timing.
    await sleep(1000)
    const second = await client.openSocket()
    try {
      second.socket.send(
        JSON.stringify({
          type: 'attach',
          processKey: child.processKey,
          csrf: client.csrf,
        }),
      )
      await waitFor(
        () => second.frames,
        list =>
          list.some(
            f =>
              f.type === 'event' &&
              (f.event as { kind: string }).kind === 'snapshot',
          ),
        { description: 'a snapshot on the second attach', timeoutMs: 20_000 },
      )
    } finally {
      second.socket.close()
    }

    // Stopping the web service stops sessions it owns.
    await runCli(dirs, ['web', 'stop'])
    await waitFor(
      () => {
        try {
          process.kill(child.pid, 0)
          return true
        } catch {
          return false
        }
      },
      alive => !alive,
      { description: 'the owned session to exit', timeoutMs: 20_000 },
    )
  })

  test('resumes a past session and refuses a live or unknown one', async () => {
    dirs = await makeDirs()
    server.reset([
      textResponse('An answer from before the stop.'),
      textResponse('An answer from after the resume.'),
    ])

    // The tmux harness is the only thing that writes provider settings, trust
    // and API-key approval, and a spawned child needs all three.
    session = new TmuxSession({
      serverUrl: server.url,
      reuseConfigDir: dirs.config,
      reuseHomeDir: dirs.home,
    })
    await session.start()
    const workdir = session.cwd

    const started = await runCli(
      dirs,
      ['web', 'start', '--tunnel', 'none', '--password-stdin'],
      PASSWORD,
    )
    const match = /http:\/\/127\.0\.0\.1:\d+/.exec(started)
    if (!match) throw new Error(`no gateway URL:\n${started}`)
    baseUrl = match[0]

    const client = new GatewayClient(baseUrl)
    expect(await client.login(PASSWORD)).toBe(200)

    const post = (body: unknown): Promise<Response> =>
      fetch(`${baseUrl}/api/sessions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: client.cookie,
          'x-freecode-csrf': client.csrf,
        },
        body: JSON.stringify(body),
      })

    // A resume ID never reaches argv unvalidated.
    expect((await post({ resumeSessionId: 'not-a-uuid' })).status).toBe(400)
    expect((await post({ resumeSessionId: crypto.randomUUID() })).status).toBe(
      404,
    )

    const created = await post({ cwd: workdir })
    expect(created.status).toBe(200)
    const { session: child } = (await created.json()) as {
      session: { pid: number; processKey: string; sessionId: string }
    }

    // Drive one turn, so the resumed session has something to carry back.
    const MARKER = 'a prompt that must survive the resume'
    const first = await client.openSocket()
    try {
      first.socket.send(
        JSON.stringify({
          type: 'attach',
          processKey: child.processKey,
          csrf: client.csrf,
        }),
      )
      const snapshot = await waitFor(
        () => first.frames,
        list =>
          list.some(
            f =>
              f.type === 'event' &&
              (f.event as { kind: string }).kind === 'snapshot',
          ),
        { description: 'the child snapshot' },
      )
      const meta = (
        snapshot.find(
          f =>
            f.type === 'event' &&
            (f.event as { kind: string }).kind === 'snapshot',
        )!.event as { meta: { sessionEpoch: number } }
      ).meta

      first.socket.send(
        JSON.stringify({
          type: 'command',
          id: 'r1',
          body: {
            kind: 'submit',
            commandId: crypto.randomUUID(),
            content: MARKER,
            delivery: 'next',
            sessionEpoch: meta.sessionEpoch,
          },
        }),
      )
      await waitForRequestCount(server, 1, {
        description: 'the first turn reaching the API',
      })
    } finally {
      first.socket.close()
    }

    // A live session cannot be resumed. The client hides the action, and the
    // server refuses it regardless.
    expect((await post({ resumeSessionId: child.sessionId })).status).toBe(409)

    const deleted = await fetch(`${baseUrl}/api/sessions/${child.pid}`, {
      method: 'DELETE',
      headers: { cookie: client.cookie, 'x-freecode-csrf': client.csrf },
    })
    expect(deleted.status).toBe(200)

    // Wait for the transcript to land on disk as a resumable history row.
    await waitFor(
      async () => {
        const { sessions } = await client.sessions()
        return sessions.find(e => e.sessionId === child.sessionId)
      },
      entry => Boolean(entry) && !entry!.live,
      { description: 'the stopped child to become history', timeoutMs: 30_000 },
    )

    const resumed = await post({ resumeSessionId: child.sessionId })
    if (resumed.status !== 200) {
      throw new Error(
        `resume failed: ${resumed.status} ${await resumed.text()}`,
      )
    }
    const { session: revived } = (await resumed.json()) as {
      session: { pid: number; processKey: string; sessionId: string }
    }
    // Resume adopts the original ID rather than forking a new one.
    expect(revived.sessionId).toBe(child.sessionId)
    expect(revived.pid).not.toBe(child.pid)

    const second = await client.openSocket()
    try {
      second.socket.send(
        JSON.stringify({
          type: 'attach',
          processKey: revived.processKey,
          csrf: client.csrf,
        }),
      )
      // The first snapshot can be empty: the attach host serializes whatever
      // the runtime holds, and the headless bridge publishes the transcript on
      // a poll. So accept the marker from a later patch too.
      await waitFor(
        () => second.frames,
        list => JSON.stringify(list).includes(MARKER),
        {
          description: 'the prior transcript on the resumed session',
          timeoutMs: 30_000,
        },
      )
    } finally {
      second.socket.close()
    }

    // One live row for the resumed ID, and no leftover history row for it.
    const { sessions: after } = await client.sessions()
    const rows = after.filter(e => e.sessionId === child.sessionId)
    expect(rows.length).toBe(1)
    expect(rows[0]!.live).toBe(true)
  })

  test('stops a session it owns and refuses one it does not', async () => {
    dirs = await makeDirs()
    server.reset([textResponse('unused')])

    session = new TmuxSession({
      serverUrl: server.url,
      reuseConfigDir: dirs.config,
      reuseHomeDir: dirs.home,
    })
    await session.start()
    const workdir = session.cwd
    const terminalPid = await waitForAttachablePid(dirs.config)

    const started = await runCli(
      dirs,
      ['web', 'start', '--tunnel', 'none', '--password-stdin'],
      PASSWORD,
    )
    const match = /http:\/\/127\.0\.0\.1:\d+/.exec(started)
    if (!match) throw new Error(`no gateway URL:\n${started}`)
    baseUrl = match[0]

    const client = new GatewayClient(baseUrl)
    expect(await client.login(PASSWORD)).toBe(200)

    const created = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: client.cookie,
        'x-freecode-csrf': client.csrf,
      },
      body: JSON.stringify({ cwd: workdir }),
    })
    expect(created.status).toBe(200)
    const { session: child } = (await created.json()) as {
      session: { pid: number; processKey: string }
    }

    // The list must distinguish the two, or the UI cannot decide which row
    // gets a stop button.
    const listed = await waitFor(
      () => client.sessions(),
      value => value.sessions.some(s => s.owned),
      { description: 'the owned session to appear as owned' },
    )
    expect(listed.sessions.find(s => s.pid === child.pid)?.owned).toBe(true)
    expect(listed.sessions.find(s => s.pid === terminalPid)?.owned).toBe(false)

    function del(pid: number, csrf = client.csrf): Promise<Response> {
      return fetch(`${baseUrl}/api/sessions/${pid}`, {
        method: 'DELETE',
        headers: { cookie: client.cookie, 'x-freecode-csrf': csrf },
      })
    }

    // The terminal session belongs to the user, not the browser.
    expect((await del(terminalPid)).status).toBe(403)
    expect((await del(child.pid, 'forged')).status).toBe(403)
    expect(
      (
        await fetch(`${baseUrl}/api/sessions/${child.pid}`, {
          method: 'DELETE',
        })
      ).status,
    ).toBe(401)

    // The terminal session survived every refusal above.
    expect(() => process.kill(terminalPid, 0)).not.toThrow()

    expect((await del(child.pid)).status).toBe(200)
    await waitFor(
      () => {
        try {
          process.kill(child.pid, 0)
          return true
        } catch {
          return false
        }
      },
      alive => !alive,
      { description: 'the owned session to exit', timeoutMs: 20_000 },
    )
    expect(() => process.kill(terminalPid, 0)).not.toThrow()
  })

  test('terminal joins a web session and sees engine exit when the child is stopped', async () => {
    dirs = await makeDirs()
    server.reset([
      textResponse('An answer from the web session.'),
    ])

    // The tmux harness is the only thing that writes provider settings, trust
    // and API-key approval, and a spawned child needs all three.
    session = new TmuxSession({
      serverUrl: server.url,
      reuseConfigDir: dirs.config,
      reuseHomeDir: dirs.home,
    })
    await session.start()
    const workdir = session.cwd

    const started = await runCli(
      dirs,
      ['web', 'start', '--tunnel', 'none', '--password-stdin'],
      PASSWORD,
    )
    const match = /http:\/\/127\.0\.0\.1:\d+/.exec(started)
    if (!match) throw new Error(`no gateway URL:\n${started}`)
    baseUrl = match[0]

    const client = new GatewayClient(baseUrl)
    expect(await client.login(PASSWORD)).toBe(200)

    const created = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: client.cookie,
        'x-freecode-csrf': client.csrf,
      },
      body: JSON.stringify({ cwd: workdir }),
    })
    expect(created.status).toBe(200)
    const { session: child } = (await created.json()) as {
      session: { pid: number; processKey: string; sessionId: string }
    }

    const browser = await client.openSocket()
    try {
      browser.socket.send(
        JSON.stringify({
          type: 'attach',
          processKey: child.processKey,
          csrf: client.csrf,
        }),
      )
      const snapshot = await waitFor(
        () => browser.frames,
        list =>
          list.some(
            f =>
              f.type === 'event' &&
              (f.event as { kind: string }).kind === 'snapshot',
          ),
        { description: 'the child snapshot' },
      )
      const meta = (
        snapshot.find(
          f =>
            f.type === 'event' &&
            (f.event as { kind: string }).kind === 'snapshot',
        )!.event as { meta: { sessionEpoch: number } }
      ).meta

      // Drive one turn so the transcript has content for the terminal to see.
      browser.socket.send(
        JSON.stringify({
          type: 'command',
          id: 't1',
          body: {
            kind: 'submit',
            commandId: crypto.randomUUID(),
            content: 'a prompt for the web session',
            delivery: 'next',
            sessionEpoch: meta.sessionEpoch,
          },
        }),
      )
      await waitForRequestCount(server, 1, {
        description: 'the web session turn reaching the API',
      })
      await waitFor(
        async () => {
          const root = join(dirs.config, 'projects')
          const projects = await readdir(root).catch(() => [] as string[])
          for (const project of projects) {
            const files = await readdir(join(root, project)).catch(
              () => [] as string[],
            )
            if (files.includes(`${child.sessionId}.jsonl`)) return true
          }
          return false
        },
        found => found,
        { description: 'the transcript to land on disk', timeoutMs: 30_000 },
      )

      // A terminal joins the session as an attach client. "Join this
      // session" is the first (already-selected) option in the conflict
      // dialog.
      takeover = new TmuxSession({
        serverUrl: server.url,
        cwd: workdir,
        reuseConfigDir: dirs.config,
        reuseHomeDir: dirs.home,
        additionalArgs: ['--resume', child.sessionId],
        readyText: 'Session already open elsewhere',
      })
      await takeover.start()
      await takeover.sendKeys('Enter')
      await takeover.waitForText('Enter to send', 30_000)

      // The terminal sees the transcript from the web session.
      await takeover.waitForText('An answer from the web session', 10_000)

      // Joining does not create a second holder. The web child remains the
      // sole session engine; the terminal is a pure attach client.
      const listing = await client.sessions()
      const rows = listing.sessions.filter(
        s => s.sessionId === child.sessionId,
      )
      expect(rows).toHaveLength(1)
      expect(rows[0]!.holders).toBe(1)
      expect(rows[0]!.owned).toBe(true)
      expect(rows[0]!.stoppablePid).toBe(child.pid)

      // Stop the web child. The browser gets process_gone.
      const deleted = await fetch(`${baseUrl}/api/sessions/${child.pid}`, {
        method: 'DELETE',
        headers: { cookie: client.cookie, 'x-freecode-csrf': client.csrf },
      })
      expect(deleted.status).toBe(200)

      const gone = await waitFor(
        () => browser.frames,
        list => list.some(f => f.type === 'process_gone'),
        { description: 'the process_gone frame', timeoutMs: 30_000 },
      )
      const frame = gone.find(f => f.type === 'process_gone')!
      expect(frame.processKey).toBe(child.processKey)
      expect(frame.sessionId).toBe(child.sessionId)

      // The terminal detects the engine exit.
      await takeover.waitForText('Session engine exited', 30_000)
    } finally {
      browser.socket.close()
    }
  })

  test('publishes a tunnel URL from a custom command provider', async () => {
    dirs = await makeDirs()
    // A fake emitter, so the suite never depends on a real tunnel service.
    const output = await runCli(
      dirs,
      [
        'web',
        'start',
        '--tunnel',
        'command',
        '--tunnel-command',
        'echo https://fake-tunnel.example; sleep 30',
        '--password-stdin',
      ],
      PASSWORD,
    )
    expect(output).toContain('https://fake-tunnel.example')

    const status = await runCli(dirs, ['web', 'status'])
    expect(status).toContain('https://fake-tunnel.example')
  })

  test('restart replaces the daemon and keeps the tunnel URL', async () => {
    dirs = await makeDirs()
    const started = await runCli(
      dirs,
      [
        'web',
        'start',
        '--tunnel',
        'command',
        '--tunnel-command',
        'echo https://kept-name.example; sleep 60',
        '--password-stdin',
      ],
      PASSWORD,
    )
    expect(started).toContain('https://kept-name.example')
    const firstPid = (
      await readFile(join(dirs.config, 'daemon.pid'), 'utf-8')
    ).trim()

    // Restart must replace the supervisor process. Reloading the gateway
    // inside the old one could never pick up a new build.
    const restarted = await runCli(dirs, ['web', 'restart'])
    const secondPid = (
      await readFile(join(dirs.config, 'daemon.pid'), 'utf-8')
    ).trim()

    expect(secondPid).not.toBe(firstPid)
    expect(restarted).toContain('https://kept-name.example')
    expect(await runCli(dirs, ['web', 'status'])).toContain(
      'https://kept-name.example',
    )
  })

  test('restarts the daemon from the browser, and refuses a forged CSRF', async () => {
    dirs = await makeDirs()
    const output = await runCli(
      dirs,
      [
        'web',
        'start',
        '--tunnel',
        'command',
        '--tunnel-command',
        'echo https://browser-restart.example; sleep 60',
        '--password-stdin',
      ],
      PASSWORD,
    )
    const match = /http:\/\/127\.0\.0\.1:\d+/.exec(output)
    if (!match) throw new Error(`no gateway URL in output:\n${output}`)
    const client = new GatewayClient(match[0])
    expect(await client.login(PASSWORD)).toBe(200)

    // The password behind this authorizes command execution, so the route takes
    // the same gate as starting a session.
    expect(await client.restart('forged')).toBe(403)

    const firstPid = (
      await readFile(join(dirs.config, 'daemon.pid'), 'utf-8')
    ).trim()

    // 202, not 200: the answer has to leave before the restart destroys the
    // listener carrying it.
    expect(await client.restart()).toBe(202)

    // The supervisor is replaced, which is the point. Reloading inside the old
    // process could never pick up a rebuilt binary. gracefulRestart writes the
    // new PID after spawning the replacement.
    const secondPid = await waitFor(
      async () =>
        (await readFile(join(dirs.config, 'daemon.pid'), 'utf-8')).trim(),
      pid => pid.length > 0 && pid !== firstPid,
      { description: 'the daemon pid to change' },
    )
    expect(secondPid).not.toBe(firstPid)

    // Only now is the URL meaningful. The pid appears when the new supervisor
    // spawns, which is before its gateway has bound and asked for the hostname.
    expect(
      await waitFor(
        () => runCli(dirs, ['web', 'status']),
        text => text.includes('https://browser-restart.example'),
        { description: 'the replacement gateway to publish its URL' },
      ),
    ).toContain('https://browser-restart.example')
  })
})
