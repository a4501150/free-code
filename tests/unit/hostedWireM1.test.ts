/**
 * M1 of the TUI cutover backend: the streaming preview over the channel,
 * notify passthrough, hosted interrupt abort, and the rewind/resume rpcs.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createServer } from 'node:http'
import { randomUUID } from 'crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { UUID } from 'crypto'
import {
  createHostedSession,
  type HostedSession,
} from '../../src/sessiond/hosted.js'
import { SURFACE_TOKEN_HEADER } from '../../src/server/surface.js'
import {
  createSessionChannel,
  type SessionChannel,
} from '../../src/server/channel.js'
import type { SessionRuntime } from '../../src/server/runtime.js'
import type { SessionEvent } from '../../src/session/events.js'
import { getCwdState, runInSessionScope } from '../../src/bootstrap/state.js'
import { getProjectDir } from '../../src/utils/sessionStorage.js'
import {
  enqueue,
  getCommandQueueSnapshot,
} from '../../src/utils/messageQueueManager.js'
import type { Message } from '../../src/types/message.js'
import type { WireEventEnvelope } from '../../src/session/wire.js'
import { applyEvent, emptyView } from '../../src/session/viewStore.js'
import { assembleSessionDefaults } from '../../src/sessiond/sessionDefaults.js'
import { createSessionRegistry } from '../../src/sessiond/registry.js'

let configDir: string
let previousConfigDir: string | undefined
let previousApiKey: string | undefined

beforeEach(() => {
  previousConfigDir = process.env.FREECODE_CONFIG_DIR
  configDir = mkdtempSync(join(tmpdir(), 'wire-m1-'))
  process.env.FREECODE_CONFIG_DIR = configDir
  previousApiKey = process.env.ANTHROPIC_API_KEY
  process.env.ANTHROPIC_API_KEY = 'test-key-wire-m1'
})

afterEach(() => {
  if (previousApiKey === undefined) delete process.env.ANTHROPIC_API_KEY
  else process.env.ANTHROPIC_API_KEY = previousApiKey
  if (previousConfigDir === undefined) delete process.env.FREECODE_CONFIG_DIR
  else process.env.FREECODE_CONFIG_DIR = previousConfigDir
  rmSync(configDir, { recursive: true, force: true })
})

async function mount(
  channel: SessionChannel,
  token: string,
): Promise<{ url: string; close: () => void }> {
  const server = createServer((request, res) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const parts = url.pathname.split('/').filter(Boolean)
    if (parts[2] !== channel.sessionId) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: { code: 'unknown_session' } }))
      return
    }
    if (request.headers[SURFACE_TOKEN_HEADER] !== token) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: { code: 'unauthorized' } }))
      return
    }
    if (request.method === 'GET') {
      channel.handleGet(request, res, parts[3]!, [parts[4] ?? ''], url)
      return
    }
    void channel.handlePost(request, res, parts[3]!)
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

function frameRecorder(response: Response): {
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

function userMessage(text: string): Message {
  return {
    type: 'user',
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    message: { role: 'user', content: text },
  } as unknown as Message
}

async function waitFor(cond: () => boolean, ms = 5000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (cond()) return true
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  return cond()
}

describe('stream draft over the channel', () => {
  let coreEmit: ((event: SessionEvent) => void) | null = null
  let messages: Message[] = []

  function fakeRuntime(): SessionRuntime {
    return {
      getMessages: () => messages,
      subscribeCore: cb => {
        coreEmit = cb
        return () => {
          coreEmit = null
        }
      },
      getState: () => 'idle',
      getActivity: () => undefined,
      getIsCompacting: () => false,
      getModel: () => 'test-model',
      getPermissionMode: () => undefined,
      getTodos: () => [],
      getTasks: () => [],
      getPendingCommands: () => [],
      getCatalog: () => ({
        models: [],
        commands: [],
        permissionModes: ['default'],
      }),
      getInProgressToolUseIds: () => new Set<string>(),
      submit: () => {},
      cancel: () => {},
      setModel: () => {},
      setMode: () => {},
    }
  }

  test('drafts coalesce, flush before the transcript patch, close on turn end', async () => {
    const channel = createSessionChannel({
      sessionId: randomUUID(),
      cwd: configDir,
      streamThrottleMs: 40,
    })
    channel.registerRuntime(fakeRuntime())
    const mounted = await mount(channel, 't')
    const stream = await fetch(
      `${mounted.url}/v1/sessions/${channel.sessionId}/events`,
      { headers: { [SURFACE_TOKEN_HEADER]: 't' } },
    )
    const recorder = frameRecorder(stream)
    const opened = await recorder.untilQuiet()
    expect(opened[0]?.event.kind).toBe('snapshot')

    coreEmit!({ type: 'turn_started' })
    coreEmit!({ type: 'streaming_text', text: 'Hel' })
    // First frame lands immediately (nothing emitted this turn yet).
    coreEmit!({ type: 'streaming_text', text: 'Hello' })
    coreEmit!({
      type: 'streaming_thinking',
      thinking: { thinking: 'pondering', isStreaming: true } as never,
    })
    // The committed row lands: the pending draft must flush FIRST, so the
    // client never sees the transcript without its preview's last word.
    messages = [userMessage('hi')]
    channel.publishTranscript()
    const flushed = await recorder.untilQuiet()
    const kinds = flushed.map(f => f.event.kind)
    const streamIdx = kinds.lastIndexOf('stream')
    const transcriptIdx = kinds.indexOf('transcript')
    expect(transcriptIdx).toBeGreaterThan(-1)
    expect(streamIdx).toBeGreaterThan(-1)
    expect(streamIdx).toBeLessThan(transcriptIdx)
    const lastDraft = flushed[streamIdx]!.event as {
      draft: { text?: string; thinking?: string }
    }
    expect(lastDraft.draft?.text).toBe('Hello')
    expect(lastDraft.draft?.thinking).toBe('pondering')

    // Coalescing: three drafts in a burst ride at most one immediate frame
    // plus one trailing frame that carries the latest cumulative value.
    coreEmit!({ type: 'streaming_text', text: 'A' })
    coreEmit!({ type: 'streaming_text', text: 'AB' })
    coreEmit!({ type: 'streaming_text', text: 'ABC' })
    const coalesced = await recorder.untilQuiet(80)
    const streamFrames = coalesced.filter(f => f.event.kind === 'stream')
    expect(streamFrames.length).toBeLessThanOrEqual(2)
    expect(
      (streamFrames.at(-1)!.event as { draft: { text?: string } }).draft.text,
    ).toBe('ABC')

    // Turn end closes the preview explicitly for clients that never saw a
    // transcript patch.
    coreEmit!({ type: 'turn_finished', aborted: false })
    const closed = await recorder.untilQuiet()
    const finalFrame = closed.filter(f => f.event.kind === 'stream').at(-1)
    expect(finalFrame).toBeDefined()
    expect((finalFrame!.event as { draft: unknown }).draft).toBeNull()

    channel.stop()
    mounted.close()
  })

  test('notify reaches subscribers as a wire event only while subscribed', async () => {
    const channel = createSessionChannel({
      sessionId: randomUUID(),
      cwd: configDir,
    })
    channel.publishNotify({ level: 'warn', text: 'before anyone listened' })
    channel.registerRuntime(fakeRuntime())
    const mounted = await mount(channel, 't')
    const stream = await fetch(
      `${mounted.url}/v1/sessions/${channel.sessionId}/events`,
      { headers: { [SURFACE_TOKEN_HEADER]: 't' } },
    )
    const recorder = frameRecorder(stream)
    await recorder.untilQuiet()
    channel.publishNotify({ level: 'error', text: 'provider degraded' })
    const frames = await recorder.untilQuiet()
    const notify = frames.find(f => f.event.kind === 'notify')
    expect(notify).toBeDefined()
    expect(
      (notify!.event as { notification: { text: string } }).notification,
    ).toEqual({ level: 'error', text: 'provider degraded' })
    channel.stop()
    mounted.close()
  })
})

describe('view store stream/notify semantics', () => {
  test('draft set by stream, cleared by transcript/snapshot/resync/session_changed', () => {
    const draft = { text: 'partial', tools: [] }
    let view = applyEvent(emptyView(), 1, { kind: 'stream', draft })
    expect(view.streamDraft).toEqual(draft)
    view = applyEvent(view, 2, {
      kind: 'transcript',
      patch: { type: 'delta', upsert: [], remove: [] },
    })
    expect(view.streamDraft).toBeNull()

    view = applyEvent(view, 3, { kind: 'stream', draft })
    view = applyEvent(view, 4, { kind: 'resync_required' })
    expect(view.streamDraft).toBeNull()

    view = applyEvent(view, 5, { kind: 'stream', draft })
    view = applyEvent(view, 6, {
      kind: 'session_changed',
      sessionId: 'x',
      sessionEpoch: 1,
    })
    expect(view.streamDraft).toBeNull()

    view = applyEvent(view, 7, { kind: 'stream', draft })
    view = applyEvent(view, 8, {
      kind: 'snapshot',
      meta: {
        sessionId: 'x',
        sessionEpoch: 1,
        cwd: '/',
        startedAt: 0,
        state: 'idle',
      },
      transcript: { items: [], order: [] },
      requests: [],
      todos: [],
      pendingCommands: [],
      tasks: [],
      catalog: { models: [], commands: [], permissionModes: [] },
    })
    expect(view.streamDraft).toBeNull()
  })

  test('notify keeps the last per level', () => {
    let view = applyEvent(emptyView(), 1, {
      kind: 'notify',
      notification: { level: 'info', text: 'one' },
    })
    view = applyEvent(view, 2, {
      kind: 'notify',
      notification: { level: 'info', text: 'two' },
    })
    view = applyEvent(view, 3, {
      kind: 'notify',
      notification: { level: 'warn', text: 'careful' },
    })
    expect(view.notifications.info?.text).toBe('two')
    expect(view.notifications.warn?.text).toBe('careful')
    expect(view.notifications.error).toBeUndefined()
  })
})

describe('hosted session M1 behaviours', () => {
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

  test('a now-priority command aborts the running turn once, then runs', async () => {
    // The unit runner has no bundler, so the build-time MACRO the provider
    // headers read is simply missing; stand it up for the turn path.
    ;(globalThis as Record<string, unknown>).MACRO ??= {
      VERSION: 'test',
      FEEDBACK_CHANNEL: 'test-channel',
    }
    // The first provider stream hangs: it only ends when the request's own
    // abort signal fires, so the interrupted turn is the only thing that can
    // end it. The steered command's own turn answers normally on either
    // wire shape.
    const previousFetch = globalThis.fetch
    let requestSignal: AbortSignal | undefined
    let providerCalls = 0
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = String(
        typeof input === 'object' && 'url' in input
          ? (input as { url: string }).url
          : input,
      )
      if (url.includes('count_tokens')) {
        return new Response(JSON.stringify({ input_tokens: 10 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url.includes('/v1/messages') || url.includes('/chat/completions')) {
        providerCalls += 1
        if (providerCalls > 1) {
          const chunk = (delta: unknown, finish: unknown) =>
            `data: ${JSON.stringify({
              id: 'chatcmpl-steer-1',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'mock',
              choices: [{ index: 0, delta, finish_reason: finish }],
            })}\n\n`
          return new Response(
            chunk({ role: 'assistant' }, null) +
              chunk({ content: 'ok' }, null) +
              chunk({}, 'stop') +
              'data: [DONE]\n\n',
            { status: 200, headers: { 'content-type': 'text/event-stream' } },
          )
        }
        requestSignal = init?.signal ?? undefined
        const stream = new ReadableStream({
          start(controller) {
            init?.signal?.addEventListener('abort', () => {
              try {
                controller.close()
              } catch {
                // already closed by the abort path itself
              }
            })
          },
        })
        return new Response(stream, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      }
      return previousFetch(input as never, init)
    }) as typeof globalThis.fetch
    try {
      const a = makeSession(join(configDir, 'interrupt'))
      // Sticky: the steered command's own turn finishes with aborted:false
      // the moment the interrupter is drained, so record only the
      // aborted announcement (last-one-wins would let it overwrite).
      let aborted = false
      a.core.subscribe(e => {
        if (e.type === 'turn_finished' && e.aborted) aborted = true
      })
      a.submit('long running thing')
      expect(await waitFor(() => a.queryGuard.isActive)).toBe(true)
      expect(await waitFor(() => requestSignal !== undefined)).toBe(true)
      expect(requestSignal!.aborted).toBe(false)

      const steerId = randomUUID()
      runInSessionScope(a.scope, () => {
        enqueue({
          mode: 'prompt',
          value: `/steer-${steerId}`,
          priority: 'now',
          uuid: steerId as UUID,
        })
      })
      // The abort reached the in-flight provider request...
      expect(await waitFor(() => requestSignal!.aborted)).toBe(true)
      // ...and the turn announced itself as aborted.
      expect(await waitFor(() => aborted === true)).toBe(true)
      // The steered command is drained and run next: the queue empties and
      // the loop goes idle again.
      const drained = await waitFor(
        () =>
          !a.queryGuard.isActive &&
          runInSessionScope(a.scope, () => getCommandQueueSnapshot()).length ===
            0,
        10_000,
      )
      expect(drained).toBe(true)
    } finally {
      globalThis.fetch = previousFetch
    }
  }, 30_000)

  test('rewind truncates before the target and rejects unknown ids', async () => {
    const a = makeSession(join(configDir, 'rewind'))
    const first = userMessage('first')
    const second = userMessage('second')
    a.core.replaceMessages([first, second], 'restore')
    const result = await a.runtime.rpc!('rewind', { toMessageId: second.uuid })
    expect(result).toEqual({ rewound: true })
    expect(a.core.getMessages().map(m => m.uuid)).toEqual([first.uuid])
    let message = ''
    try {
      await a.runtime.rpc!('rewind', { toMessageId: randomUUID() })
    } catch (err) {
      message = err instanceof Error ? err.message : String(err)
    }
    expect(message).toContain('no transcript message')
  })

  test('rewind refuses while a turn is running', async () => {
    const a = makeSession(join(configDir, 'rewind-busy'))
    a.core.replaceMessages([userMessage('only')], 'restore')
    const generation = a.queryGuard.tryStart()
    let message = ''
    try {
      await a.runtime.rpc!('rewind', { toMessageId: randomUUID() })
    } catch (err) {
      message = err instanceof Error ? err.message : String(err)
    }
    expect(message).toContain('turn is running')
    a.queryGuard.end(generation!)
  })

  test('resume loads the target transcript and adopts its identity', async () => {
    const a = makeSession(join(configDir, 'resume'))
    const targetId = randomUUID()
    const dir = runInSessionScope(a.scope, () => getProjectDir(getCwdState()))
    mkdirSync(dir, { recursive: true })
    const line = (text: string, uuid: string, parentUuid?: string) =>
      JSON.stringify({
        type: 'user',
        sessionId: targetId,
        uuid,
        ...(parentUuid ? { parentUuid } : {}),
        timestamp: new Date(1000).toISOString(),
        cwd: join(configDir, 'resume'),
        isSidechain: false,
        message: { role: 'user', content: text },
      }) + '\n'
    const u1 = randomUUID()
    const u2 = randomUUID()
    writeFileSync(
      join(dir, `${targetId}.jsonl`),
      line('older prompt', u1) + line('newest prompt', u2, u1),
    )

    const events: Array<{ kind: string; sessionId?: string }> = []
    a.core.subscribe(e => {
      if (e.type === 'transcript_replaced')
        events.push({ kind: e.reason ?? 'replaced' })
    })

    const result = (await a.runtime.rpc!('resume', {
      sessionId: targetId,
    })) as { sessionId: string }
    expect(result.sessionId).toBe(targetId)
    expect(a.channel.sessionId).toBe(targetId)
    const loaded = JSON.stringify(a.core.getMessages())
    expect(loaded).toContain('older prompt')
    expect(loaded).toContain('newest prompt')

    // A target with no transcript file answers, it does not half-switch.
    let message = ''
    try {
      await a.runtime.rpc!('resume', { sessionId: randomUUID() })
    } catch (err) {
      message = err instanceof Error ? err.message : String(err)
    }
    expect(message).toContain('no transcript')
  })

  test('resume with forkSession rotates to a fresh id', async () => {
    const a = makeSession(join(configDir, 'resume-fork'))
    const targetId = randomUUID()
    const dir = runInSessionScope(a.scope, () => getProjectDir(getCwdState()))
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, `${targetId}.jsonl`),
      JSON.stringify({
        type: 'user',
        sessionId: targetId,
        uuid: randomUUID(),
        timestamp: new Date(1000).toISOString(),
        cwd: join(configDir, 'resume-fork'),
        isSidechain: false,
        message: { role: 'user', content: 'seed prompt' },
      }) + '\n',
    )
    const result = (await a.runtime.rpc!('resume', {
      sessionId: targetId,
      forkSession: true,
    })) as { sessionId: string }
    expect(result.sessionId).not.toBe(targetId)
    expect(a.channel.sessionId).toBe(result.sessionId)
    expect(JSON.stringify(a.core.getMessages())).toContain('seed prompt')
  })

  test('session defaults carry the new flags to the hosted options', async () => {
    const cwd = join(configDir, 'defaults')
    mkdirSync(cwd, { recursive: true })
    const assembled = await assembleSessionDefaults(cwd, {
      allowedTools: ['Bash'],
      disallowedTools: ['Write'],
      thinkingConfig: { type: 'enabled', budget: 1000 } as never,
      settings: '{"env":{"FOO":"bar"}}',
    })
    expect(assembled.thinkingConfig).toEqual({ type: 'enabled', budget: 1000 })
    expect(assembled.settings).toBe('{"env":{"FOO":"bar"}}')
    expect(assembled.commands).toBeDefined()
    expect(assembled.tools?.length).toBeGreaterThan(0)

    // A pre-assembled pool skips reassembly and passes through untouched.
    const marker = { name: 'Marker' as const } as never
    const registry = createSessionRegistry()
    const entry = await registry.create({
      cwd,
      defaults: {
        commands: [],
        tools: [marker],
        thinkingConfig: { type: 'enabled', budget: 7 } as never,
        mcpClients: [],
        settings: 'overlay.json',
      },
    })
    expect(entry.hosted.options.thinkingConfig).toEqual({
      type: 'enabled',
      budget: 7,
    })
    expect(entry.hosted.options.mcpClients).toEqual([])
    expect(entry.hosted.options.settings).toBe('overlay.json')
    registry.stop(entry.processKey)
  })
})
