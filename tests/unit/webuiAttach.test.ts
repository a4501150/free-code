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
