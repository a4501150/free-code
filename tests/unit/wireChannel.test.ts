import { describe, expect, test } from 'bun:test'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'crypto'
import {
  createSessionChannel,
  type SessionChannel,
} from '../../src/server/channel.js'
import { SURFACE_TOKEN_HEADER } from '../../src/server/surface.js'
import type { SessionRuntime } from '../../src/server/runtime.js'
import { currentSessionRequests } from '../../src/session/requests.js'
import type {
  WireEvent,
  WireEventEnvelope,
  WireRequest,
} from '../../src/session/wire.js'

function stubRuntime(overrides: Partial<SessionRuntime> = {}): SessionRuntime {
  return {
    getMessages: () => [],
    getState: () => 'idle',
    getActivity: () => undefined,
    getIsCompacting: () => false,
    getModel: () => 'm',
    getPermissionMode: () => 'default',
    getTodos: () => [],
    getTasks: () => [],
    getCatalog: () => ({ models: [], commands: [], permissionModes: [] }),
    getPendingCommands: () => [],
    getInProgressToolUseIds: () => new Set(),
    submit: () => {},
    cancel: () => {},
    setMode: () => {},
    setModel: () => {},
    ...overrides,
  }
}

/**
 * The smallest registry router over channels — the same route shape the
 * surface uses, so the channel is exercised through a real listener without
 * pulling descriptors or the single-process singleton in.
 */
async function mount(
  channels: SessionChannel[],
  token: string,
): Promise<{ url: string; close: () => void }> {
  const server = createServer((request, res) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const parts = url.pathname.split('/').filter(Boolean)
    const fail = (status: number, code: string): void => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: { code } }))
    }
    if (parts[0] !== 'v1' || parts[1] !== 'sessions') {
      fail(404, 'unknown_route')
      return
    }
    const channel = channels.find(candidate => candidate.sessionId === parts[2])
    if (!channel) {
      fail(404, 'unknown_session')
      return
    }
    if (request.headers[SURFACE_TOKEN_HEADER] !== token) {
      fail(401, 'unauthorized')
      return
    }
    const rest = parts.slice(3)
    const kind = rest[0] === 'agents' ? 'agent_transcript' : rest[0]
    const params = rest[0] === 'agents' ? [rest[1]!] : rest.slice(1)
    const kindMap: Record<string, string> = {
      model: 'model_set',
      mode: 'mode_set',
    }
    if (request.method === 'GET') {
      channel.handleGet(request, res as ServerResponse, kind!, params, url)
      return
    }
    void channel.handlePost(
      request,
      res as ServerResponse,
      kindMap[kind!] ?? kind!,
    )
  })
  await new Promise<void>(resolve =>
    server.listen({ port: 0, host: '127.0.0.1' }, resolve),
  )
  const address = server.address()!
  return {
    url: `http://127.0.0.1:${typeof address === 'string' ? 0 : address.port}`,
    close: () => server.close(),
  }
}

function frameCollector(
  response: Response,
): (count: number) => Promise<WireEventEnvelope[]> {
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''
  return async count => {
    const frames: WireEventEnvelope[] = []
    while (frames.length < count) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += value
      let boundary: number
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const dataLine = frame.split('\n').find(l => l.startsWith('data: '))
        if (dataLine) frames.push(JSON.parse(dataLine.slice(6)))
      }
    }
    return frames
  }
}

function newChannel(
  overrides: Partial<Parameters<typeof createSessionChannel>[0]> = {},
): SessionChannel {
  return createSessionChannel({
    sessionId: randomUUID(),
    cwd: process.cwd(),
    startedAt: Date.now(),
    broker: currentSessionRequests(),
    ...overrides,
  })
}

async function startTwoOnOneListener(
  makeA: () => SessionChannel = newChannel,
): Promise<{
  channels: SessionChannel[]
  url: string
  token: string
  close: () => void
}> {
  const token = 'test-token'
  const channels = [makeA(), newChannel()]
  const mounted = await mount(channels, token)
  return { channels, token, ...mounted }
}

function eventsUrl(
  url: string,
  channel: SessionChannel,
  route: string,
): string {
  return `${url}/v1/sessions/${channel.sessionId}/${route}`
}

describe('session channel', () => {
  test('opens with a snapshot frame carrying its own session id', async () => {
    const { channels, url, token, close } = await startTwoOnOneListener()
    const [a] = channels
    const response = await fetch(eventsUrl(url, a, 'events'), {
      headers: { [SURFACE_TOKEN_HEADER]: token },
    })
    const frames = await frameCollector(response)(1)
    expect(frames[0]!.event.kind).toBe('snapshot')
    expect(
      (frames[0]!.event as { meta: { sessionId: string } }).meta.sessionId,
    ).toBe(a.sessionId)
    expect(frames[0]!.seq).toBe(0)
    close()
  })

  test('unknown session ids and bad tokens are refused before any channel runs', async () => {
    const { channels, url, token, close } = await startTwoOnOneListener()
    const [a] = channels
    const wrongId = await fetch(`${url}/v1/sessions/${randomUUID()}/meta`, {
      headers: { [SURFACE_TOKEN_HEADER]: token },
    })
    expect(wrongId.status).toBe(404)
    const wrongToken = await fetch(eventsUrl(url, a, 'meta'), {
      headers: { [SURFACE_TOKEN_HEADER]: 'nope' },
    })
    expect(wrongToken.status).toBe(401)
    close()
  })

  test('publishes stay on their own channel', async () => {
    const { channels, url, token, close } = await startTwoOnOneListener()
    const [a, b] = channels
    a.registerRuntime(
      stubRuntime({ getTodos: () => [{ content: 'A', status: 'pending' }] }),
    )
    b.registerRuntime(
      stubRuntime({ getTodos: () => [{ content: 'B', status: 'pending' }] }),
    )

    const response = await fetch(eventsUrl(url, a, 'events'), {
      headers: { [SURFACE_TOKEN_HEADER]: token },
    })
    const collect = frameCollector(response)
    await collect(1) // snapshot
    b.publishTodos()
    a.publishTodos()
    const frames = await collect(1)
    const event = frames[0]!.event as {
      kind: string
      todos: Array<{ content: string }>
    }
    expect(event.kind).toBe('todos')
    expect(event.todos.map(t => t.content)).toEqual(['A'])
    close()
  })

  test('replays missed events from Last-Event-ID', async () => {
    const cost = { costUsd: 0, linesAdded: 0, linesRemoved: 0 }
    const { channels, url, token, close } = await startTwoOnOneListener(() =>
      newChannel({ getCost: () => cost }),
    )
    const [a] = channels
    a.registerRuntime(
      stubRuntime({ getTodos: () => [{ content: 'x', status: 'pending' }] }),
    )

    const first = await fetch(eventsUrl(url, a, 'events'), {
      headers: { [SURFACE_TOKEN_HEADER]: token },
    })
    const snapshot = (await frameCollector(first)(1))[0]!

    a.publishTodos()
    cost.costUsd = 1
    a.publishMeta()

    const replay = await fetch(eventsUrl(url, a, 'events'), {
      headers: {
        [SURFACE_TOKEN_HEADER]: token,
        'last-event-id': String(snapshot.seq),
      },
    })
    const frames = await frameCollector(replay)(2)
    expect(frames.every(f => f.seq > snapshot.seq)).toBe(true)
    expect(frames.map(f => f.event.kind)).toEqual(['todos', 'meta'])
    close()
  })

  test('an out-of-ring Last-Event-ID resyncs with a watermark snapshot', async () => {
    const { channels, url, token, close } = await startTwoOnOneListener()
    const [a] = channels
    a.registerRuntime(
      stubRuntime({ getTodos: () => [{ content: 'x', status: 'pending' }] }),
    )
    a.publishTodos()

    const response = await fetch(eventsUrl(url, a, 'events'), {
      headers: { [SURFACE_TOKEN_HEADER]: token, 'last-event-id': '-5' },
    })
    const frames = await frameCollector(response)(2)
    expect(frames[0]!.event.kind).toBe('resync_required')
    expect(frames[1]!.event.kind).toBe('snapshot')
    close()
  })

  test('broker requests ride the channel and answer through request_respond', async () => {
    const { channels, url, token, close } = await startTwoOnOneListener()
    const [a] = channels
    a.registerRuntime(stubRuntime())
    const response = await fetch(eventsUrl(url, a, 'events'), {
      headers: { [SURFACE_TOKEN_HEADER]: token },
    })
    const collect = frameCollector(response)
    await collect(1) // snapshot

    const broker = currentSessionRequests()
    const request: WireRequest = {
      requestId: randomUUID(),
      kind: 'permission',
      openedAt: Date.now(),
      toolName: 'Bash',
      toolUseId: 'tu-1',
      description: 'run a command',
      input: { command: 'echo hi' },
    }
    let answered: unknown = null
    broker.open(request, r => (answered = r))
    const opened = await collect(1)
    expect(opened[0]!.event.kind).toBe('request_opened')

    const respond = await fetch(eventsUrl(url, a, 'request_respond'), {
      method: 'POST',
      headers: {
        [SURFACE_TOKEN_HEADER]: token,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        kind: 'request_respond',
        requestId: request.requestId,
        response: {
          kind: 'permission',
          decision: { behavior: 'deny', message: 'no' },
        },
      }),
    })
    expect(respond.status).toBe(200)
    expect(answered).toEqual({
      kind: 'permission',
      decision: { behavior: 'deny', message: 'no' },
    })
    const closed = await collect(1)
    expect(closed[0]!.event.kind).toBe('request_closed')
    close()
  })

  test('setSessionId notifies, bumps the epoch, and rejects stale prompts', async () => {
    const { channels, url, token, close } = await startTwoOnOneListener()
    const [a] = channels
    const oldId = a.sessionId
    a.registerRuntime(stubRuntime())

    const response = await fetch(eventsUrl(url, a, 'events'), {
      headers: { [SURFACE_TOKEN_HEADER]: token },
    })
    const collect = frameCollector(response)
    await collect(1) // snapshot

    a.setSessionId('sess-switched')
    const frames = await collect(1)
    const event = frames[0]!.event as {
      kind: string
      sessionId: string
      sessionEpoch: number
    }
    expect(event.kind).toBe('session_changed')
    expect(event.sessionId).toBe('sess-switched')
    expect(event.sessionEpoch).toBe(1)

    // The old id no longer names this channel; the new one takes commands.
    const staleRoute = await fetch(`${url}/v1/sessions/${oldId}/prompt`, {
      method: 'POST',
      headers: {
        [SURFACE_TOKEN_HEADER]: token,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        kind: 'prompt',
        commandId: randomUUID(),
        content: 'hello',
        delivery: 'next',
        sessionEpoch: 0,
      }),
    })
    expect(staleRoute.status).toBe(404)

    const staleEpoch = await fetch(eventsUrl(url, a, 'prompt'), {
      method: 'POST',
      headers: {
        [SURFACE_TOKEN_HEADER]: token,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        kind: 'prompt',
        commandId: randomUUID(),
        content: 'hello',
        delivery: 'next',
        sessionEpoch: 0,
      }),
    })
    expect(staleEpoch.status).toBe(409)
    expect((await staleEpoch.json()).error.code).toBe('stale_epoch')
    close()
  })
})
