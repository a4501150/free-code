/**
 * The surfaceClient event stream must survive a sever: it resumes from the
 * last seq it delivered (Last-Event-ID) instead of ending the viewer. The
 * fake surface below severs with a socket destroy and answers the resubscribe
 * with the resume position it received, so the test pins both halves of the
 * handshake — the client's header and its position tracking.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'crypto'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createServer, type ServerResponse } from 'http'
import {
  ensureAttachDir,
  writeAttachDescriptor,
  removeAttachDescriptor,
} from '../../src/server/descriptor.js'
import { sseFrame } from '../../src/server/channel.js'
import {
  connectSurfaceClient,
  type SurfaceClient,
} from '../../src/webui/gateway/surfaceClient.js'
import type { WireEvent, WireEventEnvelope } from '../../src/session/wire.js'

let configDir: string
let previousConfigDir: string | undefined

beforeEach(() => {
  previousConfigDir = process.env.FREECODE_CONFIG_DIR
  configDir = mkdtempSync(join(tmpdir(), 'surface-reconnect-'))
  process.env.FREECODE_CONFIG_DIR = configDir
  ensureAttachDir()
})

afterEach(() => {
  if (previousConfigDir === undefined) {
    delete process.env.FREECODE_CONFIG_DIR
  } else {
    process.env.FREECODE_CONFIG_DIR = previousConfigDir
  }
  removeAttachDescriptor(process.pid)
  rmSync(configDir, { recursive: true, force: true })
})

const sessionId = randomUUID()

function frame(seq: number): string {
  return sseFrame({
    v: 2,
    seq,
    event: { kind: 'tasks', tasks: [] } as WireEvent,
  } satisfies WireEventEnvelope)
}

type EventsRequest = { res: ServerResponse; lastEventId?: string }

type FakeSurface = {
  /** Resolves with each events GET in arrival order, headers included. */
  nextEventsRequest(): Promise<EventsRequest>
  stop(): void
}

async function startFakeSurface(eventsStatus = 200): Promise<FakeSurface> {
  const arrived: EventsRequest[] = []
  const openResponses: ServerResponse[] = []
  let waitingResolver: ((value: EventsRequest) => void) | undefined
  const server = createServer((req, res) => {
    if (req.url?.endsWith('/meta')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ sessionId }))
      return
    }
    if (req.url?.endsWith('/events')) {
      if (eventsStatus !== 200) {
        res.writeHead(eventsStatus, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { code: 'unknown_route' } }))
        return
      }
      openResponses.push(res)
      const header = req.headers['last-event-id']
      const value: EventsRequest = {
        res,
        lastEventId: typeof header === 'string' ? header : undefined,
      }
      if (waitingResolver) {
        const resolve = waitingResolver
        waitingResolver = undefined
        resolve(value)
      } else {
        arrived.push(value)
      }
      return
    }
    res.writeHead(404).end()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  writeAttachDescriptor({
    wireVersion: 2,
    pid: process.pid,
    processNonce: randomUUID(),
    token: 'test-token-0123456789ab',
    port,
    sessionId,
    cwd: process.cwd(),
    startedAt: Date.now(),
  })
  return {
    nextEventsRequest() {
      return new Promise(resolve => {
        const next = arrived.shift()
        if (next) resolve(next)
        else waitingResolver = resolve
      })
    },
    stop() {
      // server.close() waits for open SSE responses, so end them first.
      for (const res of openResponses) res.destroy()
      server.close()
    },
  }
}

describe('surfaceClient event-stream reconnect', () => {
  test('resumes from the last delivered seq after a sever', async () => {
    const surface = await startFakeSurface()
    const seen: number[] = []
    let closedReason: string | undefined
    let client: SurfaceClient | undefined
    try {
      client = await connectSurfaceClient(process.pid, {
        onEvent: seq => seen.push(seq),
        onClose: reason => {
          closedReason = reason
        },
      })

      const first = await surface.nextEventsRequest()
      first.res.write(': open\n\n')
      first.res.write(frame(1))
      first.res.write(frame(2))
      // The write callback only reports hand-off, not delivery to the peer,
      // so give the socket a beat to flush before the sever — otherwise the
      // client's position is not genuinely at 2 when the socket dies.
      await new Promise(resolve => setTimeout(resolve, 50))
      // An abrupt sever, like a proxy reset or the Bun fetch body timeout.
      first.res.destroy()

      const second = await surface.nextEventsRequest()
      expect(second.lastEventId).toBe('2')
      second.res.write(frame(3))

      await new Promise(resolve => setTimeout(resolve, 50))
      expect(seen).toEqual([1, 2, 3])
      expect(closedReason).toBeUndefined()
    } finally {
      client?.close()
      surface.stop()
    }
  }, 10_000)

  test('a 404 from the events route ends the client as terminal', async () => {
    const surface = await startFakeSurface(404)
    let closedReason: string | undefined
    let client: SurfaceClient | undefined
    try {
      client = await connectSurfaceClient(process.pid, {
        onEvent: () => {},
        onClose: reason => {
          closedReason = reason
        },
      })
      // Terminal means no reconnect ladder: the answer arrives immediately.
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(closedReason).toBe('session gone')
    } finally {
      client?.close()
      surface.stop()
    }
  }, 10_000)
})
