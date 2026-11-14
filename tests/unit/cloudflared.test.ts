import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'events'
import { PassThrough } from 'stream'
import type { ChildProcess } from 'child_process'
import type { WriteStream } from 'fs'
import {
  runCloudflared,
  type CloudflaredDeps,
  type CloudflaredReadiness,
} from '../../src/webui/tunnel/cloudflared.js'
import type { TunnelStartOptions } from '../../src/webui/tunnel/types.js'

function fakeChild(): ChildProcess {
  const child = new EventEmitter() as unknown as ChildProcess
  ;(child as { stdout: PassThrough }).stdout = new PassThrough()
  ;(child as { stderr: PassThrough }).stderr = new PassThrough()
  ;(child as { kill: (sig?: string) => boolean }).kill = () => true
  return child
}

function deps(child: ChildProcess, log: PassThrough | null): CloudflaredDeps {
  return {
    resolveBinary: async () => '/bin/fake',
    spawnProcess: () => child,
    startupTimeoutMs: 5000,
    openLog: () => log as unknown as WriteStream | null,
  }
}

const readiness: CloudflaredReadiness = {
  urlPattern: null,
  publicUrl: () => 'https://fixed.example.com',
}

function emitRegistered(child: ChildProcess): void {
  child.stderr!.emit(
    'data',
    Buffer.from('INF Registered tunnel connection connIndex=0 ip=1.2.3.4\n'),
  )
}

// Let the async setup (resolveBinary) complete and subscribe to the child's
// data events before we emit anything.
const tick = () => Bun.sleep(10)

function start(child: ChildProcess, log: PassThrough | null) {
  const options: TunnelStartOptions = {
    port: 1,
    signal: new AbortController().signal,
  }
  return runCloudflared(deps(child, log), ['run'], options, readiness)
}

describe('runCloudflared lifetime logging', () => {
  test('drains output into the log sink after startup', async () => {
    const child = fakeChild()
    const log = new PassThrough()
    const chunks: string[] = []
    log.on('data', (d: Buffer) => chunks.push(d.toString('utf-8')))

    const ready = start(child, log)
    await tick()

    emitRegistered(child)
    const handle = await ready
    // Post-startup output still reaches the log sink.
    child.stderr!.emit('data', Buffer.from('ERR Connection terminated\n'))
    await tick()

    const written = chunks.join('')
    expect(written).toContain('Registered tunnel connection')
    expect(written).toContain('Connection terminated')
    expect(written).toContain('cloudflared started')
    expect(written).not.toContain('/bin/fake')
    await handle.close()
  })

  test('whenExited reports an unexpected exit after ready', async () => {
    const child = fakeChild()
    const ready = start(child, null)
    await tick()
    emitRegistered(child)
    const handle = await ready

    child.emit('exit', 1, null)
    expect(await handle.whenExited).toMatch(/exited \(code 1\)/)
  })

  test('whenExited resolves null after a deliberate close', async () => {
    const child = fakeChild()
    const ready = start(child, null)
    await tick()
    emitRegistered(child)
    const handle = await ready

    await handle.close()
    child.emit('exit', null, 'SIGTERM')
    expect(await handle.whenExited).toBeNull()
  })
})
