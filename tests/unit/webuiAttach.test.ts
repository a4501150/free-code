import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'crypto'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { createConnection, type Socket } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { PassThrough } from 'stream'
import { readAttachDescriptor } from '../../src/server/descriptor.js'
import { startAttachHost } from '../../src/server/attachHost.js'
import {
  readNdjsonSocket,
  writeNdjson,
} from '../../src/webui/gateway/ndjsonConnection.js'
import {
  getAttachDescriptorPath,
  getAttachDir,
  verifyAttachDir,
} from '../../src/server/security.js'
import {
  ATTACH_PROTOCOL_VERSION,
  MAX_ATTACH_LINE_BYTES,
  type AttachEventBody,
  type WebTaskSummary,
} from '../../src/webui/protocol/attachSchemas.js'
import { StopTaskError } from '../../src/tasks/stopTask.js'
import { applyEvent, emptyView } from '../../src/session/viewStore.js'
import { renderTaskNotificationBlock } from '../../src/utils/task/notification.js'
import {
  toWireSnapshot,
  type WebTranscriptItem,
} from '../../src/webui/protocol/transcriptWire.js'
import type { Message } from '../../src/types/message.js'
import type { UUID } from 'crypto'

let configDir: string
let previousConfigDir: string | undefined

beforeEach(() => {
  previousConfigDir = process.env.FREECODE_CONFIG_DIR
  configDir = mkdtempSync(join(tmpdir(), 'webui-attach-'))
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

describe('ndjson framing', () => {
  function collect(): {
    socket: PassThrough
    lines: string[]
    errors: string[]
  } {
    const socket = new PassThrough()
    const lines: string[] = []
    const errors: string[] = []
    readNdjsonSocket(socket as unknown as Socket, {
      onLine: line => lines.push(line),
      onError: code => errors.push(code),
      onClose: () => {},
    })
    return { socket, lines, errors }
  }

  test('reassembles a line split across chunks', () => {
    const { socket, lines } = collect()
    socket.write('{"a":')
    socket.write('1}\n')
    expect(lines).toEqual(['{"a":1}'])
  })

  test('splits several lines delivered in one chunk', () => {
    const { socket, lines } = collect()
    socket.write('{"a":1}\n{"b":2}\n')
    expect(lines).toEqual(['{"a":1}', '{"b":2}'])
  })

  test('ignores blank lines', () => {
    const { socket, lines } = collect()
    socket.write('\n\n{"a":1}\n')
    expect(lines).toEqual(['{"a":1}'])
  })

  test('fails a line over the size limit instead of buffering it', () => {
    const { socket, lines, errors } = collect()
    socket.write('x'.repeat(MAX_ATTACH_LINE_BYTES + 1))
    expect(errors).toEqual(['line_too_long'])
    expect(lines).toEqual([])
  })
})

describe('attach descriptor validation', () => {
  test('accepts the descriptor written by a live host', async () => {
    const host = startAttachHost({
      sessionId: randomUUID(),
      cwd: process.cwd(),
    })
    expect(host).not.toBeNull()
    await host!.ready

    const result = readAttachDescriptor(process.pid)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.descriptor.pid).toBe(process.pid)
      expect(result.descriptor.attachToken.length).toBeGreaterThanOrEqual(16)
    }
    host!.stop()
  })

  test('rejects a descriptor whose body pid disagrees with its filename', async () => {
    const host = startAttachHost({
      sessionId: randomUUID(),
      cwd: process.cwd(),
    })
    await host!.ready

    const path = getAttachDescriptorPath(process.pid)
    const descriptor = JSON.parse(readFileSync(path, 'utf-8'))
    writeFileSync(path, JSON.stringify({ ...descriptor, pid: 999999 }), {
      mode: 0o600,
    })

    const result = readAttachDescriptor(process.pid)
    expect(result.ok).toBe(false)
    host!.stop()
  })

  test('rejects a world-readable descriptor', async () => {
    const host = startAttachHost({
      sessionId: randomUUID(),
      cwd: process.cwd(),
    })
    await host!.ready

    chmodSync(getAttachDescriptorPath(process.pid), 0o644)

    const result = readAttachDescriptor(process.pid)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('mode')
    host!.stop()
  })

  test('rejects a descriptor with no matching socket', () => {
    const dir = getAttachDir()
    rmSync(dir, { recursive: true, force: true })
    const result = readAttachDescriptor(process.pid)
    expect(result.ok).toBe(false)
  })
})

describe('attach host lifecycle', () => {
  test('creates the attach directory owner-only', async () => {
    const host = startAttachHost({
      sessionId: randomUUID(),
      cwd: process.cwd(),
    })
    await host!.ready
    expect(verifyAttachDir().ok).toBe(true)
    host!.stop()
  })

  test('removes its socket and descriptor on stop', async () => {
    const host = startAttachHost({
      sessionId: randomUUID(),
      cwd: process.cwd(),
    })
    await host!.ready
    host!.stop()
    expect(readAttachDescriptor(process.pid).ok).toBe(false)
  })

  test('keeps the socket path and bumps the epoch across a session switch', async () => {
    const host = startAttachHost({
      sessionId: randomUUID(),
      cwd: process.cwd(),
    })
    await host!.ready
    const originalPath = host!.descriptor.socketPath

    const next = randomUUID()
    host!.setSessionId(next)

    expect(host!.descriptor.socketPath).toBe(originalPath)
    expect(host!.descriptor.sessionId).toBe(next)
    const reread = readAttachDescriptor(process.pid)
    expect(reread.ok && reread.descriptor.sessionId).toBe(next)
    host!.stop()
  })

  test('reports no subscribers until a client authenticates', async () => {
    const host = startAttachHost({
      sessionId: randomUUID(),
      cwd: process.cwd(),
    })
    await host!.ready
    expect(host!.hasSubscribers).toBe(false)
    host!.stop()
  })
})

describe('idle cost', () => {
  test('does no transcript work while nothing is subscribed', async () => {
    const host = startAttachHost({
      sessionId: randomUUID(),
      cwd: process.cwd(),
    })
    await host!.ready

    let getMessagesCalls = 0
    host!.registerRuntime({
      getMessages: () => {
        getMessagesCalls += 1
        return []
      },
      getState: () => 'idle',
      getActivity: () => undefined,
      getModel: () => 'm',
      getPermissionMode: () => 'default',
      getTodos: () => [],
      getCommands: () => [],
      getPendingCommands: () => [],
      getIsCompacting: () => false,
      getInProgressToolUseIds: () => new Set(),
      getTasks: () => [],
      getTaskTranscript: async () => null,
      killTask: async () => {},
      submit: () => {},
      interrupt: () => {},
      setPermissionMode: () => {},
      setModel: () => {},
    })

    // This runs on every transcript mutation in every interactive process, so
    // an unattached session must not pay to serialize anything.
    for (let i = 0; i < 100; i++) host!.publishTranscript()
    expect(getMessagesCalls).toBe(0)

    host!.stop()
  })

  test('unrefs its listener so it cannot hold a finished process open', async () => {
    // A referenced listener would keep a headless run alive after its work
    // finished, so assert it for real: a process whose only remaining handle is
    // the attach socket must exit on its own.
    const script = `
      import { startAttachHost } from '${join(import.meta.dir, '..', '..', 'src/server/attachHost.ts')}'
      const host = startAttachHost({ sessionId: crypto.randomUUID(), cwd: process.cwd() })
      await host.ready
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
      throw new Error('the attach listener kept the process alive')
    }
    expect(exited).toBe(0)
  })
})

describe('attach handshake', () => {
  async function handshake(
    tokenFor: (attachToken: string) => string,
  ): Promise<{ ok?: boolean; result?: unknown; error?: { code: string } }> {
    const host = startAttachHost({
      sessionId: randomUUID(),
      cwd: process.cwd(),
    })
    await host!.ready

    try {
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out')), 5000)
        const client = createConnection(host!.descriptor.socketPath, () => {
          writeNdjson(client, {
            type: 'request',
            requestId: '1',
            request: {
              kind: 'hello',
              token: tokenFor(host!.descriptor.attachToken),
              protocolVersion: ATTACH_PROTOCOL_VERSION,
            },
          })
        })
        readNdjsonSocket(client, {
          onLine: line => {
            clearTimeout(timer)
            client.destroy()
            resolve(JSON.parse(line))
          },
          onError: (_code, message) => {
            clearTimeout(timer)
            reject(new Error(message))
          },
          onClose: () => {},
        })
      })
    } finally {
      host!.stop()
    }
  }

  test('accepts the token from the descriptor', async () => {
    const response = await handshake(token => token)
    expect(response.ok).toBe(true)
    expect(response.result).toMatchObject({ pid: process.pid, sessionEpoch: 0 })
  })

  test('rejects a wrong token', async () => {
    const response = await handshake(() => 'not-the-token')
    expect(response.ok).toBe(false)
    expect(response.error?.code).toBe('unauthorized')
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

  /** Opens a host, authenticates, and returns a request/response function. */
  async function connect(): Promise<{
    ask: (request: unknown) => Promise<{
      ok?: boolean
      result?: unknown
      error?: { code: string }
    }>
    submitted: Array<{ content: string; images?: unknown }>
    close: () => void
  }> {
    const host = startAttachHost({
      sessionId: randomUUID(),
      cwd: process.cwd(),
    })
    await host!.ready

    const submitted: Array<{ content: string; images?: unknown }> = []
    host!.registerRuntime({
      getMessages: () => messages(),
      getState: () => 'idle',
      getActivity: () => undefined,
      getModel: () => 'm',
      getPermissionMode: () => 'default',
      getTodos: () => [],
      getCommands: () => [],
      getPendingCommands: () => [],
      getIsCompacting: () => false,
      getInProgressToolUseIds: () => new Set(),
      getTasks: () => [],
      getTaskTranscript: async () => null,
      killTask: async () => {},
      submit: (content, _delivery, _commandId, images) => {
        submitted.push({ content, images })
      },
      interrupt: () => {},
      setPermissionMode: () => {},
      setModel: () => {},
    })

    const pending = new Map<string, (value: never) => void>()
    const client = createConnection(host!.descriptor.socketPath)
    readNdjsonSocket(client, {
      onLine: line => {
        const message = JSON.parse(line) as { requestId?: string }
        const settle = message.requestId && pending.get(message.requestId)
        if (settle) settle(message as never)
      },
      onError: () => {},
      onClose: () => {},
    })

    let id = 0
    const ask = (request: unknown): Promise<never> =>
      new Promise(resolve => {
        id += 1
        pending.set(String(id), resolve)
        writeNdjson(client, { type: 'request', requestId: String(id), request })
      })

    await ask({
      kind: 'hello',
      token: host!.descriptor.attachToken,
      protocolVersion: ATTACH_PROTOCOL_VERSION,
    })

    return {
      ask,
      submitted,
      close: () => {
        client.destroy()
        host!.stop()
      },
    }
  }

  test('passes uploaded images to the runtime', async () => {
    const session = await connect()
    try {
      const response = await session.ask({
        kind: 'submit',
        commandId: 'c1',
        content: 'look',
        images: [{ mediaType: 'image/png', data: PIXEL }],
        delivery: 'next',
        sessionEpoch: 0,
      })
      expect(response.ok).toBe(true)
      expect(session.submitted).toHaveLength(1)
      expect(session.submitted[0]!.images).toHaveLength(1)
    } finally {
      session.close()
    }
  })

  test('accepts a prompt that is only images', async () => {
    const session = await connect()
    try {
      const response = await session.ask({
        kind: 'submit',
        commandId: 'c1',
        content: '',
        images: [{ mediaType: 'image/png', data: PIXEL }],
        delivery: 'next',
        sessionEpoch: 0,
      })
      expect(response.ok).toBe(true)
    } finally {
      session.close()
    }
  })

  test('refuses a submit with neither text nor images', async () => {
    // The schema cannot state "one of these two", so the host has to.
    const session = await connect()
    try {
      const response = await session.ask({
        kind: 'submit',
        commandId: 'c1',
        content: '',
        delivery: 'next',
        sessionEpoch: 0,
      })
      expect(response.ok).toBe(false)
      expect(response.error?.code).toBe('empty_submit')
      expect(session.submitted).toHaveLength(0)
    } finally {
      session.close()
    }
  })

  test('answers get_image with the bytes for that block', async () => {
    const session = await connect()
    try {
      const response = await session.ask({
        kind: 'get_image',
        itemId: `${IMAGE_UUID}:0`,
      })
      expect(response.ok).toBe(true)
      expect(response.result).toEqual({
        mediaType: 'image/png',
        data: PIXEL,
      })
    } finally {
      session.close()
    }
  })

  test('refuses an item id that is not an image', async () => {
    const session = await connect()
    try {
      // Block 1 of that message is the text block.
      const text = await session.ask({
        kind: 'get_image',
        itemId: `${IMAGE_UUID}:1`,
      })
      expect(text.error?.code).toBe('no_such_image')

      const missing = await session.ask({
        kind: 'get_image',
        itemId: '99999999-9999-9999-9999-999999999999:0',
      })
      expect(missing.error?.code).toBe('no_such_image')

      const malformed = await session.ask({
        kind: 'get_image',
        itemId: 'nonsense',
      })
      expect(malformed.error?.code).toBe('no_such_image')
    } finally {
      session.close()
    }
  })
})

describe('background task panel', () => {
  const AGENT_UUID = '55555555-5555-5555-5555-555555555555'

  function agentTask(overrides: Partial<WebTaskSummary> = {}): WebTaskSummary {
    return {
      id: 'a123',
      taskType: 'local_agent',
      status: 'running',
      description: 'read the wiring docs',
      name: 'reader',
      agentType: 'general-purpose',
      startTime: Date.now() - 1000,
      toolUseCount: 2,
      ...overrides,
    }
  }

  function agentMessage(text: string): Message[] {
    return [
      {
        type: 'user',
        uuid: AGENT_UUID as UUID,
        timestamp: new Date().toISOString(),
        isSidechain: true,
        agentId: 'a123',
        message: { role: 'user', content: text },
      } as unknown as Message,
    ]
  }

  /**
   * Host + authenticated, subscribed client with a captured event stream and
   * a mutable task list behind the runtime seam.
   */
  async function taskSession(options: {
    tasks: WebTaskSummary[]
    /** When set, kill_task rejects with this StopTaskError code. */
    killFailsWith?: 'not_found' | 'not_running' | 'unsupported_type'
    killThrows?: boolean
  }): Promise<{
    events: Array<{ seq: number; event: AttachEventBody }>
    ask: (request: unknown) => Promise<{
      ok?: boolean
      result?: unknown
      error?: { code: string }
    }>
    killed: () => string[]
    publishTasks: () => void
    close: () => void
  }> {
    const host = startAttachHost({
      sessionId: randomUUID(),
      cwd: process.cwd(),
    })
    await host!.ready

    const killed: string[] = []
    host!.registerRuntime({
      getMessages: () => [],
      getState: () => 'idle',
      getActivity: () => undefined,
      getModel: () => 'm',
      getPermissionMode: () => 'default',
      getTodos: () => [],
      getCommands: () => [],
      getPendingCommands: () => [],
      getIsCompacting: () => false,
      getInProgressToolUseIds: () => new Set(),
      getTasks: () => options.tasks,
      getTaskTranscript: async () => ({ messages: agentMessage('working') }),
      killTask: async taskId => {
        killed.push(taskId)
        if (options.killFailsWith) {
          throw new StopTaskError('cannot stop', options.killFailsWith)
        }
      },
      submit: () => {},
      interrupt: () => {},
      setPermissionMode: () => {},
      setModel: () => {},
    })

    const events: Array<{ seq: number; event: AttachEventBody }> = []
    const pending = new Map<string, (value: never) => void>()
    const client = createConnection(host!.descriptor.socketPath)
    readNdjsonSocket(client, {
      onLine: line => {
        const message = JSON.parse(line) as {
          type?: string
          seq?: number
          event?: AttachEventBody
          requestId?: string
        }
        if (message.type === 'event' && message.event) {
          events.push({ seq: message.seq ?? 0, event: message.event })
          return
        }
        const settle = message.requestId && pending.get(message.requestId)
        if (settle) settle(message as never)
      },
      onError: () => {},
      onClose: () => {},
    })

    let id = 0
    const ask = (request: unknown): Promise<never> =>
      new Promise(resolve => {
        id += 1
        pending.set(String(id), resolve)
        writeNdjson(client, { type: 'request', requestId: String(id), request })
      })

    await ask({
      kind: 'hello',
      token: host!.descriptor.attachToken,
      protocolVersion: ATTACH_PROTOCOL_VERSION,
    })
    await ask({ kind: 'subscribe' })

    return {
      events,
      ask,
      killed: () => killed,
      publishTasks: () => host!.publishTasks(),
      close: () => {
        client.destroy()
        host!.stop()
      },
    }
  }

  test('carries the task list on the snapshot and answers list_tasks', async () => {
    const tasks = [agentTask()]
    const session = await taskSession({ tasks })
    try {
      const snapshot = session.events.find(
        frame => frame.event.kind === 'snapshot',
      )?.event
      expect(snapshot?.kind).toBe('snapshot')
      expect((snapshot as { tasks?: WebTaskSummary[] }).tasks).toEqual(tasks)

      const response = await session.ask({ kind: 'list_tasks' })
      expect(response.ok).toBe(true)
      expect((response.result as { tasks: WebTaskSummary[] }).tasks).toEqual(
        tasks,
      )
    } finally {
      session.close()
    }
  })

  test('publishes a tasks event only when the list changed', async () => {
    const tasks: WebTaskSummary[] = []
    const session = await taskSession({ tasks })
    try {
      session.publishTasks()
      const countAfterEmpty = session.events.filter(
        frame => frame.event.kind === 'tasks',
      ).length

      tasks.push(agentTask())
      session.publishTasks()
      tasks.push(agentTask({ id: 'a999', name: undefined }))
      session.publishTasks()
      // The frames travel over a socket; give the client a tick to read them.
      await Bun.sleep(50)

      const taskEvents = session.events.filter(
        frame => frame.event.kind === 'tasks',
      )
      // The empty publish rode the snapshot watermark and re-sent nothing new:
      // one event per distinct payload, and the empty one is not counted
      // because the snapshot already carried it.
      expect(taskEvents.length - countAfterEmpty).toBeLessThanOrEqual(2)
      const last = taskEvents[taskEvents.length - 1]?.event
      expect(last?.kind).toBe('tasks')
      expect((last as { tasks: WebTaskSummary[] }).tasks).toHaveLength(2)
    } finally {
      session.close()
    }
  })

  test('kill_task routes through the runtime and maps its errors', async () => {
    const stopped = await taskSession({ tasks: [agentTask()] })
    try {
      const response = await stopped.ask({ kind: 'kill_task', taskId: 'a123' })
      expect(response.ok).toBe(true)
      expect(stopped.killed()).toEqual(['a123'])
    } finally {
      stopped.close()
    }

    const failed = await taskSession({
      tasks: [agentTask({ status: 'completed' })],
      killFailsWith: 'not_running',
    })
    try {
      const response = await failed.ask({ kind: 'kill_task', taskId: 'a123' })
      expect(response.ok).toBe(false)
      expect(response.error?.code).toBe('not_running')
    } finally {
      failed.close()
    }
  })

  test('get_task_transcript answers with wire items and the terminal flag', async () => {
    const session = await taskSession({ tasks: [agentTask()] })
    try {
      const response = await session.ask({
        kind: 'get_task_transcript',
        taskId: 'a123',
      })
      expect(response.ok).toBe(true)
      const body = response.result as { items: unknown[]; done: boolean }
      expect(body.items.length).toBeGreaterThan(0)
      expect(body.done).toBe(false)

      const missing = await session.ask({
        kind: 'get_task_transcript',
        taskId: 'nope',
      })
      expect(missing.ok).toBe(false)
      expect(missing.error?.code).toBe('no_such_task')
    } finally {
      session.close()
    }
  })

  test('subscribe_task answers with a full replace, and the poll adds nothing stale', async () => {
    const session = await taskSession({ tasks: [agentTask()] })
    try {
      const response = await session.ask({
        kind: 'subscribe_task',
        taskId: 'a123',
      })
      expect(response.ok).toBe(true)

      // The first frame is the baseline replace, delivered with the subscribe
      // answer. Later ticks diff against that baseline, so an unchanged
      // transcript must not re-send the rows the client already seeded.
      await Bun.sleep(100)
      const streamed = session.events.filter(
        frame => frame.event.kind === 'task_transcript',
      )
      expect(streamed).toHaveLength(1)
      const first = streamed[0]!.event as {
        taskId: string
        patch: { type: string; snapshot?: { items: Array<{ text?: string }> } }
      }
      expect(first.taskId).toBe('a123')
      expect(first.patch.type).toBe('replace')
      expect(
        (first.patch.snapshot?.items ?? []).some(
          item => item.text === 'working',
        ),
      ).toBe(true)

      await session.ask({ kind: 'unsubscribe_task', taskId: 'a123' })
      const after = session.events.length
      // Two poll ticks after unsubscribing: the timer must be gone.
      await Bun.sleep(1500)
      expect(
        session.events
          .slice(after)
          .filter(frame => frame.event.kind === 'task_transcript'),
      ).toHaveLength(0)
    } finally {
      session.close()
    }
  })

  test('the seed-to-subscribe handoff re-appends no seeded ids', async () => {
    const session = await taskSession({ tasks: [agentTask()] })
    try {
      // The browser's exact sequence: read the seed first, subscribe second.
      const seed = await session.ask({
        kind: 'get_task_transcript',
        taskId: 'a123',
      })
      expect(seed.ok).toBe(true)
      const items = (seed.result as { items: WebTranscriptItem[] }).items
      expect(items.length).toBeGreaterThan(0)

      await session.ask({ kind: 'subscribe_task', taskId: 'a123' })
      await Bun.sleep(100)

      // Replay the client's routing: seed the view at the watermark it had,
      // then feed every task patch through the same reducer the browser uses.
      let view = applyEvent(emptyView(), Math.max(1, session.events[0]!.seq), {
        kind: 'transcript',
        patch: {
          type: 'replace',
          snapshot: { items, order: items.map(item => item.id) },
        },
      })
      for (const frame of session.events) {
        const event = frame.event
        if (event.kind === 'task_transcript' && event.taskId === 'a123') {
          view = applyEvent(view, frame.seq, {
            kind: 'transcript',
            patch: event.patch,
          })
        }
      }
      // No duplicated ids in the order: that is what rendered every row twice
      // and tripped React's duplicate-key warning.
      expect(view.order.length).toBe(new Set(view.order).size)
      expect(view.order).toEqual(items.map(item => item.id))
    } finally {
      session.close()
    }
  })

  test('an orderAppend cannot duplicate an id already in the order', () => {
    // The reducer's defensive path, independent of any host version: a stale
    // host whose baseline starts empty would append every seeded id.
    const item: WebTranscriptItem = {
      id: `${AGENT_UUID}:0`,
      kind: 'user',
      rev: '1',
      timestamp: new Date().toISOString(),
      text: 'working',
    }
    let view = applyEvent(emptyView(), 1, {
      kind: 'transcript',
      patch: {
        type: 'replace',
        snapshot: { items: [item], order: [item.id] },
      },
    })
    view = applyEvent(view, 2, {
      kind: 'transcript',
      patch: {
        type: 'delta',
        upsert: [item],
        remove: [],
        orderAppend: [item.id],
      },
    })
    expect(view.order).toEqual([item.id])
  })
})

describe('task notification cards', () => {
  function noticeMessage(text: string, withOrigin: boolean): Message {
    return {
      type: 'user',
      uuid: randomUUID() as UUID,
      timestamp: new Date().toISOString(),
      ...(withOrigin ? { origin: { kind: 'task-notification' as const } } : {}),
      message: { role: 'user', content: text },
    } as unknown as Message
  }

  function notificationItem(items: WebTranscriptItem[]): WebTranscriptItem {
    const item = items.find(candidate => candidate.kind === 'notification')
    expect(item).toBeDefined()
    return item!
  }

  test('an idle-drain agent notice becomes a structured card item', () => {
    const block = renderTaskNotificationBlock({
      taskId: 'a1',
      summary: 'Background agent "reader" finished',
      status: 'completed',
      toolUseId: 'toolu_1',
      extraSections:
        '\n<result>the wiring is parallel</result>\n<usage><total_tokens>1234</total_tokens><tool_uses>3</tool_uses><duration_ms>45000</duration_ms></usage>',
    })
    const snapshot = toWireSnapshot([noticeMessage(block, true)])

    const item = notificationItem(snapshot.items)
    expect(item.notification).toEqual({
      taskId: 'a1',
      toolUseId: 'toolu_1',
      status: 'completed',
      summary: 'Background agent "reader" finished',
      result: 'the wiring is parallel',
      usage: { totalTokens: 1234, toolUses: 3, durationMs: 45000 },
    })
    // No raw-XML user bubble remains anywhere.
    expect(snapshot.items.every(i => i.kind !== 'user')).toBe(true)
    expect(JSON.stringify(snapshot.items)).not.toContain('task-notification')
  })

  test('classification keys off the block shape when origin is absent', () => {
    const block = renderTaskNotificationBlock({
      taskId: 'a2',
      summary: 'Background agent "old" finished',
      status: 'killed',
    })
    const snapshot = toWireSnapshot([noticeMessage(block, false)])
    const item = notificationItem(snapshot.items)
    expect(item.notification?.taskId).toBe('a2')
    expect(item.notification?.status).toBe('killed')
  })

  test('a monitor notice parses its output and drops the trailing prose', () => {
    const block =
      renderTaskNotificationBlock({
        taskId: 'm1',
        summary: 'Background monitor "logs" produced new output',
        taskType: 'monitor',
        extraSections:
          '\n<monitor-output>\n  first line\n  second line\n</monitor-output>',
      }) +
      '\nOne or more background monitors produced new output since the last turn. Review the output and react if relevant.'
    const snapshot = toWireSnapshot([noticeMessage(block, true)])

    const item = notificationItem(snapshot.items)
    expect(item.notification?.taskType).toBe('monitor')
    expect(item.notification?.status).toBeUndefined()
    expect(item.notification?.outputTail).toContain('first line')
    const wire = JSON.stringify(snapshot.items)
    expect(wire).not.toContain('react if relevant')
    expect(wire).not.toContain('task-notification')
  })

  test('a progress ping parses without a status', () => {
    const block = renderTaskNotificationBlock({
      taskId: 'a3',
      summary: 'Background agent "worker" is still running',
    })
    const snapshot = toWireSnapshot([noticeMessage(block, true)])
    const item = notificationItem(snapshot.items)
    expect(item.notification?.taskId).toBe('a3')
    expect(item.notification?.status).toBeUndefined()
    expect(item.notification?.summary).toBe(
      'Background agent "worker" is still running',
    )
  })

  test('a mid-turn drain parses behind the reminder wrapper and prose', () => {
    const block = renderTaskNotificationBlock({
      taskId: 'a4',
      summary: 'Background agent "mid" finished',
      status: 'failed',
    })
    // The shape normalizeAttachmentForAPI puts on the request path: prose
    // prefix from wrapCommandText inside the system-reminder wrapper.
    const wrapped = `<system-reminder>\nA background agent completed a task:\n${block}\n</system-reminder>`
    const attachmentMessage = {
      type: 'attachment',
      uuid: randomUUID() as UUID,
      timestamp: new Date().toISOString(),
      attachment: {
        type: 'queued_command',
        prompt: wrapped,
        commandMode: 'task-notification',
        isMeta: true,
      },
    } as unknown as Message

    const snapshot = toWireSnapshot([attachmentMessage])
    const item = notificationItem(snapshot.items)
    expect(item.notification?.taskId).toBe('a4')
    expect(item.notification?.status).toBe('failed')
    expect(item.isMeta).toBe(true)
    const wire = JSON.stringify(snapshot.items)
    expect(wire).not.toContain('A background agent completed a task')
    expect(wire).not.toContain('task-notification')
  })

  test('an unparsable stamped notice falls back to raw text, not the bubble', () => {
    const message = noticeMessage('<task-notification>broken', true)
    const snapshot = toWireSnapshot([message])
    const item = notificationItem(snapshot.items)
    expect(item.notification?.raw).toContain('<task-notification>broken')
    expect(item.notification?.summary).toBe('')
    expect(snapshot.items.every(i => i.kind !== 'user')).toBe(true)
  })
})
