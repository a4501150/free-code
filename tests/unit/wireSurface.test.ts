import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'crypto'
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  getDescriptorPath,
  readAttachDescriptor,
  verifyAttachDir,
  writeAttachDescriptor,
  ATTACH_FILE_MODE,
} from '../../src/server/descriptor.js'
import {
  SURFACE_TOKEN_HEADER,
  startWireSurface,
} from '../../src/server/surface.js'
import type { SessionRuntime } from '../../src/server/runtime.js'
import type { WireEvent, WireEventEnvelope } from '../../src/session/wire.js'
import type { Message } from '../../src/types/message.js'
import type { UUID } from 'crypto'

let configDir: string
let previousConfigDir: string | undefined

beforeEach(() => {
  previousConfigDir = process.env.FREECODE_CONFIG_DIR
  configDir = mkdtempSync(join(tmpdir(), 'wire-surface-'))
  process.env.FREECODE_CONFIG_DIR = configDir
})

afterEach(() => {
  if (previousConfigDir === undefined) {
    delete process.env.FREECODE_CONFIG_DIR
  } else {
    process.env.FREECODE_CONFIG_DIR = previousConfigDir
  }
  rmSync(configDir, { recursive: true, force: true })
})

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

function base(surfaceUrl: string, sessionId: string, route: string): string {
  return `${surfaceUrl}/v1/sessions/${sessionId}/${route}`
}

async function startTestSurface() {
  const sessionId = randomUUID()
  const surface = startWireSurface({
    sessionId,
    cwd: process.cwd(),
    entrypoint: 'unit',
  })!
  await surface.ready
  return {
    surface,
    sessionId,
    url: surface.url,
    descriptor: surface.descriptor,
    get hasSubscribers() {
      return surface.hasSubscribers
    },
    registerRuntime: (runtime: SessionRuntime) =>
      surface.registerRuntime(runtime),
    publishTranscript: () => surface.publishTranscript(),
    publishTodos: () => surface.publishTodos(),
    publishQueue: () => surface.publishQueue(),
    setSessionId: (id: string) => surface.setSessionId(id),
    stop: () => surface.stop(),
  }
}

describe('descriptor validation', () => {
  test('accepts the descriptor written by a live surface', async () => {
    const surface = await startTestSurface()
    const result = readAttachDescriptor(process.pid)
    expect(result.ok).toBe(true)
    expect(result.ok && result.descriptor.sessionId).toBe(surface.sessionId)
    expect(result.ok && result.descriptor.wireVersion).toBe(2)
    surface.stop()
  })

  test('rejects a descriptor whose body pid disagrees with its filename', async () => {
    const surface = await startTestSurface()
    const path = getDescriptorPath(process.pid)
    const body = JSON.parse(readFileSync(path, 'utf-8')) as Record<
      string,
      unknown
    >
    body.pid = process.pid + 1
    writeFileSync(path, JSON.stringify(body))
    chmodSync(path, ATTACH_FILE_MODE)
    expect(readAttachDescriptor(process.pid).ok).toBe(false)
    surface.stop()
  })

  test('rejects a world-readable descriptor', async () => {
    const surface = await startTestSurface()
    chmodSync(getDescriptorPath(process.pid), 0o644)
    expect(readAttachDescriptor(process.pid).ok).toBe(false)
    surface.stop()
  })

  test('rejects a descriptor directory with a loose mode', async () => {
    const surface = await startTestSurface()
    chmodSync(join(configDir, 'attach'), 0o755)
    expect(verifyAttachDir().ok).toBe(false)
    surface.stop()
  })
})

describe('surface lifecycle', () => {
  test('creates the descriptor directory owner-only', async () => {
    const surface = await startTestSurface()
    expect(verifyAttachDir().ok).toBe(true)
    surface.stop()
  })

  test('removes its descriptor on stop', async () => {
    const surface = await startTestSurface()
    surface.stop()
    expect(readAttachDescriptor(process.pid).ok).toBe(false)
  })

  test('keeps the port and bumps the epoch across a session switch', async () => {
    const surface = await startTestSurface()
    const port = surface.descriptor.port

    const next = randomUUID()
    surface.setSessionId(next)

    expect(surface.descriptor.port).toBe(port)
    expect(surface.descriptor.sessionId).toBe(next)
    const reread = readAttachDescriptor(process.pid)
    expect(reread.ok && reread.descriptor.sessionId).toBe(next)

    // The old session id no longer names this surface.
    const stale = await fetch(base(surface.url, surface.sessionId, 'meta'), {
      headers: { [SURFACE_TOKEN_HEADER]: surface.descriptor.token },
    })
    expect(stale.status).toBe(404)
    surface.stop()
  })

  test('reports no subscribers before a stream opens', async () => {
    const surface = await startTestSurface()
    expect(surface.hasSubscribers).toBe(false)
    surface.stop()
  })

  test('unrefs its listener so it cannot hold a finished process open', async () => {
    // A referenced listener would keep a headless run alive after its work
    // finished, so assert it for real: a process whose only remaining handle
    // is the surface listener must exit on its own.
    const script = `
      import { startWireSurface } from '${join(import.meta.dir, '..', '..', 'src/server/surface.ts')}'
      const surface = startWireSurface({ sessionId: crypto.randomUUID(), cwd: process.cwd() })
      await surface.ready
      // Never call stop(). If the listener is referenced, this hangs.
    `
    const proc = Bun.spawn(['bun', '-e', script], {
      env: { ...process.env, FREECODE_CONFIG_DIR: configDir },
      stdout: 'ignore',
      stderr: 'pipe',
    })

    const exited = await Promise.race([
      proc.exited,
      Bun.sleep(4000).then(() => 'timeout' as const),
    ])
    if (exited === 'timeout') {
      proc.kill()
      throw new Error('the surface listener kept the process alive')
    }
    expect(exited).toBe(0)
  })
})

describe('idle cost', () => {
  test('does no transcript work while nothing is subscribed', async () => {
    const surface = await startTestSurface()
    let getMessagesCalls = 0
    surface.registerRuntime(
      stubRuntime({
        getMessages: () => {
          getMessagesCalls += 1
          return []
        },
      }),
    )

    // This runs on every transcript mutation in every interactive process, so
    // an unattached session must not pay to serialize anything.
    for (let i = 0; i < 100; i++) surface.publishTranscript()
    expect(getMessagesCalls).toBe(0)
    surface.stop()
  })
})

describe('token handshake', () => {
  test('accepts the token from the descriptor', async () => {
    const surface = await startTestSurface()
    const response = await fetch(base(surface.url, surface.sessionId, 'meta'), {
      headers: { [SURFACE_TOKEN_HEADER]: surface.descriptor.token },
    })
    expect(response.ok).toBe(true)
    const meta = await response.json()
    expect(meta).toMatchObject({
      sessionId: surface.sessionId,
      sessionEpoch: 0,
    })
    surface.stop()
  })

  test('rejects a missing or wrong token', async () => {
    const surface = await startTestSurface()
    const url = base(surface.url, surface.sessionId, 'meta')
    expect((await fetch(url)).status).toBe(401)
    expect(
      (await fetch(url, { headers: { [SURFACE_TOKEN_HEADER]: 'wrong' } }))
        .status,
    ).toBe(401)
    surface.stop()
  })
})

describe('commands', () => {
  test('refuses every command before the runtime registers', async () => {
    const surface = await startTestSurface()
    const response = await fetch(
      base(surface.url, surface.sessionId, 'prompt'),
      {
        method: 'POST',
        headers: {
          [SURFACE_TOKEN_HEADER]: surface.descriptor.token,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          kind: 'prompt',
          commandId: 'c1',
          content: 'hello',
          delivery: 'next',
          sessionEpoch: 0,
        }),
      },
    )
    expect(response.status).toBe(503)
    surface.stop()
  })

  test('passes a prompt to the runtime', async () => {
    const surface = await startTestSurface()
    const submitted: string[] = []
    surface.registerRuntime(
      stubRuntime({ submit: content => void submitted.push(content) }),
    )
    const response = await fetch(
      base(surface.url, surface.sessionId, 'prompt'),
      {
        method: 'POST',
        headers: {
          [SURFACE_TOKEN_HEADER]: surface.descriptor.token,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          kind: 'prompt',
          commandId: 'c1',
          content: 'hello',
          delivery: 'next',
          sessionEpoch: 0,
        }),
      },
    )
    expect(response.status).toBe(200)
    expect(submitted).toEqual(['hello'])
    surface.stop()
  })

  test('refuses a prompt that is empty on both counts', async () => {
    const surface = await startTestSurface()
    surface.registerRuntime(stubRuntime())
    const response = await fetch(
      base(surface.url, surface.sessionId, 'prompt'),
      {
        method: 'POST',
        headers: {
          [SURFACE_TOKEN_HEADER]: surface.descriptor.token,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          kind: 'prompt',
          commandId: 'c1',
          content: '',
          delivery: 'next',
          sessionEpoch: 0,
        }),
      },
    )
    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body.error.code).toBe('empty_submit')
    surface.stop()
  })

  test('refuses a prompt composed against a stale epoch', async () => {
    const surface = await startTestSurface()
    surface.registerRuntime(stubRuntime())
    surface.setSessionId(randomUUID())
    const response = await fetch(
      base(surface.url, surface.descriptor.sessionId, 'prompt'),
      {
        method: 'POST',
        headers: {
          [SURFACE_TOKEN_HEADER]: surface.descriptor.token,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          kind: 'prompt',
          commandId: 'c1',
          content: 'x',
          delivery: 'next',
          sessionEpoch: 0,
        }),
      },
    )
    expect(response.status).toBe(409)
    surface.stop()
  })

  test('refuses a mode that stops asking', async () => {
    const surface = await startTestSurface()
    const modes: string[] = []
    surface.registerRuntime(
      stubRuntime({ setMode: mode => void modes.push(mode) }),
    )
    const response = await fetch(base(surface.url, surface.sessionId, 'mode'), {
      method: 'POST',
      headers: {
        [SURFACE_TOKEN_HEADER]: surface.descriptor.token,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ kind: 'mode_set', mode: 'bypassPermissions' }),
    })
    expect(response.status).toBe(403)
    expect(modes).toEqual([])

    const okResponse = await fetch(
      base(surface.url, surface.sessionId, 'mode'),
      {
        method: 'POST',
        headers: {
          [SURFACE_TOKEN_HEADER]: surface.descriptor.token,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ kind: 'mode_set', mode: 'acceptEdits' }),
      },
    )
    expect(okResponse.status).toBe(200)
    expect(modes).toEqual(['acceptEdits'])
    surface.stop()
  })

  test('answers request_respond for an id nobody is waiting on', async () => {
    const surface = await startTestSurface()
    surface.registerRuntime(stubRuntime())
    const response = await fetch(
      base(surface.url, surface.sessionId, 'request_respond'),
      {
        method: 'POST',
        headers: {
          [SURFACE_TOKEN_HEADER]: surface.descriptor.token,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          kind: 'request_respond',
          requestId: 'nope',
          response: { kind: 'permission', decision: { behavior: 'deny' } },
        }),
      },
    )
    expect(response.status).toBe(409)
    const body = await response.json()
    expect(body.error.code).toBe('interaction_not_pending')
    surface.stop()
  })
})

describe('image prompts', () => {
  const IMAGE_UUID = '44444444-4444-4444-4444-444444444444'
  const PIXEL = 'iVBORw0KGgo='

  /** A session holding one user message: an image block, then text. */
  function messages(): Message[] {
    return [
      {
        type: 'user',
        uuid: IMAGE_UUID as UUID,
        timestamp: new Date().toISOString(),
        message: {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/png',
                data: PIXEL,
              },
            },
            { type: 'text', text: 'what is this' },
          ],
        },
      },
    ]
  }

  test('answers image with the bytes for that block', async () => {
    const surface = await startTestSurface()
    surface.registerRuntime(stubRuntime({ getMessages: () => messages() }))
    const response = await fetch(
      `${base(surface.url, surface.sessionId, 'image')}?itemId=${IMAGE_UUID}:0`,
      { headers: { [SURFACE_TOKEN_HEADER]: surface.descriptor.token } },
    )
    expect(response.ok).toBe(true)
    expect(await response.json()).toEqual({
      mediaType: 'image/png',
      data: PIXEL,
    })
    surface.stop()
  })

  test('refuses an item id that is not an image', async () => {
    const surface = await startTestSurface()
    surface.registerRuntime(stubRuntime({ getMessages: () => messages() }))
    const response = await fetch(
      `${base(surface.url, surface.sessionId, 'image')}?itemId=${IMAGE_UUID}:1`,
      { headers: { [SURFACE_TOKEN_HEADER]: surface.descriptor.token } },
    )
    expect(response.status).toBe(404)
    surface.stop()
  })
})

describe('event stream', () => {
  /** One reader per stream response; each call drains N more frames. */
  function frameCollector(response: Response) {
    const reader = response
      .body!.pipeThrough(new TextDecoderStream())
      .getReader()
    let buffer = ''
    return async function next(count: number): Promise<WireEventEnvelope[]> {
      const envelopes: WireEventEnvelope[] = []
      while (envelopes.length < count) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += value
        let boundary = buffer.indexOf('\n\n')
        while (boundary >= 0) {
          const frame = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          const dataLine = frame.split('\n').find(l => l.startsWith('data: '))
          if (dataLine) envelopes.push(JSON.parse(dataLine.slice(6)))
          boundary = buffer.indexOf('\n\n')
        }
      }
      return envelopes
    }
  }

  function headersFor(
    surface: { descriptor: { token: string } },
    lastEventId?: number,
  ): Record<string, string> {
    return {
      [SURFACE_TOKEN_HEADER]: surface.descriptor.token,
      ...(lastEventId !== undefined
        ? { 'last-event-id': String(lastEventId) }
        : {}),
    }
  }

  test('opens with a snapshot frame', async () => {
    const surface = await startTestSurface()
    surface.registerRuntime(stubRuntime())
    const response = await fetch(
      base(surface.url, surface.sessionId, 'events'),
      {
        headers: headersFor(surface),
      },
    )
    const frames = await frameCollector(response)(1)
    expect(frames[0]!.event.kind).toBe('snapshot')
    expect(frames[0]!.v).toBe(2)
    surface.stop()
  })

  test('replays from Last-Event-ID instead of a fresh snapshot', async () => {
    const surface = await startTestSurface()
    const messages: Message[] = []
    surface.registerRuntime(stubRuntime({ getMessages: () => messages }))
    surface.publishTranscript() // no-op: nobody subscribed yet

    const first = await fetch(base(surface.url, surface.sessionId, 'events'), {
      headers: headersFor(surface),
    })
    const snapshot = (await frameCollector(first)(1))[0]!
    expect(snapshot.event.kind).toBe('snapshot')

    // Two appends land while the first reader is gone.
    messages.push({
      type: 'user',
      uuid: randomUUID() as UUID,
      timestamp: new Date().toISOString(),
      message: { role: 'user', content: 'one' },
    })
    surface.publishTranscript()
    messages.push({
      type: 'user',
      uuid: randomUUID() as UUID,
      timestamp: new Date().toISOString(),
      message: { role: 'user', content: 'two' },
    })
    surface.publishTranscript()

    const replay = await fetch(base(surface.url, surface.sessionId, 'events'), {
      headers: headersFor(surface, snapshot.seq),
    })
    const frames = await frameCollector(replay)(2)
    expect(frames.every(f => f.seq > snapshot.seq)).toBe(true)
    expect(frames.map(f => f.event.kind)).toEqual(['transcript', 'transcript'])
    const kinds = frames.map(f => {
      const event = f.event as {
        kind: 'transcript'
        patch: { upsert?: unknown[] }
      }
      return event.patch.upsert?.length
    })
    expect(kinds).toEqual([1, 1])
    surface.stop()
  })

  test('surfaces broker requests as request_opened and request_closed', async () => {
    const surface = await startTestSurface()
    surface.registerRuntime(stubRuntime())
    const response = await fetch(
      base(surface.url, surface.sessionId, 'events'),
      {
        headers: headersFor(surface),
      },
    )
    const collect = frameCollector(response)
    await collect(1) // snapshot

    const { currentSessionRequests } =
      await import('../../src/session/requests.js')
    const broker = currentSessionRequests()
    const id = broker.newRequestId()
    const unsubscribe = broker.open(
      {
        kind: 'permission',
        requestId: id,
        openedAt: Date.now(),
        toolName: 'Bash',
        toolUseId: 'tu-1',
        description: 'run it',
        input: { command: 'ls' },
      },
      () => {},
    )
    const closed = broker.respondTo(id, {
      kind: 'permission',
      decision: { behavior: 'deny' },
    })
    expect(closed).toBe(true)
    unsubscribe()

    const frames = await collect(2)
    const kinds = frames.map(f => f.event.kind)
    expect(kinds).toEqual(['request_opened', 'request_closed'])
    const closedEvent = frames[1]!.event as { outcome: string }
    expect(closedEvent.outcome).toBe('resolved')
    surface.stop()
  })

  test('a wire event keeps the monotonic per-session seq', async () => {
    const surface = await startTestSurface()
    surface.registerRuntime(stubRuntime())
    const response = await fetch(
      base(surface.url, surface.sessionId, 'events'),
      {
        headers: headersFor(surface),
      },
    )
    const collect = frameCollector(response)
    await collect(1)
    surface.publishTodos()
    surface.publishQueue()
    const frames = await collect(2)
    expect(frames[1]!.seq).toBeGreaterThan(frames[0]!.seq)
    surface.stop()
  })
})
