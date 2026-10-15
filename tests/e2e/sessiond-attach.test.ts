/**
 * sessiond + `cli-dev attach`: one hosted session driven from both sides.
 *
 * The serve runs in the foreground (no daemon), a session is created over
 * the browser API, and a terminal runs `claude attach <sessionId>` against
 * it. The test then proves both directions of the trunk — a prompt sent
 * over HTTP shows up in the tmux pane, and a prompt typed into the pane
 * reaches the API and the test's own event stream — and that the attach is
 * a viewer, not an owner: killing the terminal leaves the session live.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test as bunTest,
} from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
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

let server: MockAnthropicServer
let serve: ReturnType<typeof Bun.spawn> | undefined
let terminal: TmuxSession | undefined
let configDir = ''
let homeDir = ''
let baseUrl = ''

function env(): Record<string, string> {
  return {
    ...process.env,
    FREECODE_CONFIG_DIR: configDir,
    CLAUDE_CONFIG_DIR: configDir,
    HOME: homeDir,
  } as Record<string, string>
}

async function startServe(): Promise<void> {
  configDir = await mkdtemp(join(tmpdir(), 'sessd-attach-config-'))
  homeDir = await mkdtemp(join(tmpdir(), 'sessd-attach-home-'))

  // Seed the config home the way the tmux harness would: provider settings,
  // trust and API-key approval. The pane command never calls the provider
  // itself — the serve does, reading this same home. (TmuxSession rewrites
  // these files equivalently when its own start() runs, after the serve is
  // already up.)
  await seedHarnessConfig()

  const proc = Bun.spawn(
    [CLI, 'web', 'serve', '--foreground', '--password-stdin'],
    {
      env: env(),
      stdin: new TextEncoder().encode(PASSWORD),
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  serve = proc
  const reader = proc.stdout.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''
  const deadline = Date.now() + 30_000
  while (!/http:\/\/127\.0\.0\.1:\d+/.test(buffer) && Date.now() < deadline) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += value
  }
  const match = /http:\/\/127\.0\.0\.1:\d+/.exec(buffer)
  if (!match) {
    throw new Error(`serve never reported a URL:\n${buffer}`)
  }
  baseUrl = match[0]
}

/** The provider/trust seeding TmuxSession would do at its own start(). */
async function seedHarnessConfig(): Promise<void> {
  const { writeFile } = await import('fs/promises')
  await writeFile(
    join(configDir, 'freecode.json'),
    JSON.stringify({
      statusLine: { type: 'off' },
      assistant: { enabled: false },
      backgroundTasksEnabled: false,
      autoMemoryEnabled: false,
      claudeMdEnabled: false,
    }),
  )
  await writeFile(
    join(configDir, 'modelSettings.json'),
    JSON.stringify({
      providers: {
        'test-anthropic': {
          type: 'anthropic',
          baseUrl: server.url,
          auth: {
            active: 'apiKey',
            apiKey: { key: 'test-key-e2e-integration-99' },
          },
          models: [{ id: 'claude-sonnet-4-20250514' }],
        },
      },
      defaultModel: 'test-anthropic:claude-sonnet-4-20250514',
    }),
  )
  await writeFile(
    join(configDir, 'state.json'),
    JSON.stringify({
      customApiKeyResponses: {
        approved: ['y-e2e-integration-99'],
        rejected: [],
      },
      projects: {},
    }),
  )
}

afterEach(async () => {
  if (terminal) {
    await terminal.stop()
    terminal = undefined
  }
  if (serve) {
    serve.kill('SIGTERM')
    await serve.exited.catch(() => {})
    serve = undefined
  }
  baseUrl = ''
  if (configDir) {
    await rm(configDir, { recursive: true, force: true })
    await rm(homeDir, { recursive: true, force: true })
    configDir = ''
  }
})

beforeAll(async () => {
  server = new MockAnthropicServer()
  await server.start()
})

afterAll(() => {
  server.stop()
})

/** A logged-in browser-side client, minimal for this test. */
async function login(): Promise<{ cookie: string; csrf: string }> {
  const response = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  })
  expect(response.status).toBe(200)
  const body = (await response.json()) as { csrf: string }
  return {
    cookie: (response.headers.get('set-cookie') ?? '').split(';')[0] ?? '',
    csrf: body.csrf,
  }
}

type EventStream = {
  envelopes: WireEventEnvelope[]
  close(): void
}

async function openStream(
  processKey: string,
  cookie: string,
): Promise<EventStream> {
  const response = await fetch(`${baseUrl}/api/sessions/${processKey}/events`, {
    headers: { cookie },
  })
  expect(response.ok).toBe(true)
  const envelopes: WireEventEnvelope[] = []
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader()
  let closed = false
  void (async () => {
    let buffer = ''
    while (!closed) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += value
      let boundary = buffer.indexOf('\n\n')
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const dataLine = frame
          .split('\n')
          .find(line => line.startsWith('data: '))
        if (dataLine) {
          try {
            envelopes.push(JSON.parse(dataLine.slice(6)) as WireEventEnvelope)
          } catch {
            // unparseable frame: skip, same posture as the surface client
          }
        }
        boundary = buffer.indexOf('\n\n')
      }
    }
  })()
  return {
    envelopes,
    close() {
      closed = true
      reader.cancel().catch(() => {})
    },
  }
}

function findEvent<E extends WireEvent['kind']>(
  envelopes: WireEventEnvelope[],
  kind: E,
): Extract<WireEvent, { kind: E }> | undefined {
  for (const envelope of envelopes) {
    if (envelope.event.kind === kind) {
      return envelope.event as Extract<WireEvent, { kind: E }>
    }
  }
  return undefined
}

describe('sessiond attach (TUI as a sessiond client)', () => {
  test('a hosted session answers both terminals and outlives the attached one', async () => {
    // Two canned replies: first request is the browser-submitted prompt,
    // second the pane-submitted one.
    server.reset([
      textResponse('PANE-SIDE-REPLY-FROM-BROWSER'),
      textResponse('STREAM-SIDE-REPLY-FROM-PANE'),
    ])
    await startServe()
    const { cookie, csrf } = await login()

    const workdir = await mkdtemp(join(tmpdir(), 'sessd-attach-cwd-'))
    const created = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: baseUrl,
        cookie,
        'x-freecode-csrf': csrf,
      },
      body: JSON.stringify({ cwd: workdir }),
    })
    expect(created.status).toBe(200)
    const { session: child } = (await created.json()) as {
      session: { processKey: string; sessionId: string }
    }

    const stream = await openStream(child.processKey, cookie)
    await waitFor(
      () => findEvent(stream.envelopes, 'snapshot'),
      event => event !== undefined,
      { description: 'the hosted session snapshot on the test stream' },
    )

    // The terminal joins the hosted session through the descriptor.
    terminal = new TmuxSession({
      serverUrl: server.url,
      cwd: workdir,
      reuseConfigDir: configDir,
      reuseHomeDir: homeDir,
      additionalArgs: ['attach', child.sessionId],
      readyText: 'Attached to',
    })
    await terminal.start()

    // Direction 1: a browser-side command over HTTP, visible in the pane.
    const submitted = await fetch(
      `${baseUrl}/api/sessions/${child.processKey}/prompt`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: baseUrl,
          cookie,
          'x-freecode-csrf': csrf,
        },
        body: JSON.stringify({
          kind: 'prompt',
          commandId: crypto.randomUUID(),
          content: 'a prompt sent from the browser side',
          delivery: 'next',
          sessionEpoch: 0,
        }),
      },
    )
    expect(submitted.status).toBe(200)
    await waitForRequestCount(server, 1, {
      description: 'the browser-submitted prompt reaching the API',
    })
    await terminal.waitForText('PANE-SIDE-REPLY-FROM-BROWSER', 30_000)

    // Direction 2: a prompt typed into the pane, visible to the API and
    // to a stream subscriber that never touched the terminal.
    await terminal.sendLine('a prompt sent from the terminal')
    const log = await waitForRequestCount(server, 2, {
      description: 'the pane-submitted prompt reaching the API',
    })
    expect(JSON.stringify(log[1]!.body.messages)).toContain(
      'a prompt sent from the terminal',
    )
    await waitFor(
      () => JSON.stringify(stream.envelopes),
      text => text.includes('STREAM-SIDE-REPLY-FROM-PANE'),
      {
        description: 'the pane-submitted turn arriving on the event stream',
        timeoutMs: 30_000,
      },
    )

    // The attach is a viewer, not an owner: the terminal goes away, the
    // session does not.
    await terminal.stop()
    terminal = undefined
    await sleep(500)
    const listed = await fetch(`${baseUrl}/api/sessions`, {
      headers: { cookie },
    })
    expect(listed.status).toBe(200)
    const { sessions } = (await listed.json()) as {
      sessions: Array<{ sessionId: string; live: boolean }>
    }
    const row = sessions.find(s => s.sessionId === child.sessionId)
    expect(row?.live).toBe(true)

    stream.close()
    await rm(workdir, { recursive: true, force: true })
  })
})
