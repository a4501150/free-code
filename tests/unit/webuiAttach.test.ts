import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'crypto'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { createConnection, type Socket } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { PassThrough } from 'stream'
import { readAttachDescriptor } from '../../src/webui/attach/attachDescriptor.js'
import { startAttachHost } from '../../src/webui/attach/attachHost.js'
import {
  attachNdjsonReader,
  writeNdjson,
} from '../../src/webui/attach/ndjsonConnection.js'
import {
  getAttachDescriptorPath,
  getAttachDir,
  verifyAttachDir,
} from '../../src/webui/attach/security.js'
import {
  ATTACH_PROTOCOL_VERSION,
  MAX_ATTACH_LINE_BYTES,
} from '../../src/webui/protocol/attachSchemas.js'
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
    attachNdjsonReader(socket as unknown as Socket, {
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
      import { startAttachHost } from '${join(import.meta.dir, '..', '..', 'src/webui/attach/attachHost.ts')}'
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
        attachNdjsonReader(client, {
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
      submit: (content, _delivery, _commandId, images) => {
        submitted.push({ content, images })
      },
      interrupt: () => {},
      setPermissionMode: () => {},
      setModel: () => {},
    })

    const pending = new Map<string, (value: never) => void>()
    const client = createConnection(host!.descriptor.socketPath)
    attachNdjsonReader(client, {
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
