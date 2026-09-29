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
import type {
  AgentDefinition,
  AgentDefinitionsResult,
} from '../../src/tools/AgentTool/loadAgentsDir.js'
import type { SessionChannel } from '../../src/server/channel.js'
import { enqueue } from '../../src/utils/messageQueueManager.js'
import type { UUID } from 'crypto'
import { encodeSuccessSSE } from '../helpers/sse-encoder'

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

/**
 * Persistent frame reader: a background pump buffers every frame, so waits
 * never race an orphaned read against the shared stream reader.
 */
function frameRecorder(response: Response): {
  count: () => number
  read: () => WireEventEnvelope[]
  untilQuiet: (ms?: number) => Promise<WireEventEnvelope[]>
} {
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader()
  const frames: WireEventEnvelope[] = []
  let consumed = 0
  let notify: (() => void) | null = null
  void (async () => {
    let buffer = ''
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      buffer += next.value
      let boundary: number
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const dataLine = frame.split('\n').find(l => l.startsWith('data: '))
        if (dataLine) frames.push(JSON.parse(dataLine.slice(6)))
        notify?.()
      }
    }
    notify?.()
  })()
  const waitForMore = async (ms: number): Promise<void> =>
    new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        notify = null
        resolve()
      }, ms)
      notify = () => {
        clearTimeout(timer)
        notify = null
        resolve()
      }
    })
  return {
    count: () => frames.length,
    read: () => frames.slice(),
    // Returns every frame not yet consumed by a previous call, so frames
    // that land while the caller awaits a POST are never missed.
    untilQuiet: async (ms = 150) => {
      const start = consumed
      let cursor = frames.length
      for (let round = 0; round < 4; round++) {
        await waitForMore(ms)
        if (frames.length === cursor) break
        cursor = frames.length
      }
      consumed = frames.length
      return frames.slice(start)
    },
  }
}

async function postRpc(
  url: string,
  token: string,
  sessionId: string,
  method: string,
  params?: Record<string, unknown>,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${url}/v1/sessions/${sessionId}/rpc`, {
    method: 'POST',
    headers: {
      [SURFACE_TOKEN_HEADER]: token,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ kind: 'rpc', method, ...(params && { params }) }),
  })
  return { status: res.status, body: await res.json() }
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

  test('agentDefinitions seed the store — AgentTool reads the catalog there', () => {
    // Regression: the hosted store defaults agentDefinitions to an empty
    // list; without seeding, every Agent(general-purpose) call in a hosted
    // session failed "type not found. Available agents:" (empty).
    const s = makeSession(join(configDir, 'agents'))
    expect(s.store.getState().agentDefinitions.activeAgents).toEqual([])
    const def = {
      agentType: 'general-purpose',
      whenToUse: 'test',
      getSystemPrompt: () => 'x',
    } as unknown as AgentDefinition
    const agentDefinitions = {
      activeAgents: [def],
      allAgents: [def],
    } as unknown as AgentDefinitionsResult
    const seeded = createHostedSession({
      cwd: join(configDir, 'agents'),
      agentDefinitions,
    })
    sessions.push(seeded)
    expect(
      seeded.store
        .getState()
        .agentDefinitions.activeAgents.map(a => a.agentType),
    ).toEqual(['general-purpose'])
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

  test('queue rpc edits and removes the session’s own queue over the wire', async () => {
    const a = makeSession(join(configDir, 'a'))
    const token = 't'
    const mounted = await mount([a.channel], token)
    const headers = { [SURFACE_TOKEN_HEADER]: token }
    const stream = await fetch(
      `${mounted.url}/v1/sessions/${a.sessionId}/events`,
      { headers },
    )
    const recorder = frameRecorder(stream)
    const opened = await recorder.untilQuiet()
    expect(opened[0]?.event.kind).toBe('snapshot')

    // Hold the guard as if a turn were running: the pump stands down and the
    // queued items stay put — queue rpc must still work while busy.
    const generation = a.queryGuard.tryStart()
    expect(generation).not.toBeNull()
    const id1 = randomUUID()
    const id2 = randomUUID()
    runInSessionScope(a.scope, () => {
      enqueue({ mode: 'prompt', value: 'first text', uuid: id1 as UUID })
      enqueue({ mode: 'prompt', value: 'second text', uuid: id2 as UUID })
    })
    const queueFrames = await recorder.untilQuiet()
    const lastQueue = [...queueFrames]
      .reverse()
      .find(f => f.event.kind === 'queue')
    expect(lastQueue).toBeDefined()
    const texts = (
      lastQueue!.event as { commands: { text: string }[] }
    ).commands.map(c => c.text)
    expect(texts).toEqual(['first text', 'second text'])

    // A turn in flight blocks the transcript-rewriting rpcs...
    const busyCompact = await postRpc(
      mounted.url,
      token,
      a.sessionId,
      'compact',
    )
    expect(busyCompact.status).toBe(500)
    expect(busyCompact.body.error.code).toBe('rpc_failed')

    const edited = await postRpc(
      mounted.url,
      token,
      a.sessionId,
      'queue_edit',
      { commandId: id1, text: 'fixed text' },
    )
    expect(edited.body).toEqual({ ok: true, result: { edited: true } })
    const afterEdit = await recorder.untilQuiet()
    const editQueue = [...afterEdit]
      .reverse()
      .find(f => f.event.kind === 'queue')
    expect(editQueue).toBeDefined()
    expect(
      (editQueue!.event as { commands: { text: string }[] }).commands.map(
        c => c.text,
      ),
    ).toEqual(['fixed text', 'second text'])

    const removed = await postRpc(
      mounted.url,
      token,
      a.sessionId,
      'queue_remove',
      { commandId: id1 },
    )
    expect(removed.body).toEqual({ ok: true, result: { removed: true } })
    const afterRemove = await recorder.untilQuiet()
    const removeQueue = [...afterRemove]
      .reverse()
      .find(f => f.event.kind === 'queue')
    expect(removeQueue).toBeDefined()
    expect(
      (removeQueue!.event as { commands: { text: string }[] }).commands.map(
        c => c.text,
      ),
    ).toEqual(['second text'])

    // Unknown ids answer false; unknown methods answer rpc_failed.
    const gone = await postRpc(
      mounted.url,
      token,
      a.sessionId,
      'queue_remove',
      {
        commandId: randomUUID(),
      },
    )
    expect(gone.body).toEqual({ ok: true, result: { removed: false } })
    const unsupported = await postRpc(mounted.url, token, a.sessionId, 'resume')
    expect(unsupported.status).toBe(500)
    expect(unsupported.body.error.code).toBe('rpc_failed')

    a.queryGuard.end(generation!)
    mounted.close()
  })

  test('clear empties the transcript and rotates the session identity', async () => {
    const a = makeSession(join(configDir, 'a'))
    const oldId = a.sessionId
    const token = 't'
    const mounted = await mount([a.channel], token)
    const headers = { [SURFACE_TOKEN_HEADER]: token }

    const stream = await fetch(`${mounted.url}/v1/sessions/${oldId}/events`, {
      headers,
    })
    const recorder = frameRecorder(stream)
    const opened = await recorder.untilQuiet()
    const snapshot = opened[0]!
    expect(snapshot.event.kind).toBe('snapshot')

    a.submit(`/nonexistent-${randomUUID()}`)
    expect(
      await waitFor(
        () => a.core.getMessages().length > 0 && !a.queryGuard.isActive,
      ),
    ).toBe(true)

    const cleared = await postRpc(mounted.url, token, oldId, 'clear')
    expect(cleared.status).toBe(200)
    const newId = cleared.body.result.sessionId as string
    expect(newId).toBeTruthy()
    expect(newId).not.toBe(oldId)
    expect(a.channel.sessionId).toBe(newId)
    expect(a.core.getMessages().length).toBe(0)

    // The stream carries the identity move (session_changed with a bumped
    // epoch) so a client holding the old id resynchronizes.
    const frames = await recorder.untilQuiet()
    const changed = frames.find(f => f.event.kind === 'session_changed')
    expect(changed).toBeDefined()
    expect((changed!.event as { sessionId: string }).sessionId).toBe(newId)
    expect(changed!.seq).toBeGreaterThan(snapshot.seq)

    // The row still resolves — now under the new id.
    const meta = await (
      await fetch(`${mounted.url}/v1/sessions/${newId}/meta`, { headers })
    ).json()
    expect(meta.sessionId).toBe(newId)
    mounted.close()
  })

  test('compact summarizes through the provider and replaces the transcript', async () => {
    // Provider boundary: a fetch stub answering the chat-completions /
    // messages endpoint with an encoded summary stream. Which wire shape
    // the registry picks follows the host's provider config, so the stub
    // speaks both. The compact pipeline (command body,
    // compactConversation, forked-agent query) runs for real above it.
    const previousFetch = globalThis.fetch
    const messageRequests: Array<{ url: string; body: string }> = []
    const summaryText = 'Summary: nothing happened.'
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : String(input?.url ?? input)
      if (url.includes('count_tokens')) {
        return new Response(JSON.stringify({ input_tokens: 1200 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      const body =
        typeof init?.body === 'string'
          ? init.body
          : JSON.stringify(init?.body ?? {})
      if (url.includes('/v1/messages')) {
        messageRequests.push({ url, body })
        return new Response(
          encodeSuccessSSE({
            content: [{ type: 'text', text: summaryText }],
            stop_reason: 'end_turn',
          }),
          {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
          },
        )
      }
      if (url.includes('/chat/completions')) {
        messageRequests.push({ url, body })
        const chunk = (delta: unknown, finish: unknown) =>
          `data: ${JSON.stringify({
            id: 'chatcmpl-test-1',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'mock',
            choices: [{ index: 0, delta, finish_reason: finish }],
          })}\n\n`
        const sse =
          chunk({ role: 'assistant' }, null) +
          chunk({ content: summaryText }, null) +
          chunk({}, 'stop') +
          'data: [DONE]\n\n'
        return new Response(sse, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      }
      return previousFetch(input as never, init)
    }) as typeof globalThis.fetch
    try {
      const a = makeSession(join(configDir, 'a'))
      const marker = `/nonexistent-${randomUUID()}`
      a.submit(marker)
      expect(
        await waitFor(
          () => a.core.getMessages().length > 0 && !a.queryGuard.isActive,
        ),
      ).toBe(true)

      const replacedReasons: string[] = []
      a.core.subscribe(e => {
        if (e.type === 'transcript_replaced') replacedReasons.push(e.reason)
      })

      // Direct rpc (same handler the wire rides) to keep the test on the
      // provider boundary, not the surface plumbing covered above.
      const result = await a.runtime.rpc!('compact', {
        customInstructions: 'summarize briefly',
      })
      expect(result).toEqual({ compacted: true })
      // The summary request really left the process: one provider call,
      // streaming, carrying the custom instruction. (Which endpoint —
      // anthropic messages or openai chat completions — follows the
      // host's provider config; the stub answers both shapes.)
      expect(messageRequests.length).toBe(1)
      expect(messageRequests[0]!.body).toContain('"stream":true')
      expect(messageRequests[0]!.body).toContain('summarize briefly')
      expect(replacedReasons).toContain('compact')
      const transcriptText = JSON.stringify(a.core.getMessages())
      expect(transcriptText).not.toContain(marker)
      expect(transcriptText).toContain('Summary: nothing happened.')
      expect(a.queryGuard.isActive).toBe(false)
      expect(a.core.isCompacting).toBe(false)
    } finally {
      globalThis.fetch = previousFetch
    }
  }, 30_000)
})
