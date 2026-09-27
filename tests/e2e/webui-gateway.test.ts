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
import {
  type DaemonControlRequest,
  sendDaemonControl,
} from '../../src/webui/daemonControl'
import { textResponse } from '../helpers/fixture-builders'
import { MockAnthropicServer } from '../helpers/mock-server'
import { waitForRequestCount } from '../helpers/mock-server-wait'
import { waitFor } from '../helpers/wait-helpers'
import { createLoggingTest, sleep, TmuxSession } from './tmux-helpers'
import type { WireEvent, WireEventEnvelope } from '../../src/session/wire'

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

async function sendControlRequest(
  configDir: string,
  request: DaemonControlRequest,
): Promise<{ ok: boolean; error?: string }> {
  const response = await sendDaemonControl(
    request,
    15_000,
    join(configDir, 'webui', 'control.sock'),
  )
  if (!response) return { ok: false, error: 'the daemon is not listening' }
  return response.ok ? { ok: true } : { ok: false, error: response.error }
}

async function waitForExit(pid: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch {
      return
    }
    await sleep(50)
  }
  try {
    process.kill(pid, 'SIGKILL')
  } catch {}
}

async function captureDaemonPid(dirs: Dirs): Promise<number | undefined> {
  try {
    return parseInt(
      await readFile(join(dirs.config, 'daemon.pid'), 'utf-8'),
      10,
    )
  } catch {
    return undefined
  }
}

/** One opened session-event stream, as a browser's EventSource would be. */
type EventStream = {
  envelopes: WireEventEnvelope[]
  /** True once the stream has ended — process gone or stream cancelled. */
  readonly done: boolean
  close(): void
}

/** A logged-in HTTP client, the way a browser would arrive. */
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
      role?: string
      cwd?: string
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

  /** Opens the proxied session event stream (an EventSource in the browser). */
  async openStream(processKey: string): Promise<EventStream> {
    const response = await fetch(
      `${this.baseUrl}/api/sessions/${processKey}/events`,
      { headers: { cookie: this.cookie } },
    )
    if (!response.ok || !response.body) {
      throw new Error(`events route answered ${response.status}`)
    }
    const envelopes: WireEventEnvelope[] = []
    const reader = response.body
      .pipeThrough(new TextDecoderStream())
      .getReader()
    let done = false
    void (async () => {
      let buffer = ''
      for (;;) {
        const result = await reader.read()
        if (result.done) break
        buffer += result.value
        let boundary = buffer.indexOf('\n\n')
        while (boundary >= 0) {
          const frame = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          const dataLine = frame
            .split('\n')
            .find(line => line.startsWith('data: '))
          if (dataLine) {
            envelopes.push(JSON.parse(dataLine.slice(6)) as WireEventEnvelope)
          }
          boundary = buffer.indexOf('\n\n')
        }
      }
      done = true
    })()
    return {
      envelopes,
      get done() {
        return done
      },
      close() {
        if (!done) reader.cancel().catch(() => {})
      },
    }
  }

  /** POSTs a wire command to a session, as the browser's api.ts does. */
  command(
    processKey: string,
    route: string,
    body: unknown,
    options: { csrf?: string | null } = {},
  ): Promise<Response> {
    const csrf = options.csrf === undefined ? this.csrf : options.csrf
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      cookie: this.cookie,
      origin: this.baseUrl,
    }
    if (csrf !== null) headers['x-freecode-csrf'] = csrf
    return fetch(`${this.baseUrl}/api/sessions/${processKey}/${route}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })
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

/**
 * Wait until a freshly spawned child has registered its REPL runtime. The
 * surface snapshot arrives as soon as the host starts, which is before the
 * child's REPL mounts, and a submit landing before registration is refused
 * with runtime_not_ready. Only a registered runtime can put permissionMode
 * in a meta event (registerRuntime fires publishMeta), so that field is the
 * readiness signal — without it these tests win the race against the child's
 * boot every time.
 */
async function waitForRuntimeReady(
  envelopes: WireEventEnvelope[],
  description: string,
): Promise<void> {
  await waitFor(
    () => envelopes,
    list =>
      list.some(e => {
        const event = e.event as
          | { kind?: string; meta?: { permissionMode?: string } }
          | undefined
        return (
          event?.kind === 'meta' && event.meta?.permissionMode !== undefined
        )
      }),
    {
      description: `${description} to register its runtime`,
      timeoutMs: 30_000,
    },
  )
}

function findEvent<E extends WireEvent['kind']>(
  envelopes: WireEventEnvelope[],
  kind: E,
): Extract<WireEvent, { kind: E }> | undefined {
  return envelopes
    .map(e => e.event)
    .find(
      (event): event is Extract<WireEvent, { kind: E }> => event.kind === kind,
    )
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
  const daemonPids: number[] = []
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
      await Promise.all(daemonPids.map(pid => waitForExit(pid)))
      daemonPids.length = 0
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
    {
      const p = await captureDaemonPid(dirs)
      if (p) daemonPids.push(p)
    }
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

  test('lists a live terminal session and drives it over the proxy routes', async () => {
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

    const stream = await client.openStream(live.processKey!)
    try {
      const snapshot = await waitFor(
        () => findEvent(stream.envelopes, 'snapshot'),
        event => event !== undefined,
        { description: 'the session snapshot' },
      )
      const meta = snapshot!.meta

      const submitted = await client.command(live.processKey!, 'prompt', {
        kind: 'prompt',
        commandId: crypto.randomUUID(),
        content: 'a prompt sent through the gateway',
        delivery: 'next',
        sessionEpoch: meta.sessionEpoch,
      })
      expect(submitted.status).toBe(200)

      const log = await waitForRequestCount(server, 1, {
        description: 'the gateway-submitted prompt reaching the API',
      })
      expect(JSON.stringify(log[0]!.body.messages)).toContain(
        'a prompt sent through the gateway',
      )
    } finally {
      stream.close()
    }
  })

  test('refuses a session command without a CSRF token', async () => {
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

    const refused = await client.command(
      live.processKey!,
      'prompt',
      {
        kind: 'prompt',
        commandId: crypto.randomUUID(),
        content: 'unforged',
        delivery: 'next',
        sessionEpoch: 0,
      },
      { csrf: null },
    )
    expect(refused.status).toBe(403)
    expect(((await refused.json()) as { error: string }).error).toBe('bad_csrf')

    // The wrong token answers the same way.
    const forged = await client.command(
      live.processKey!,
      'prompt',
      {
        kind: 'prompt',
        commandId: crypto.randomUUID(),
        content: 'unforged',
        delivery: 'next',
        sessionEpoch: 0,
      },
      { csrf: 'forged' },
    )
    expect(forged.status).toBe(403)

    // Neither refusal ran the command.
    await sleep(500)
    expect(server.getRequestCount()).toBe(0)
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
    {
      const p = await captureDaemonPid(dirs)
      if (p) daemonPids.push(p)
    }

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
    const { session: child } = (await created.json()) as {
      session: { pid: number; processKey: string }
    }
    expect(child.processKey).toMatch(/^\d+:/)

    const stream = await client.openStream(child.processKey)
    try {
      const snapshot = await waitFor(
        () => findEvent(stream.envelopes, 'snapshot'),
        event => event !== undefined,
        { description: 'the child session snapshot' },
      )
      await waitForRuntimeReady(stream.envelopes, 'the owned session')

      const submitted = await client.command(child.processKey, 'prompt', {
        kind: 'prompt',
        commandId: crypto.randomUUID(),
        content: 'a prompt for the owned session',
        delivery: 'next',
        sessionEpoch: snapshot!.meta.sessionEpoch,
      })
      expect(submitted.status).toBe(200)

      const log = await waitForRequestCount(server, 1, {
        description: 'the owned session reaching the API',
      })
      expect(JSON.stringify(log[0]!.body.messages)).toContain(
        'a prompt for the owned session',
      )
    } finally {
      stream.close()
    }

    // Re-subscribe after a full disconnect, which a browser does on every
    // reload: a fresh stream must snapshot, not fail on the used-up socket.
    await sleep(1000)
    const second = await client.openStream(child.processKey)
    try {
      await waitFor(
        () => findEvent(second.envelopes, 'snapshot'),
        event => event !== undefined,
        { description: 'a snapshot on the second stream', timeoutMs: 20_000 },
      )
    } finally {
      second.close()
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
    {
      const p = await captureDaemonPid(dirs)
      if (p) daemonPids.push(p)
    }

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
    const first = await client.openStream(child.processKey)
    try {
      const snapshot = await waitFor(
        () => findEvent(first.envelopes, 'snapshot'),
        event => event !== undefined,
        { description: 'the child snapshot' },
      )
      await waitForRuntimeReady(first.envelopes, 'the resumed session')
      await client.command(child.processKey, 'prompt', {
        kind: 'prompt',
        commandId: crypto.randomUUID(),
        content: MARKER,
        delivery: 'next',
        sessionEpoch: snapshot!.meta.sessionEpoch,
      })
      await waitForRequestCount(server, 1, {
        description: 'the first turn reaching the API',
      })
    } finally {
      first.close()
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

    const second = await client.openStream(revived.processKey)
    try {
      // The first snapshot can be empty: the surface serializes whatever the
      // runtime holds at connect time. So accept the marker from a later
      // patch too.
      await waitFor(
        () => second.envelopes,
        list => JSON.stringify(list).includes(MARKER),
        {
          description: 'the prior transcript on the resumed session',
          timeoutMs: 30_000,
        },
      )
    } finally {
      second.close()
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
    {
      const p = await captureDaemonPid(dirs)
      if (p) daemonPids.push(p)
    }

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
    server.reset([textResponse('An answer from the web session.')])

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
    {
      const p = await captureDaemonPid(dirs)
      if (p) daemonPids.push(p)
    }

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

    const browser = await client.openStream(child.processKey)
    try {
      const snapshot = await waitFor(
        () => findEvent(browser.envelopes, 'snapshot'),
        event => event !== undefined,
        { description: 'the child snapshot' },
      )

      // Drive one turn so the transcript has content for the terminal to see.
      await waitForRuntimeReady(browser.envelopes, 'the web session')
      await client.command(child.processKey, 'prompt', {
        kind: 'prompt',
        commandId: crypto.randomUUID(),
        content: 'a prompt for the web session',
        delivery: 'next',
        sessionEpoch: snapshot!.meta.sessionEpoch,
      })
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

      // A terminal joins the session as a wire-surface client. "Join this
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
      // sole session engine; the terminal is a pure surface client.
      const listing = await client.sessions()
      const rows = listing.sessions.filter(s => s.sessionId === child.sessionId)
      expect(rows).toHaveLength(1)
      expect(rows[0]!.holders).toBe(1)
      expect(rows[0]!.owned).toBe(true)
      expect(rows[0]!.stoppablePid).toBe(child.pid)

      // Stop the web child. The browser's stream ends with the process.
      const deleted = await fetch(`${baseUrl}/api/sessions/${child.pid}`, {
        method: 'DELETE',
        headers: { cookie: client.cookie, 'x-freecode-csrf': client.csrf },
      })
      expect(deleted.status).toBe(200)

      await waitFor(
        () => browser.done,
        ended => ended,
        { description: 'the browser stream to end', timeoutMs: 30_000 },
      )

      // The terminal detects the engine exit.
      await takeover.waitForText('Session engine exited', 30_000)
    } finally {
      browser.close()
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
    {
      const p = await captureDaemonPid(dirs)
      if (p) daemonPids.push(p)
    }

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
    {
      const p = await captureDaemonPid(dirs)
      if (p) daemonPids.push(p)
    }
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
    daemonPids.push(parseInt(secondPid, 10))
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
    {
      const p = await captureDaemonPid(dirs)
      if (p) daemonPids.push(p)
    }
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
    daemonPids.push(parseInt(secondPid, 10))

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

  test('hosts an assistant main chat when assistant.enabled is set', async () => {
    dirs = await makeDirs()
    server.reset([textResponse('Standing by after the notification.')])

    // Seed provider settings, trust and API-key approval the same way, then
    // enable the assistant BEFORE `web start` — the gateway reads the setting
    // once, when it bootstraps the chat.
    session = new TmuxSession({
      serverUrl: server.url,
      reuseConfigDir: dirs.config,
      reuseHomeDir: dirs.home,
    })
    await session.start()
    const settingsPath = join(dirs.config, 'freecode.json')
    const seeded = JSON.parse(await readFile(settingsPath, 'utf-8'))
    await writeFile(
      settingsPath,
      JSON.stringify({ ...seeded, assistant: { enabled: true } }),
    )

    const started = await runCli(
      dirs,
      ['web', 'start', '--tunnel', 'none', '--password-stdin'],
      PASSWORD,
    )
    const match = /http:\/\/127\.0\.0\.1:\d+/.exec(started)
    if (!match) throw new Error(`no gateway URL:\n${started}`)
    baseUrl = match[0]
    {
      const p = await captureDaemonPid(dirs)
      if (p) daemonPids.push(p)
    }
    const client = new GatewayClient(baseUrl)
    expect(await client.login(PASSWORD)).toBe(200)

    const assistantRow = await waitFor(
      async () => {
        const res = await fetch(`${baseUrl}/api/sessions`, {
          headers: { cookie: client.cookie },
        })
        const body = (await res.json()) as {
          sessions: { role?: string; live?: boolean; cwd?: string }[]
        }
        return body.sessions.find(s => s.role === 'assistant')
      },
      row => row?.live === true,
      {
        description: 'the assistant row to go live',
        timeoutMs: 60_000,
      },
    )
    // The chat runs in the gateway's own workspace, not a terminal directory.
    expect(assistantRow.cwd).toEndWith(join('webui', 'assistant'))

    // External events arrive as prompt turns through the control socket —
    // the assistant has no tick loop, so this is what wakes it. The queued
    // mock response is consumed only when the injected prompt runs.
    const requestsBefore = server.getRequestCount()
    const control = await sendControlRequest(dirs.config, {
      kind: 'assistant.notify',
      text: 'Status check from the audit.',
    })
    expect(control.ok, `assistant.notify failed: ${control.error}`).toBe(true)
    await waitFor(
      () => server.getRequestCount(),
      count => count > requestsBefore,
      {
        description: 'the notified prompt to reach the model',
        timeoutMs: 30_000,
      },
    )

    // A gateway restart must carry the chat forward, not orphan it.
    await runCli(dirs, ['web', 'stop'])
    const pointer = JSON.parse(
      await readFile(
        join(dirs.config, 'webui', 'assistant-session.json'),
        'utf-8',
      ),
    ) as { sessionId?: unknown }
    expect(typeof pointer.sessionId).toBe('string')
  })
})
