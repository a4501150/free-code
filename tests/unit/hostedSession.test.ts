import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createServer } from 'node:http'
import { randomUUID } from 'crypto'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  createHostedSession,
  type HostedSession,
} from '../../src/sessiond/hosted.js'
import { SURFACE_TOKEN_HEADER } from '../../src/server/surface.js'
import {
  addToTotalCostState,
  getCwdState,
  getTotalCostUSD,
  runInSessionScope,
  setCwdState,
} from '../../src/bootstrap/state.js'
import type { WireEventEnvelope } from '../../src/session/wire.js'
import type { SessionChannel } from '../../src/server/channel.js'

let configDir: string
let previousConfigDir: string | undefined
let previousApiKey: string | undefined

beforeEach(() => {
  previousConfigDir = process.env.FREECODE_CONFIG_DIR
  configDir = mkdtempSync(join(tmpdir(), 'hosted-session-'))
  process.env.FREECODE_CONFIG_DIR = configDir
  // bun test runs with NODE_ENV=test, where auth resolution refuses to fall
  // back to config-file state and demands an env key; the command registry's
  // login entry reads it at load.
  previousApiKey = process.env.ANTHROPIC_API_KEY
  process.env.ANTHROPIC_API_KEY = 'test-key-hosted-session'
})

afterEach(() => {
  if (previousApiKey === undefined) {
    delete process.env.ANTHROPIC_API_KEY
  } else {
    process.env.ANTHROPIC_API_KEY = previousApiKey
  }
  if (previousConfigDir === undefined) {
    delete process.env.FREECODE_CONFIG_DIR
  } else {
    process.env.FREECODE_CONFIG_DIR = previousConfigDir
  }
  rmSync(configDir, { recursive: true, force: true })
})

/** One listener, many channels — the same registry routing sessiond uses. */
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
    const kind = parts[3]
    if (request.method === 'GET') {
      channel.handleGet(request, res, kind!, [parts[4] ?? ''], url)
      return
    }
    void channel.handlePost(request, res, kind!)
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

function nextFramesWithin(
  collect: (count: number) => Promise<WireEventEnvelope[]>,
  ms: number,
): Promise<WireEventEnvelope[] | 'quiet'> {
  return Promise.race([
    collect(1),
    new Promise<'quiet'>(resolve => setTimeout(() => resolve('quiet'), ms)),
  ])
}

async function waitFor(cond: () => boolean, ms = 5000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (cond()) return true
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  return cond()
}

describe('hosted session', () => {
  let sessions: HostedSession[] = []

  function makeSession(cwd: string): HostedSession {
    const s = createHostedSession({ cwd })
    sessions.push(s)
    return s
  }

  afterEach(() => {
    for (const s of sessions) s.stop()
    sessions = []
  })

  test('each session addresses its own scope on the wire', async () => {
    const cwdA = join(configDir, 'a')
    const cwdB = join(configDir, 'b')
    const a = makeSession(cwdA)
    const b = makeSession(cwdB)
    const token = 't'
    const mounted = await mount([a.channel, b.channel], token)
    const headers = { [SURFACE_TOKEN_HEADER]: token }

    const metaA = await (
      await fetch(`${mounted.url}/v1/sessions/${a.sessionId}/meta`, { headers })
    ).json()
    const metaB = await (
      await fetch(`${mounted.url}/v1/sessions/${b.sessionId}/meta`, { headers })
    ).json()
    expect(metaA.sessionId).toBe(a.sessionId)
    expect(metaB.sessionId).toBe(b.sessionId)
    expect(metaA.sessionId).not.toBe(metaB.sessionId)
    expect(metaA.cwd).toBe(cwdA)
    expect(metaB.cwd).toBe(cwdB)
    mounted.close()
  })

  test('cost and cwd writes on one scope are invisible to the other', () => {
    const a = makeSession(join(configDir, 'a'))
    const b = makeSession(join(configDir, 'b'))

    runInSessionScope(a.scope, () => {
      addToTotalCostState(1.5, { inputTokens: 1, outputTokens: 1 }, 'm')
      setCwdState(join(configDir, 'moved-a'))
    })

    expect(runInSessionScope(a.scope, () => getTotalCostUSD())).toBe(1.5)
    expect(runInSessionScope(b.scope, () => getTotalCostUSD())).toBe(0)
    expect(runInSessionScope(a.scope, () => getCwdState())).toBe(
      join(configDir, 'moved-a'),
    )
    expect(runInSessionScope(b.scope, () => getCwdState())).toBe(
      join(configDir, 'b'),
    )
  })

  test('publishes reach only the owning session’s stream', async () => {
    const a = makeSession(join(configDir, 'a'))
    const b = makeSession(join(configDir, 'b'))
    const token = 't'
    const mounted = await mount([a.channel, b.channel], token)
    const headers = { [SURFACE_TOKEN_HEADER]: token }

    const streamA = await fetch(
      `${mounted.url}/v1/sessions/${a.sessionId}/events`,
      { headers },
    )
    const streamB = await fetch(
      `${mounted.url}/v1/sessions/${b.sessionId}/events`,
      { headers },
    )
    const collectA = frameCollector(streamA)
    const collectB = frameCollector(streamB)
    const snapshotA = (await collectA(1))[0]!
    const snapshotB = (await collectB(1))[0]!
    expect(snapshotA.event.kind).toBe('snapshot')
    expect(snapshotB.event.kind).toBe('snapshot')

    runInSessionScope(a.scope, () =>
      addToTotalCostState(2, { inputTokens: 1, outputTokens: 1 }, 'm'),
    )
    a.channel.publishMeta()

    const metaA = (await collectA(1))[0]!
    expect(metaA.event.kind).toBe('meta')
    expect((metaA.event as { meta: { costUsd?: number } }).meta.costUsd).toBe(2)
    expect(await nextFramesWithin(collectB, 150)).toBe('quiet')
    mounted.close()
  })

  test('submit drains through the session queue onto the right core', async () => {
    const a = makeSession(join(configDir, 'a'))
    const b = makeSession(join(configDir, 'b'))

    let appendedToA = 0
    let appendedToB = 0
    a.core.subscribe(e => {
      if (e.type === 'transcript_appended') appendedToA++
    })
    b.core.subscribe(e => {
      if (e.type === 'transcript_appended') appendedToB++
    })

    // An unknown slash command resolves without a provider call, so the
    // queue drain and message landing are observable deterministically.
    a.submit(`/nonexistent-${randomUUID()}`)

    expect(await waitFor(() => a.core.getMessages().length > 0)).toBe(true)
    expect(appendedToA).toBeGreaterThan(0)
    expect(b.core.getMessages().length).toBe(0)
    expect(appendedToB).toBe(0)
    // The turn finished without starting a provider loop.
    expect(a.queryGuard.isActive).toBe(false)
  })
})
